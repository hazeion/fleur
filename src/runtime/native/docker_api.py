"""Minimal bounded Docker Engine API client for the trusted retained controller.

Only fixed request shapes are used. Responses are size-bounded and parsed as
JSON; exec streams are demultiplexed without a TTY, so application bytes can
never be mistaken for stream headers.
"""
import json
import select
import socket
import struct
import time

SOCKET = '/var/run/docker.sock'
RESPONSE_LIMIT = 1024 * 1024
HEAD_LIMIT = 16385  # response head bytes, including the terminating blank line
TERMINATOR = b'\r\n\r\n'


class DockerError(RuntimeError):
    pass


def _connect(timeout):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(max(.001, timeout))
    connection.connect(SOCKET)
    return connection


def _request(method, path, body):
    data = b'' if body is None else json.dumps(body, separators=(',', ':')).encode()
    head = (method+' '+path+' HTTP/1.1\r\nHost: docker\r\n').encode()
    if body is not None:
        head += b'Content-Type: application/json\r\n'
    return head, data


def _read_head(connection, deadline):
    # Peek, then consume only through the blank line: body and hijacked stream
    # bytes after it stay in the socket for their own readers.
    head = bytearray()
    while True:
        if len(head) >= HEAD_LIMIT:
            raise DockerError('API_RESPONSE_BOUND')
        connection.settimeout(max(.001, deadline-time.monotonic()))
        block = connection.recv(HEAD_LIMIT-len(head), socket.MSG_PEEK)
        if not block:
            raise DockerError('API_EOF')
        overlap = min(len(TERMINATOR)-1, len(head))
        end = (bytes(head[len(head)-overlap:])+block).find(TERMINATOR)
        take = len(block) if end < 0 else end+len(TERMINATOR)-overlap
        while take:
            data = connection.recv(take)
            if not data:
                raise DockerError('API_EOF')
            head.extend(data)
            take -= len(data)
        if end >= 0:
            break
    lines = bytes(head).decode('latin-1').split('\r\n')
    status = lines[0].split(' ', 2)
    if len(status) < 2 or not status[1].isdigit():
        raise DockerError('API_RESPONSE_INVALID')
    headers = {}
    for line in lines[1:]:
        if ':' in line:
            key, value = line.split(':', 1)
            headers[key.strip().lower()] = value.strip()
    return int(status[1]), headers


def call(method, path, body=None, timeout=5):
    """One request on a fresh connection; returns (status, decoded JSON or None)."""
    deadline = time.monotonic()+timeout
    connection = _connect(timeout)
    try:
        head, data = _request(method, path, body)
        connection.sendall(head+b'Content-Length: '+str(len(data)).encode()+b'\r\nConnection: close\r\n\r\n'+data)
        status, headers = _read_head(connection, deadline)
        payload = bytearray()
        if headers.get('transfer-encoding') == 'chunked':
            buffer = bytearray()
            def fill(size):
                while len(buffer) < size:
                    connection.settimeout(max(.001, deadline-time.monotonic()))
                    block = connection.recv(65536)
                    if not block:
                        raise DockerError('API_EOF')
                    buffer.extend(block)
                    if len(buffer) > RESPONSE_LIMIT+65536:
                        raise DockerError('API_RESPONSE_BOUND')
            while True:
                while b'\r\n' not in buffer:
                    fill(len(buffer)+1)
                size_line, _, rest = bytes(buffer).partition(b'\r\n')
                buffer[:] = rest
                size = int(size_line.split(b';')[0], 16)
                fill(size+2)
                payload.extend(buffer[:size])
                del buffer[:size+2]
                if len(payload) > RESPONSE_LIMIT:
                    raise DockerError('API_RESPONSE_BOUND')
                if size == 0:
                    break
        else:
            length = int(headers.get('content-length', '0'))
            if not 0 <= length <= RESPONSE_LIMIT:
                raise DockerError('API_RESPONSE_BOUND')
            while len(payload) < length:
                connection.settimeout(max(.001, deadline-time.monotonic()))
                block = connection.recv(min(65536, length-len(payload)))
                if not block:
                    raise DockerError('API_EOF')
                payload.extend(block)
        try:
            return status, json.loads(payload) if payload else None
        except ValueError:
            raise DockerError('API_RESPONSE_INVALID') from None
    except (OSError, ValueError) as error:
        raise DockerError('API_UNAVAILABLE') from error
    finally:
        connection.close()


def require(status, value, expected=(200,)):
    if status not in expected:
        raise DockerError('API_STATUS_'+str(status))
    return value


def inspect_container(container, timeout=5):
    return require(*call('GET', '/containers/'+container+'/json', timeout=timeout))


def inspect_exec(exec_id, timeout=5):
    return require(*call('GET', '/exec/'+exec_id+'/json', timeout=timeout))


class ExecStream:
    """Hijacked exec stream: raw stdin writes, demultiplexed stdout reads."""
    def __init__(self, connection, stderr_limit):
        self.connection = connection
        self.buffer = bytearray()
        self.pending = bytearray()
        self.stderr_bytes = 0
        self.stderr_limit = stderr_limit
        self.eof = False
        self.stdin_closed = False

    def fileno(self):
        return self.connection.fileno()

    def _pump(self, deadline):
        if self.eof:
            raise DockerError('TRANSPORT_EOF')
        if not select.select([self.connection], [], [], max(0, deadline-time.monotonic()))[0]:
            raise DockerError('QUERY_TIMEOUT')
        block = self.connection.recv(65536)
        if not block:
            self.eof = True
            raise DockerError('TRANSPORT_EOF')
        self.pending.extend(block)
        while len(self.pending) >= 8:
            kind, size = self.pending[0], struct.unpack('!I', self.pending[4:8])[0]
            if kind not in (1, 2) or self.pending[1:4] != b'\0\0\0':
                raise DockerError('STREAM_INVALID')
            if len(self.pending) < 8+size:
                break
            data = bytes(self.pending[8:8+size])
            del self.pending[:8+size]
            if kind == 1:
                self.buffer.extend(data)
                if len(self.buffer) > 4*1024*1024:
                    raise DockerError('FRAME_BOUND')
            else:
                # stderr is diagnostic only and is discarded under a bound.
                self.stderr_bytes += len(data)
                if self.stderr_bytes > self.stderr_limit:
                    raise DockerError('STDERR_BOUND')

    def read_exact(self, length, deadline):
        while len(self.buffer) < length:
            self._pump(deadline)
        data = bytes(self.buffer[:length])
        del self.buffer[:length]
        return data

    def line(self, limit, deadline):
        while b'\n' not in self.buffer:
            if len(self.buffer) > limit:
                raise DockerError('FRAME_BOUND')
            self._pump(deadline)
        data, _, rest = bytes(self.buffer).partition(b'\n')
        if len(data) > limit:
            raise DockerError('FRAME_BOUND')
        self.buffer[:] = rest
        return data

    def drain(self, deadline, limit=65536):
        """Read until EOF; returns all remaining stdout bytes."""
        while not self.eof:
            try:
                self._pump(deadline)
            except DockerError as error:
                if str(error) == 'TRANSPORT_EOF':
                    break
                raise
            if len(self.buffer) > limit:
                raise DockerError('FRAME_BOUND')
        data = bytes(self.buffer)
        self.buffer.clear()
        return data

    def write(self, data):
        if self.stdin_closed:
            raise DockerError('STDIN_CLOSED')
        self.connection.sendall(data)

    def flush(self):
        pass

    def close_stdin(self):
        if not self.stdin_closed:
            self.stdin_closed = True
            try:
                self.connection.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    def close(self):
        self.stdin_closed = True
        self.connection.close()


def start_exec(container, command, user, timeout=5, stderr_limit=1024*1024):
    """Create and attach one exec; returns (exec id, stream)."""
    deadline = time.monotonic()+timeout
    status, created = call('POST', '/containers/'+container+'/exec', {
        'AttachStdin': True, 'AttachStdout': True, 'AttachStderr': True, 'Tty': False,
        'Privileged': False, 'User': user, 'Cmd': command, 'Env': []}, timeout)
    exec_id = require(status, created, (201,)).get('Id') if type(created) is dict else None
    if type(exec_id) is not str or len(exec_id) != 64 or any(c not in '0123456789abcdef' for c in exec_id):
        raise DockerError('EXEC_IDENTITY_INVALID')
    connection = _connect(deadline-time.monotonic())
    try:
        head, data = _request('POST', '/exec/'+exec_id+'/start', {'Detach': False, 'Tty': False})
        connection.sendall(head+b'Content-Length: '+str(len(data)).encode()+b'\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'+data)
        status, _ = _read_head(connection, deadline)
        if status not in (101, 200):
            raise DockerError('API_STATUS_'+str(status))
        connection.settimeout(None)
        return exec_id, ExecStream(connection, stderr_limit)
    except BaseException:
        connection.close()
        raise


def run_exec(container, command, user, timeout=5, limit=65536):
    """Run one fixed trusted inspection command to completion."""
    deadline = time.monotonic()+timeout
    exec_id, stream = start_exec(container, command, user, timeout, stderr_limit=4096)
    try:
        stream.close_stdin()
        output = stream.drain(deadline, limit)
    finally:
        stream.close()
    while True:
        value = inspect_exec(exec_id, max(.001, deadline-time.monotonic()))
        if value.get('Running') is False:
            return value.get('ExitCode'), output.decode('utf-8')
        if time.monotonic() >= deadline:
            raise DockerError('QUERY_TIMEOUT')
        time.sleep(.005)

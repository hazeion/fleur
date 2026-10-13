"""Trusted registered fixture dispatcher. This is not PostgreSQL evidence."""
import json
import os
import selectors
import subprocess
import time

REQUEST = {"kind": "broker-request", "operation": "compat.query",
           "token": "probe-query", "action": "readExercise", "input": {"id": 1}}


def fixture_dispatch(request):
    # Compare canonical serialized types too: True must never match integer 1.
    if json.dumps(request, sort_keys=True) != json.dumps(REQUEST, sort_keys=True):
        raise ValueError("unregistered broker authority")
    return {"kind": "broker-response", "ok": True,
            "value": {"id": 1, "name": "Squat"}}


class StartupAuditRejected(RuntimeError):
    def __init__(self, category):
        admitted = {'class-mismatch','unexpected-fd','missing-fd','invalid-inventory',
                    'inspection-failed','output-invalid'}
        self.category = category if type(category) is str and category in admitted else 'output-invalid'
        super().__init__('startup descriptor audit rejected: '+self.category)


def startup_inventory(request):
    if type(request) is not dict or set(request) != {'kind','inventory'} or request['kind'] != 'startup-audit':
        raise StartupAuditRejected('invalid-inventory')
    rows = request['inventory']
    if type(rows) is not list or not 2 <= len(rows) <= 192:
        raise StartupAuditRejected('invalid-inventory')
    seen = set()
    for row in rows:
        if (type(row) is not dict or set(row) != {'fd','kind'} or type(row['fd']) is not int
                or not 2 < row['fd'] <= 2147483647 or type(row['kind']) is not str
                or row['kind'] not in ('eventfd','eventpoll','timerfd') or row['fd'] in seen):
            raise StartupAuditRejected('invalid-inventory')
        seen.add(row['fd'])
    return rows


def run_container(args, dispatch=fixture_dispatch, timeout=30, observer=None, diagnostics=None, environment=None, on_stderr=None, startup_audit=None, completion_observer=None):
    """Perform one actual pipe request/response and await final worker evidence."""
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=environment)
    started = time.monotonic()
    output, errors = bytearray(), bytearray()
    phase = 'waiting-broker-request'
    def deadline_error():
        error = subprocess.TimeoutExpired(args, timeout, output=bytes(output[:16384]), stderr=bytes(errors[:4096]))
        error.protocol_phase = phase
        return error
    def read_error_chunk():
        chunk = os.read(process.stderr.fileno(),4096)
        errors.extend(chunk)
        if len(errors) > 4096:
            raise RuntimeError('worker stderr exceeded bound')
        if chunk and on_stderr is not None:
            on_stderr(bytes(errors))
        return chunk
    try:
        def read_request(limit):
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ, 'request')
                selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
                line = bytearray()
                while not line.endswith(b"\n"):
                    remaining = timeout - (time.monotonic() - started)
                    if remaining <= 0:
                        raise deadline_error()
                    ready = selector.select(remaining)
                    if not ready:
                        raise deadline_error()
                    for key, _ in ready:
                        if key.data == 'stderr':
                            if not read_error_chunk():
                                selector.unregister(process.stderr)
                            continue
                        byte = os.read(process.stdout.fileno(), 1)
                        if not byte:
                            raise RuntimeError("worker ended before broker request")
                        line.extend(byte)
                        if len(line) > limit:
                            raise RuntimeError("broker request exceeded bound")
            return json.loads(line)
        if startup_audit is not None:
            phase = 'waiting-startup-audit'
            inventory = startup_inventory(read_request(16384))
            phase = 'startup-audit'
            audited = startup_audit(inventory)
            if (type(audited) is not dict or audited.get('passed') is not True
                    or audited.get('category') != 'verified' or type(audited.get('descriptor_count')) is not int
                    or audited['descriptor_count'] != len(inventory)):
                raise StartupAuditRejected(audited.get('category') if type(audited) is dict else 'output-invalid')
            if time.monotonic() - started >= timeout:
                raise deadline_error()
            phase = 'startup-ack'
            process.stdin.write(b'startup:approved\n')
            process.stdin.flush()
        phase = 'waiting-broker-request'
        request = read_request(4096)
        phase = 'host-observer'
        if observer is not None:
            observer(request)
        phase = 'broker-dispatch'
        response = dispatch(request)
        if time.monotonic() - started >= timeout:
            raise deadline_error()
        if json.dumps(response, sort_keys=True) != json.dumps({"kind": "broker-response", "ok": True,
                        "value": {"id": 1, "name": "Squat"}}, sort_keys=True):
            raise RuntimeError("registered broker reply failed")
        phase = 'broker-ack'
        process.stdin.write(b"registered:Squat\n")
        process.stdin.flush()
        process.stdin.close()
        process.stdin = None
        phase = 'waiting-worker-completion'
        checked_at = 0.0
        def complete_frame():
            if b'\n' not in output:
                return None
            if output.count(b'\n') != 1 or not output.endswith(b'\n'):
                raise RuntimeError('worker output is not one bounded evidence frame')
            try:
                frame = json.loads(output)
            except (ValueError,UnicodeError):
                raise RuntimeError('worker evidence frame invalid') from None
            if type(frame) is not dict or frame.get('kind') != 'runtime-evidence':
                raise RuntimeError('worker evidence frame kind invalid')
            return frame
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, output)
            selector.register(process.stderr, selectors.EVENT_READ, errors)
            def drain(ready):
                for key, _ in ready:
                    chunk = os.read(key.fileobj.fileno(),4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    key.data.extend(chunk)
                    if len(output) > 16384 or len(errors) > 4096:
                        raise RuntimeError('worker output exceeded bound')
                    if key.data is errors and on_stderr is not None:
                        on_stderr(bytes(errors))
            while selector.get_map() or completion_observer is not None:
                remaining = timeout - (time.monotonic()-started)
                if remaining <= 0:
                    raise deadline_error()
                frame = complete_frame() if completion_observer is not None else None
                if frame is None and not selector.get_map():
                    raise RuntimeError('worker closed transport without a complete evidence frame')
                if frame is not None and time.monotonic()-checked_at >= 0.1:
                    completed = completion_observer(frame,remaining)
                    checked_at = time.monotonic()
                    remaining = timeout-(checked_at-started)
                    if remaining <= 0:
                        raise deadline_error()
                    if type(completed) is not dict or type(completed.get('completed')) is not bool:
                        raise RuntimeError('owned worker completion observer result invalid')
                    if completed['completed']:
                        if type(completed.get('exit_code')) is not int or completed['exit_code'] != 0:
                            raise RuntimeError('owned worker did not complete successfully')
                        # Only an accepted frame AND actual owned daemon stop
                        # permit retiring the separate attached host client.
                        if process.poll() is None:
                            process.kill()
                        process.wait(timeout=min(5,remaining))
                        while selector.get_map():
                            available = selector.select(0)
                            if not available:
                                break
                            drain(available)
                        complete_frame()
                        if time.monotonic()-started >= timeout:
                            raise deadline_error()
                        phase = 'verified-worker-complete'
                        if diagnostics is not None:
                            diagnostics['daemon_completion'] = completed
                            diagnostics['local_client_exit_code'] = process.returncode
                        return output.decode()
                ready = selector.select(min(remaining,0.1) if frame is not None else remaining)
                if not ready:
                    if frame is not None:
                        continue
                    raise deadline_error()
                drain(ready)
        process.wait(timeout=max(0.001, timeout-(time.monotonic()-started)))
        if process.returncode:
            raise RuntimeError(f"worker exited {process.returncode}: " + errors.decode(errors="replace")[-3000:])
        return output.decode()
    except subprocess.TimeoutExpired as error:
        # Preserve only already-drained bounded bytes. Callback timeouts keep
        # their own exception category but acquire the worker's observed phase.
        error.output = bytes(output[:16384])
        error.stderr = bytes(errors[:4096])
        error.protocol_phase = phase
        raise
    finally:
        if diagnostics is not None:
            diagnostics.update({'protocol_phase':phase,
                                'duration_ms':round(1000*(time.monotonic()-started)),
                                'timeout_seconds':timeout,
                                'stdout':bytes(output[:16384]).decode('utf-8',errors='replace'),
                                'stderr':bytes(errors[:4096]).decode('utf-8',errors='replace')})
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()

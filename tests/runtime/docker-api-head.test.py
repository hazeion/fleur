"""Docker Engine API response-head regressions for the native API client.

Issue #59: response heads must not be read one byte at a time, while the
existing head bound (16384 bytes before the next read, so at most 16385 bytes
including the blank-line terminator), fail-closed parsing, and exact delivery
of every byte after the terminator to the body or hijacked exec stream are
preserved. Exercised over real socket pairs with scripted chunk boundaries.
No Docker or Linux required.
Run: python3 tests/runtime/docker-api-head.test.py
"""
import importlib.util
import json
from pathlib import Path
import socket
import struct
import sys
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / 'src/runtime/native'
sys.path.insert(0, str(NATIVE))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


docker_api = load('head_docker_api', NATIVE / 'docker_api.py')
EXEC_ID = 'c' * 64
OPEN = []


def tearDownModule():
    for handle in OPEN:
        handle.close()


class Counting:
    """Forwards to a real socket and counts receive calls."""
    def __init__(self, connection):
        self.connection = connection
        self.receives = 0

    def recv(self, *args):
        self.receives += 1
        return self.connection.recv(*args)

    def __getattr__(self, name):
        return getattr(self.connection, name)


def peer(chunks, gap=.05, close=True):
    """A client socket whose peer waits for the request, then sends each chunk
    after a pause, so that chunk boundaries become separate reads."""
    left, right = socket.socketpair()
    OPEN.append(left)

    def send():
        try:
            request = bytearray()
            while b'\r\n\r\n' not in request:
                block = right.recv(65536)
                if not block:
                    return
                request.extend(block)
            for chunk in chunks:
                time.sleep(gap)
                right.sendall(chunk)
            if not close:
                time.sleep(3)
        except OSError:
            pass  # The client may stop reading once it has failed closed.
        finally:
            right.close()
    threading.Thread(target=send, daemon=True).start()
    return left


def frame(kind, data):
    return bytes([kind, 0, 0, 0]) + struct.pack('!I', len(data)) + data


def call(chunks, close=True, timeout=2, gap=.05):
    with patch.object(docker_api, '_connect', return_value=peer(chunks, gap, close)):
        return docker_api.call('GET', '/containers/x/json', timeout=timeout)


def failure(chunks, close=True):
    try:
        call(chunks, close)
    except docker_api.DockerError as error:
        return str(error)
    raise AssertionError('response was accepted')


class HeadLimits(unittest.TestCase):
    def head_of(self, size):
        start = b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Pad: '
        return start + b'p' * (size - len(start) - 4) + b'\r\n\r\n'

    def test_head_at_the_existing_bound_is_accepted_and_one_byte_more_is_not(self):
        self.assertEqual(len(self.head_of(16385)), 16385)
        self.assertEqual(call([self.head_of(16385) + b'{}']), (200, {}))
        self.assertEqual(failure([self.head_of(16386) + b'{}'], close=False), 'API_RESPONSE_BOUND')

    def test_oversized_head_block_fails_closed_without_waiting_for_more(self):
        lines = b''.join(b'X-Header-%05d: value\r\n' % index for index in range(1000))
        # The peer stays open, so only the bound (not EOF or timeout) can end the read.
        self.assertEqual(failure([b'HTTP/1.1 200 OK\r\n' + lines], close=False), 'API_RESPONSE_BOUND')
        self.assertEqual(failure([b'HTTP/1.1 200 OK\r\n', lines[:9000], lines[9000:]], close=False), 'API_RESPONSE_BOUND')

    def test_oversized_single_line_fails_closed(self):
        self.assertEqual(failure([b'HTTP/1.1 200 OK\r\nX-Long: ' + b'a' * 20000], close=False), 'API_RESPONSE_BOUND')
        self.assertEqual(failure([b'HTTP/1.1 200 ' + b'K' * 40000 + b'\r\n\r\n'], close=False), 'API_RESPONSE_BOUND')

    def test_malformed_status_line_fails_closed(self):
        for status in (b'garbage', b'HTTP/1.1 abc OK', b'HTTP/1.1', b''):
            with self.subTest(status=status):
                self.assertEqual(failure([status + b'\r\nContent-Length: 0\r\n\r\n']), 'API_RESPONSE_INVALID')

    def test_stalled_head_fails_closed_at_the_deadline(self):
        # The peer stays open after part of the head, so only the deadline ends the read.
        started = time.monotonic()
        with patch.object(docker_api, '_connect', return_value=peer([b'HTTP/1.1 200 OK\r\nContent-Le'], close=False)):
            with self.assertRaises(docker_api.DockerError) as caught:
                docker_api.call('GET', '/containers/x/json', timeout=.4)
        self.assertEqual(str(caught.exception), 'API_UNAVAILABLE')
        self.assertLess(time.monotonic() - started, 1.5)

    def test_eof_inside_the_head_fails_closed(self):
        self.assertEqual(failure([b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r']), 'API_EOF')


class HeadBoundaries(unittest.TestCase):
    RESPONSE = b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}'

    def test_terminator_split_across_reads_at_every_position(self):
        end = self.RESPONSE.index(b'\r\n\r\n')
        for split in range(end, end + 5):
            with self.subTest(split=split - end):
                self.assertEqual(call([self.RESPONSE[:split], self.RESPONSE[split:]]), (200, {'ok': True}))

    def test_byte_at_a_time_delivery_is_still_accepted(self):
        self.assertEqual(call([self.RESPONSE[i:i + 1] for i in range(len(self.RESPONSE))], gap=.002), (200, {'ok': True}))

    def test_body_arriving_in_the_same_read_as_the_head_is_not_lost(self):
        self.assertEqual(call([self.RESPONSE]), (200, {'ok': True}))
        chunked = (b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'
                   b'5\r\n{"a":\r\n3\r\n[1]\r\n1\r\n}\r\n0\r\n\r\n')
        self.assertEqual(call([chunked]), (200, {'a': [1]}))
        self.assertEqual(call([chunked[:60], chunked[60:]]), (200, {'a': [1]}))

    def test_head_is_not_read_one_byte_per_receive(self):
        head = b'HTTP/1.1 200 OK\r\n' + b''.join(b'X-Header-%03d: value\r\n' % index for index in range(80)) + b'Content-Length: 2\r\n\r\n'
        counting = Counting(peer([head + b'{}']))
        with patch.object(docker_api, '_connect', return_value=counting):
            self.assertEqual(docker_api.call('GET', '/containers/x/json', timeout=2), (200, {}))
        self.assertGreater(len(head), 1500)
        self.assertLessEqual(counting.receives, 8)


class HijackedStream(unittest.TestCase):
    """Exec frames sent together with the upgrade head belong to the stream."""
    def start(self, upgrade_chunks):
        created = json.dumps({'Id': EXEC_ID}).encode()
        create = peer([b'HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: '
                       + str(len(created)).encode() + b'\r\n\r\n' + created])
        attach = Counting(peer(upgrade_chunks))
        with patch.object(docker_api, '_connect', side_effect=[create, attach]):
            exec_id, stream = docker_api.start_exec('x', ['true'], 'fleur', timeout=2)
        self.assertEqual(exec_id, EXEC_ID)
        return stream, attach

    UPGRADE = b'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'

    def test_frames_in_the_same_read_as_the_upgrade_head_reach_the_stream(self):
        frames = frame(2, b'diag') + frame(1, b'{"kind":"ready"}\n') + frame(1, b'tail')
        stream, attach = self.start([self.UPGRADE + frames])
        try:
            self.assertEqual(stream.line(1024, time.monotonic() + 2), b'{"kind":"ready"}')
            self.assertEqual(stream.drain(time.monotonic() + 2), b'tail')
            self.assertEqual(stream.stderr_bytes, 4)
        finally:
            stream.close()
        self.assertLessEqual(attach.receives, 8)

    def test_frame_header_split_from_the_upgrade_terminator(self):
        frames = frame(1, b'line\n')
        stream, _ = self.start([self.UPGRADE[:-1], self.UPGRADE[-1:] + frames[:3], frames[3:]])
        try:
            self.assertEqual(stream.line(1024, time.monotonic() + 2), b'line')
        finally:
            stream.close()


if __name__ == '__main__':
    unittest.main()

"""Independent reviewer checks for the retained native execution path.

Pure unit tests: no Docker, Linux or PostgreSQL. They derive from ADR 0001's
required contract (immutable guard binding, retirement before reuse, exact
stream ownership, quarantine on uncertainty), not from the implementation.
Run: python3 tests/runtime/review-retained-native.test.py
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import sys
import tempfile
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


guard = load('review_retained_guard', NATIVE / 'retained_guard.py')
docker_api = load('review_docker_api', NATIVE / 'docker_api.py')
retained = load('review_retained_controller', NATIVE / 'retained_controller.py')

CID = 'a' * 64
OTHER = 'b' * 64
OPERATION = '00000000-0000-4000-8000-000000000001'
OPEN = []


def tearDownModule():
    for handle in OPEN:
        handle.close()


class FakeProc:
    """A fake /proc and cgroup tree for the guard's identity checks."""
    def __init__(self):
        self.base = Path(tempfile.mkdtemp())
        self.proc, self.root = self.base / 'proc', self.base / 'cgroup'

    def process(self, pid, cgroup, start='4242', state='S', nspid=None):
        directory = self.proc / str(pid)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'cgroup').write_text('0::' + cgroup + '\n')
        fields = [state] + ['0'] * 18 + [start] + ['0'] * 10
        (directory / 'stat').write_text(f'{pid} (bun) ' + ' '.join(fields) + '\n')
        (directory / 'status').write_text('Name:\tbun\nNSpid:\t' + '\t'.join(str(v) for v in (nspid or [pid])) + '\n')

    def group(self, cgroup, members, current):
        directory = self.root / cgroup.lstrip('/')
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'cgroup.procs').write_text(''.join(f'{pid}\n' for pid in members))
        (directory / 'pids.current').write_text(f'{current}\n')
        return directory


class GuardIdentity(unittest.TestCase):
    def setUp(self):
        self.fake = FakeProc()

    def test_container_cgroup_must_be_a_complete_component_of_the_bound_container(self):
        for path in ('/system.slice/docker-' + CID + '.scope', '/docker/' + CID):
            self.fake.process(10, path)
            self.assertEqual(guard.cgroup_directory(10, CID, self.fake.proc, self.fake.root), self.fake.root / path.lstrip('/'))
        for path in ('/docker/' + CID + '/nested', '/docker/' + OTHER, '/docker/' + CID + 'ff', '/system.slice/docker-' + CID + '.scope/child'):
            self.fake.process(11, path)
            with self.assertRaises(RuntimeError, msg=path):
                guard.cgroup_directory(11, CID, self.fake.proc, self.fake.root)

    def test_identity_rejects_zombies_and_reports_the_innermost_namespace_pid(self):
        self.fake.process(20, '/docker/' + CID, start='777', nspid=[20, 9])
        self.assertEqual(guard.identity(20, self.fake.proc), ('777', 9))
        self.fake.process(21, '/docker/' + CID, state='Z')
        with self.assertRaises(RuntimeError):
            guard.identity(21, self.fake.proc)

    def test_retirement_requires_only_init_and_no_surviving_task(self):
        directory = self.fake.group('/docker/' + CID, [5], 1)
        self.assertTrue(guard.retired(directory, 5, time.monotonic() + .05))
        # A surviving descendant process or an extra task fails closed.
        directory = self.fake.group('/docker/' + CID, [5, 6], 2)
        self.assertFalse(guard.retired(directory, 5, time.monotonic() + .05))
        directory = self.fake.group('/docker/' + CID, [5], 2)
        self.assertFalse(guard.retired(directory, 5, time.monotonic() + .05))
        directory = self.fake.group('/docker/' + CID, [6], 1)
        self.assertFalse(guard.retired(directory, 5, time.monotonic() + .05))
        # Malformed membership is uncertainty, never retirement.
        (directory / 'cgroup.procs').write_text('5\nx\n')
        self.assertFalse(guard.retired(directory, 5, time.monotonic() + .05))


class GuardMain(unittest.TestCase):
    """Arming rejects any target that is not the single bound operation process."""
    def run_main(self, members, namespace_seen=9, namespace_arg='9', host='20', init='5', retired=True, outcome='premature-exit'):
        written, supervised = [], []
        def fake_write(fd, data):
            written.append(json.loads(data))
            return len(data)
        def fake_supervise(container, pid, deadline, bind, kill, close, control, emit):
            supervised.append((container, pid))
            emit({'kind': 'armed'})
            emit({'kind': 'result', 'outcome': outcome, 'physical_exit_confirmed': True, 'kill_lateness_ms': 0, 'physical_exit_lateness_ms': 0})
        argv = ['guard', CID, host, namespace_arg, init, repr(time.monotonic() + 5), 'boot', OPERATION]
        with patch.object(sys, 'argv', argv), patch.object(guard.os, 'geteuid', return_value=0), \
                patch.object(guard.os, 'write', side_effect=fake_write), \
                patch.object(guard, 'Path', side_effect=lambda value: type('P', (), {'read_text': lambda self: 'boot\n'})() if 'boot_id' in str(value) else Path(value)), \
                patch.object(guard, 'cgroup_directory', return_value=Path('/x')), \
                patch.object(guard, 'identity', return_value=('4242', namespace_seen)), \
                patch.object(guard, 'members', return_value=members), \
                patch.object(guard, 'retired', return_value=retired), \
                patch.object(guard, 'supervise', side_effect=fake_supervise):
            try:
                guard.main()
                code = 0
            except SystemExit as error:
                code = error.code
        return code, written, supervised

    def test_valid_binding_arms_once_and_reports_retirement(self):
        code, written, supervised = self.run_main([5, 20])
        self.assertEqual(code, 0)
        self.assertEqual(supervised, [(CID, 20)])
        self.assertEqual(written[0], {'kind': 'armed', 'operation': OPERATION, 'start': '4242'})
        self.assertEqual(written[1]['retired'], True)
        self.assertEqual(written[1]['operation'], OPERATION)

    def test_extra_process_beside_init_is_never_armed(self):
        code, written, supervised = self.run_main([5, 20, 21])
        self.assertEqual((code, supervised), (1, []))
        self.assertEqual(written, [{'kind': 'error', 'category': 'deadline-guard-failed'}])

    def test_namespace_pid_mismatch_or_init_target_is_never_armed(self):
        for kwargs in ({'namespace_seen': 10}, {'namespace_arg': '1', 'namespace_seen': 1}, {'host': '5', 'members': [5]}):
            arguments = {'members': [5, 20], **kwargs}
            code, written, supervised = self.run_main(**arguments)
            self.assertEqual((code, supervised), (1, []), kwargs)

    def test_unconfirmed_retirement_is_reported_not_hidden(self):
        code, written, _ = self.run_main([5, 20], retired=False)
        self.assertEqual(code, 0)
        self.assertIs(written[1]['retired'], False)
        with self.assertRaises(retained.Quarantine):
            retained.require_retirement(written[1], OPERATION, '4242', ('premature-exit',))


class ExecStreamDemux(unittest.TestCase):
    """Application bytes can never be read as stream headers or as another stream."""
    def stream(self, payload, chunk=3):
        left, right = socket.socketpair()
        for index in range(0, len(payload), chunk):
            right.sendall(payload[index:index + chunk])
        right.close()
        OPEN.append(left)
        return docker_api.ExecStream(left, 16)

    @staticmethod
    def frame(kind, data):
        return bytes([kind, 0, 0, 0]) + struct.pack('!I', len(data)) + data

    def test_fragmented_stdout_is_reassembled_and_stderr_is_never_mixed_in(self):
        payload = self.frame(2, b'\x01\x00\x00\x00fake') + self.frame(1, b'{"kind":') + self.frame(2, b'x') + self.frame(1, b'"a"}\nrest')
        stream = self.stream(payload)
        self.assertEqual(stream.line(1024, time.monotonic() + 2), b'{"kind":"a"}')
        self.assertEqual(stream.drain(time.monotonic() + 2), b'rest')

    def test_invalid_header_and_stderr_flood_fail_closed(self):
        with self.assertRaises(docker_api.DockerError) as caught:
            self.stream(b'\x03\x00\x00\x00\x00\x00\x00\x01x').line(10, time.monotonic() + 2)
        self.assertEqual(str(caught.exception), 'STREAM_INVALID')
        with self.assertRaises(docker_api.DockerError) as caught:
            self.stream(self.frame(2, b'e' * 17) + self.frame(1, b'ok\n')).line(10, time.monotonic() + 2)
        self.assertEqual(str(caught.exception), 'STDERR_BOUND')

    def test_eof_before_a_complete_line_is_not_a_line(self):
        with self.assertRaises(docker_api.DockerError) as caught:
            self.stream(self.frame(1, b'partial')).line(1024, time.monotonic() + 2)
        self.assertEqual(str(caught.exception), 'TRANSPORT_EOF')


class Stream:
    """Scripted exec stream for one application or guard process."""
    def __init__(self, lines=(), frames=()):
        self.lines = list(lines)
        self.frames = [json.dumps(value).encode() for value in frames]
        self.data = bytearray()
        for value in self.frames:
            self.data += struct.pack('!I', len(value)) + value
        self.written = bytearray()
        self.stdin_closed = self.closed = False

    def line(self, limit, deadline):
        if not self.lines:
            raise docker_api.DockerError('QUERY_TIMEOUT')
        value = self.lines.pop(0)
        return value() if callable(value) else value

    def read_exact(self, length, deadline):
        if len(self.data) < length:
            raise docker_api.DockerError('QUERY_TIMEOUT')
        value = bytes(self.data[:length])
        del self.data[:length]
        return value

    def write(self, data):
        self.written += data

    def flush(self):
        pass

    def close_stdin(self):
        self.stdin_closed = True

    def close(self):
        self.closed = True


class Host:
    """Host side of the controller channel over a real pipe."""
    def __init__(self, decisions):
        self.read, self.write = os.pipe()
        self.input = os.fdopen(self.read, 'rb', buffering=0)
        for value in decisions:
            data = json.dumps(value).encode()
            os.write(self.write, struct.pack('!I', len(data)) + data)
        os.close(self.write)
        self.output = io.BytesIO()
        OPEN.append(self.input)

    def sent(self):
        data, values = self.output.getvalue(), []
        while data:
            size = struct.unpack('!I', data[:4])[0]
            values.append(json.loads(data[4:4 + size]))
            data = data[4 + size:]
        return values


def result(outcome, start='4242', operation=OPERATION, retired_value=True):
    return json.dumps({'kind': 'result', 'outcome': outcome, 'physical_exit_confirmed': True, 'kill_lateness_ms': 0,
                       'physical_exit_lateness_ms': 0, 'operation': operation, 'start': start, 'retired': retired_value}).encode()


def grant(value=2000):
    """The host's grant: what remains of its deadline when it receives the run acknowledgement."""
    return {'kind': 'deadline', 'value': value, 'operation': OPERATION}


class ControllerRun(unittest.TestCase):
    def slot(self, application, guard_stream, exit_code=0):
        slot = object.__new__(retained.Slot)
        slot.worker, slot.guard, slot.init, slot.boot = CID, OTHER, 5, 'boot'
        slot.retired = retained.collections.deque(maxlen=16)
        slot.prepared = {'operation': OPERATION, 'exec': 'c' * 64, 'stream': application, 'started': time.monotonic(), 'pid': 20, 'namespace': 9}
        execs = {'c' * 64: {'Running': False, 'ExitCode': exit_code}}
        def inspect_exec(exec_id):
            if exec_id == 'g' * 64:
                return {'ContainerID': OTHER, 'Running': not guard_stream.lines == [], 'ExitCode': 0, 'ProcessConfig': {
                    'tty': False, 'entrypoint': '/usr/bin/python3', 'arguments': self.arguments, 'privileged': False, 'user': '0:0'}}
            return execs[exec_id]
        def start_exec(container, command, user, timeout=5, stderr_limit=0):
            self.arguments = command[1:]
            return 'g' * 64, guard_stream
        return slot, patch.multiple(retained, start_exec=start_exec, inspect_exec=inspect_exec)

    def request(self, budget=2000):
        return {'kind': 'run', 'operation': OPERATION, 'budgetMs': budget, 'command': {'mode': 'query'}}

    def test_application_bytes_reach_the_host_only_after_the_bound_guard_is_admitted(self):
        application = Stream(frames=[{'kind': 'complete', 'value': 1}])
        guard_stream = Stream(lines=[b'{"kind":"armed","operation":"' + OPERATION.encode() + b'","start":"4242"}', result('premature-exit')])
        slot, patched = self.slot(application, guard_stream)
        host = Host([grant(), {'kind': 'admit', 'value': None, 'operation': OPERATION}, {'kind': 'finish', 'value': None, 'operation': OPERATION}])
        with patched:
            reply = slot.run(self.request(), host.input, host.output)
        sent = host.sent()
        self.assertEqual(sent[0], {'kind': 'received', 'operation': OPERATION})
        self.assertEqual(sent[1]['kind'], 'guard')
        self.assertEqual(sent[1]['value']['start'], '4242')
        self.assertTrue(application.written.startswith(b'startup:approved\n'))
        self.assertEqual(sent[2], {'kind': 'worker', 'value': {'kind': 'complete', 'value': 1}})
        self.assertEqual(reply['kind'], 'retired')
        self.assertIsNone(slot.prepared)
        self.assertTrue(application.closed and guard_stream.closed)

    def test_missing_host_admission_never_releases_the_application(self):
        application = Stream(frames=[{'kind': 'complete', 'value': 1}])
        guard_stream = Stream(lines=[b'{"kind":"armed","operation":"' + OPERATION.encode() + b'","start":"4242"}'])
        slot, patched = self.slot(application, guard_stream)
        host = Host([{'kind': 'reply', 'value': None, 'operation': OPERATION}])
        with patched, self.assertRaises(retained.Quarantine):
            slot.run(self.request(), host.input, host.output)
        self.assertEqual(bytes(application.written), b'')

    def test_a_guard_record_for_another_operation_or_start_quarantines(self):
        for record in (result('premature-exit', start='1'), result('premature-exit', operation='00000000-0000-4000-8000-000000000002'), result('premature-exit', retired_value=False)):
            application = Stream(frames=[{'kind': 'complete', 'value': 1}])
            guard_stream = Stream(lines=[b'{"kind":"armed","operation":"' + OPERATION.encode() + b'","start":"4242"}', record])
            slot, patched = self.slot(application, guard_stream)
            host = Host([grant(), {'kind': 'admit', 'value': None, 'operation': OPERATION}, {'kind': 'finish', 'value': None, 'operation': OPERATION}])
            with patched, self.assertRaises(retained.Quarantine):
                slot.run(self.request(), host.input, host.output)

    def completion(self, record, exit_code=0, frames=({'kind': 'complete', 'value': 1},)):
        application = Stream(frames=frames)
        guard_stream = Stream(lines=[b'{"kind":"armed","operation":"' + OPERATION.encode() + b'","start":"4242"}', record])
        slot, patched = self.slot(application, guard_stream, exit_code)
        host = Host([grant(), {'kind': 'admit', 'value': None, 'operation': OPERATION}, {'kind': 'finish', 'value': None, 'operation': OPERATION}])
        return application, guard_stream, slot, patched, host

    # #58: application code can write a terminal-looking frame. Completion bytes
    # followed by a deadline kill or an unclean exit mean the process did not
    # complete: never clean retirement, but a verified retirement fails only
    # that operation instead of quarantining the slot.
    def test_a_completed_process_that_had_to_be_killed_is_not_clean_retirement(self):
        application, guard_stream, slot, patched, host = self.completion(result('deadline'))
        with patched:
            reply = slot.run(self.request(), host.input, host.output)
        self.assertEqual((reply['kind'], reply['code'], reply['physicalExitConfirmed']), ('failure', 'INTERNAL_FAILURE', True))
        self.assertEqual(reply['deadline']['outcome'], 'deadline')
        self.assertIsNone(slot.prepared)
        self.assertIn(OPERATION, slot.retired)
        self.assertTrue(application.closed and guard_stream.closed)

    def test_nonzero_exit_after_completion_is_not_clean_retirement(self):
        for exit_code in (1, 25, None):
            _, _, slot, patched, host = self.completion(result('premature-exit'), exit_code)
            with patched:
                reply = slot.run(self.request(), host.input, host.output)
            self.assertEqual((reply['kind'], reply['code'], reply['deadline']['outcome']), ('failure', 'INTERNAL_FAILURE', 'premature-exit'), exit_code)
            self.assertIsNone(slot.prepared)

    def test_uncertain_retirement_after_completion_still_quarantines(self):
        late = json.dumps({'kind': 'result', 'outcome': 'deadline', 'physical_exit_confirmed': True, 'kill_lateness_ms': 0,
                           'physical_exit_lateness_ms': 251, 'operation': OPERATION, 'start': '4242', 'retired': True}).encode()
        for record in (result('deadline', retired_value=False), result('late-termination'), result('cancelled'), result('deadline', start='1'), late, b'{}'):
            _, _, slot, patched, host = self.completion(record)
            with patched, self.assertRaises(retained.Quarantine, msg=record):
                slot.run(self.request(), host.input, host.output)
        # Missing guard record: retirement itself is unconfirmed.
        _, _, slot, patched, host = self.completion(lambda: (_ for _ in ()).throw(docker_api.DockerError('QUERY_TIMEOUT')))
        with patched, self.assertRaises(retained.Quarantine):
            slot.run(self.request(), host.input, host.output)

    def test_an_application_frame_the_host_would_reject_cancels_only_its_operation(self):
        nested = 0
        for _ in range(100):
            nested = [nested]
        for frame in (b'[1]', b'null', b'"complete"', b'{"kind":"read","value":NaN}', b'{"value":Infinity}', b'{"value":1e400}',
                      b'{"value":9007199254740992}', b'{"value":-9007199254740992.5}', json.dumps({'value': nested}).encode(), b'{"kind":'):
            application = Stream()
            application.data += struct.pack('!I', len(frame)) + frame
            guard_stream = Stream(lines=[b'{"kind":"armed","operation":"' + OPERATION.encode() + b'","start":"4242"}', lambda: result('cancelled') if guard_stream.stdin_closed else b'{}'])
            slot, patched = self.slot(application, guard_stream)
            host = Host([grant(), {'kind': 'admit', 'value': None, 'operation': OPERATION}])
            with patched:
                reply = slot.run(self.request(), host.input, host.output)
            self.assertTrue(guard_stream.stdin_closed, frame)
            self.assertEqual((reply['kind'], reply['code'], reply['deadline']['outcome']), ('failure', 'INTERNAL_FAILURE', 'cancelled'), frame)
            # Nothing the host would reject is forwarded to it.
            self.assertEqual([value['kind'] for value in host.sent()], ['received', 'guard'], frame)
            self.assertIsNone(slot.prepared)

    def test_application_frames_within_the_public_contract_are_forwarded(self):
        nested = 0
        for _ in range(98):
            nested = [nested]
        for value in ({'value': nested}, {'value': 9007199254740991, 'other': -9007199254740991, 'real': 1.5, 'text': 'é', 'flag': None}):
            application, guard_stream, slot, patched, host = self.completion(result('premature-exit'), frames=(value,))
            with patched:
                reply = slot.run(self.request(), host.input, host.output)
            self.assertEqual(reply['kind'], 'retired')
            self.assertEqual(host.sent()[2], {'kind': 'worker', 'value': value})

    def test_host_cancellation_retires_only_through_the_bound_guard(self):
        application = Stream(frames=[{'kind': 'read', 'value': 1}])
        guard_stream = Stream(lines=[b'{"kind":"armed","operation":"' + OPERATION.encode() + b'","start":"4242"}', lambda: result('cancelled') if guard_stream.stdin_closed else b'{}'])
        slot, patched = self.slot(application, guard_stream)
        host = Host([grant(), {'kind': 'admit', 'value': None, 'operation': OPERATION}, {'kind': 'cancel', 'value': None, 'operation': OPERATION}])
        with patched:
            reply = slot.run(self.request(), host.input, host.output)
        self.assertTrue(guard_stream.stdin_closed)
        self.assertEqual(reply['kind'], 'failure')
        self.assertEqual(reply['deadline']['outcome'], 'cancelled')

    def test_admission_expiry_is_terminal(self):
        application = Stream()
        slot, patched = self.slot(application, Stream())
        slot.prepared['started'] = time.monotonic() - retained.ADMISSION_WINDOW
        host = Host([])
        with patched, self.assertRaises(retained.Quarantine):
            slot.run(self.request(), host.input, host.output)
        self.assertEqual(bytes(application.written), b'')

    def test_request_for_another_operation_is_denied(self):
        slot, patched = self.slot(Stream(), Stream())
        host = Host([])
        request = dict(self.request(), operation='00000000-0000-4000-8000-000000000002')
        with patched, self.assertRaises(retained.Quarantine):
            slot.run(request, host.input, host.output)
        for budget in (0, 5001, 1.5):
            with patched, self.assertRaises(retained.Quarantine):
                slot.run(self.request(budget), host.input, host.output)

    # #67: arming that outlives the budget is a timeout, never silent uncertainty.
    def expired_arming(self, record):
        def late():
            time.sleep(.03)
            raise docker_api.DockerError('QUERY_TIMEOUT')
        application = Stream()
        guard_stream = Stream(lines=[late, record])
        slot, patched = self.slot(application, guard_stream)
        host = Host([grant(10)])
        return application, guard_stream, slot, patched, host

    def test_arming_expiry_with_a_verified_unadmitted_retirement_is_a_timeout(self):
        record = json.dumps({'kind': 'result', 'outcome': 'unadmitted', 'physical_exit_confirmed': True, 'kill_lateness_ms': 10,
                             'physical_exit_lateness_ms': 12, 'operation': OPERATION, 'start': '4242', 'retired': True}).encode()
        application, _, slot, patched, host = self.expired_arming(record)
        with patched:
            reply = slot.run(self.request(10), host.input, host.output)
        self.assertEqual((reply['kind'], reply['code'], reply['deadline']['outcome']), ('failure', 'QUERY_TIMEOUT', 'unadmitted'))
        # Only the run's acknowledgement: no guard binding and no application bytes.
        self.assertEqual(host.sent(), [{'kind': 'received', 'operation': OPERATION}])
        self.assertEqual(bytes(application.written), b'')
        self.assertIn(OPERATION, slot.retired)

    def test_arming_expiry_without_a_verified_start_or_in_time_quarantines(self):
        base = {'kind': 'result', 'outcome': 'unadmitted', 'physical_exit_confirmed': True, 'kill_lateness_ms': 10,
                'physical_exit_lateness_ms': 12, 'operation': OPERATION, 'retired': True}
        for record in (base, dict(base, start=None), dict(base, start='4242', kill_lateness_ms=300, physical_exit_lateness_ms=310)):
            application, _, slot, patched, host = self.expired_arming(json.dumps(record).encode())
            with patched, self.assertRaises(retained.Quarantine):
                slot.run(self.request(10), host.input, host.output)
            self.assertEqual(bytes(application.written), b'')

    def test_host_admission_after_the_deadline_is_a_timeout_retired_by_the_armed_guard(self):
        application = Stream(frames=[{'kind': 'complete', 'value': 1}])
        guard_stream = Stream(lines=[b'{"kind":"armed","operation":"' + OPERATION.encode() + b'","start":"4242"}', result('deadline')])
        slot, patched = self.slot(application, guard_stream)
        # After its grant, the host channel stays open and silent past the run's deadline.
        read, write = os.pipe()
        data = json.dumps(grant(50)).encode()
        os.write(write, struct.pack('!I', len(data)) + data)
        host_in = os.fdopen(read, 'rb', buffering=0)
        OPEN.append(host_in)
        output = io.BytesIO()
        try:
            with patched:
                reply = slot.run(self.request(50), host_in, output)
        finally:
            os.close(write)
        self.assertEqual((reply['kind'], reply['code'], reply['deadline']['outcome']), ('failure', 'QUERY_TIMEOUT', 'deadline'))
        self.assertEqual(bytes(application.written), b'')
        self.assertIn(OPERATION, slot.retired)

    # #75: host-to-controller transit is charged to the host's budget. The
    # controller anchors the guard's deadline before acknowledging the run; the
    # host answers with what remains of its own deadline when it receives that
    # acknowledgement. Only relative durations cross the clock boundary.
    def armed_run(self, granted, budget=2000):
        application = Stream(frames=[{'kind': 'complete', 'value': 1}])
        guard_stream = Stream(lines=[b'{"kind":"armed","operation":"' + OPERATION.encode() + b'","start":"4242"}', result('premature-exit')])
        slot, patched = self.slot(application, guard_stream)
        host = Host([{'kind': 'deadline', 'value': granted, 'operation': OPERATION}, {'kind': 'admit', 'value': None, 'operation': OPERATION},
                     {'kind': 'finish', 'value': None, 'operation': OPERATION}])
        return application, slot, patched, host

    def test_the_guard_deadline_is_the_hosts_remaining_budget_from_the_controllers_acknowledgement(self):
        application, slot, patched, host = self.armed_run(700)
        before = time.monotonic()
        with patched:
            reply = slot.run(self.request(2000), host.input, host.output)
        self.assertEqual(reply['kind'], 'retired')
        sent = host.sent()
        self.assertEqual(sent[0], {'kind': 'received', 'operation': OPERATION})
        self.assertEqual(sent[1]['kind'], 'guard')
        deadline = float(self.arguments[7])
        self.assertEqual(sent[1]['value']['deadline'], deadline)
        # Anchored no earlier than the run began, and only the host's grant follows it.
        self.assertGreaterEqual(deadline, before + .7)
        self.assertLess(deadline, before + .7 + .5)

    def test_no_host_grant_extends_the_budget_or_reaches_the_guard_unvalidated(self):
        for granted in (2001, -1, 1.5, None, True, '700'):
            application, slot, patched, host = self.armed_run(granted)
            self.arguments = None
            with patched, self.assertRaises(retained.Quarantine, msg=granted):
                slot.run(self.request(2000), host.input, host.output)
            self.assertIsNone(self.arguments, granted)
            self.assertEqual(bytes(application.written), b'', granted)
        for grant in ({'kind': 'admit', 'value': None, 'operation': OPERATION}, {'kind': 'deadline', 'value': 700, 'operation': '00000000-0000-4000-8000-000000000002'},
                      {'kind': 'deadline', 'value': 700, 'operation': OPERATION, 'extra': 1}):
            application = Stream()
            slot, patched = self.slot(application, Stream())
            host = Host([grant])
            self.arguments = None
            with patched, self.assertRaises(retained.Quarantine, msg=grant):
                slot.run(self.request(2000), host.input, host.output)
            self.assertIsNone(self.arguments, grant)

    def test_a_host_grant_that_never_arrives_retires_the_unadmitted_process(self):
        record = json.dumps({'kind': 'result', 'outcome': 'unadmitted', 'physical_exit_confirmed': True, 'kill_lateness_ms': 10,
                             'physical_exit_lateness_ms': 12, 'operation': OPERATION, 'start': '4242', 'retired': True}).encode()
        application = Stream()
        guard_stream = Stream(lines=[record])
        slot, patched = self.slot(application, guard_stream)
        read, write = os.pipe()
        host_in = os.fdopen(read, 'rb', buffering=0)
        OPEN.append(host_in)
        output = io.BytesIO()
        try:
            with patched:
                reply = slot.run(self.request(50), host_in, output)
        finally:
            os.close(write)
        self.assertEqual((reply['kind'], reply['code'], reply['deadline']['outcome']), ('failure', 'QUERY_TIMEOUT', 'unadmitted'))
        self.assertEqual(bytes(application.written), b'')
        self.assertIn(OPERATION, slot.retired)

    def test_a_stale_admission_for_a_timed_out_operation_is_ignored(self):
        failure = {'kind': 'failure', 'operation': OPERATION, 'code': 'QUERY_TIMEOUT'}
        class Retained:
            def __init__(self, *arguments):
                self.retired, self.closed = [], False
            def create(self):
                return {}
            def run(self, request, host_in, host_out):
                self.retired.append(request['operation'])
                return failure
            def close(self):
                self.closed = True
            def remove(self):
                pass
        def controller(frames):
            host = Host(frames)
            stdout = type('Out', (), {'buffer': host.output})()
            argv = ['controller', 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64, OPERATION]
            # The idle wait is effectively unbounded; macOS select rejects such timeouts.
            frame = retained.frame
            bounded = lambda stream, deadline: frame(stream, min(deadline, time.monotonic() + 5))
            with patch.object(sys, 'argv', argv), patch.object(sys, 'stdin', type('In', (), {'buffer': host.input})()), \
                    patch.object(sys, 'stdout', stdout), patch.object(retained, 'Slot', Retained), patch.object(retained, 'frame', bounded):
                try:
                    retained.main()
                except SystemExit:
                    pass
            return [value['kind'] for value in host.sent()]
        admit = {'kind': 'admit', 'value': None, 'operation': OPERATION}
        self.assertEqual(controller([{'kind': 'run', 'operation': OPERATION}, admit]), ['ready', 'failure', 'closed'])
        grant = {'kind': 'deadline', 'value': 700, 'operation': OPERATION}
        self.assertEqual(controller([{'kind': 'run', 'operation': OPERATION}, grant, admit]), ['ready', 'failure', 'closed'])
        # An admission for an operation that never timed out remains a protocol violation.
        self.assertEqual(controller([admit]), ['ready', 'quarantined'])


if __name__ == '__main__':
    unittest.main()

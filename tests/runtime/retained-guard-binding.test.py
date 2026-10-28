"""PID-reuse regressions for the retained deadline guard's pidfd binding.

ADR 0001: each deadline watcher binds one immutable operation, container, boot
and process start identity and pidfd. A PID reused between identity inspection
and pidfd binding must never be armed or signalled. Native PID reuse cannot be
staged deterministically, so this exercises the real binding and supervision
code against a fake /proc at the OS boundary. No Docker or Linux required.
Run: python3 tests/runtime/retained-guard-binding.test.py
"""
import importlib.util
import json
import os
from pathlib import Path
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


guard = load('binding_retained_guard', NATIVE / 'retained_guard.py')
deadline = load('binding_worker_deadline', NATIVE / 'worker_deadline.py')

CID = 'c' * 64
OPERATION = '00000000-0000-4000-8000-000000000007'


def write_process(proc, pid, start, cgroup='/docker/' + CID):
    directory = proc / str(pid)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'cgroup').write_text('0::' + cgroup + '\n')
    fields = ['S'] + ['0'] * 18 + [start] + ['0'] * 10
    (directory / 'stat').write_text(f'{pid} (bun) ' + ' '.join(fields) + '\n')


class Opener:
    """Stands in for pidfd_open; `reuse` replaces the process before it returns."""
    def __init__(self, reuse=None):
        self.reuse, self.opened, self.writers = reuse, [], []

    def __call__(self, pid, flags):
        # An open, silent pipe reads as a live process; EOF would read as exit.
        read, write = os.pipe()
        self.writers.append(write)
        self.opened.append(read)
        if self.reuse:
            self.reuse()
        return read


class PidfdBinding(unittest.TestCase):
    def setUp(self):
        self.proc = Path(tempfile.mkdtemp()) / 'proc'

    def test_a_stable_process_binds(self):
        write_process(self.proc, 20, '4242')
        opener = Opener()
        fd = deadline.bind_owned_pidfd(CID, 20, self.proc, opener)
        self.assertEqual(fd, opener.opened[0])
        os.close(fd)

    def test_pid_reused_by_another_start_during_binding_is_rejected_and_closed(self):
        write_process(self.proc, 20, '4242')
        opener = Opener(reuse=lambda: write_process(self.proc, 20, '9999'))
        with self.assertRaisesRegex(RuntimeError, 'changed during binding'):
            deadline.bind_owned_pidfd(CID, 20, self.proc, opener)
        with self.assertRaises(OSError):
            os.fstat(opener.opened[0])

    def test_pid_reused_by_another_container_during_binding_is_rejected(self):
        write_process(self.proc, 20, '4242')
        opener = Opener(reuse=lambda: write_process(self.proc, 20, '4242', '/docker/' + 'd' * 64))
        with self.assertRaises(RuntimeError):
            deadline.bind_owned_pidfd(CID, 20, self.proc, opener)


class GuardArming(unittest.TestCase):
    """The real guard main and supervision: a start change after inspection is never armed."""
    def run_guard(self, starts, remaining=5, bind=None):
        written, signalled = [], []
        observed = iter(starts)
        read, write = os.pipe()
        os.close(write)

        def fake_write(fd, data):
            written.append(json.loads(data))
            return len(data)
        argv = ['guard', CID, '20', '9', '5', repr(time.monotonic() + remaining), 'boot', OPERATION]
        with patch.object(sys, 'argv', argv), patch.object(guard.os, 'geteuid', return_value=0), \
                patch.object(guard.os, 'write', side_effect=fake_write), \
                patch.object(guard, 'Path', side_effect=lambda value: type('P', (), {'read_text': lambda self: 'boot\n'})() if 'boot_id' in str(value) else Path(value)), \
                patch.object(guard, 'cgroup_directory', return_value=Path('/x')), \
                patch.object(guard, 'members', return_value=[5, 20]), \
                patch.object(guard, 'identity', side_effect=lambda pid: (next(observed), 9)), \
                patch.object(guard, 'bind_owned_pidfd', side_effect=bind or (lambda container, pid: read)), \
                patch.object(guard.signal, 'pidfd_send_signal', side_effect=lambda fd, sig: signalled.append(fd), create=True), \
                patch.object(guard, 'retired', return_value=True):
            try:
                guard.main()
                code = 0
            except SystemExit as error:
                code = error.code
        return code, written, signalled, read

    def test_start_identity_changed_between_inspection_and_binding_is_never_armed_or_signalled(self):
        code, written, signalled, fd = self.run_guard(['4242', '9999'])
        self.assertEqual(code, 1)
        self.assertEqual(written, [{'kind': 'error', 'category': 'deadline-guard-failed'}])
        self.assertEqual(signalled, [])
        with self.assertRaises(OSError):
            os.fstat(fd)

    def test_unchanged_start_identity_arms_with_that_start(self):
        code, written, _, _ = self.run_guard(['4242', '4242'])
        self.assertEqual(code, 0)
        self.assertEqual(written[0], {'kind': 'armed', 'operation': OPERATION, 'start': '4242'})

    # #67: the controller admits only after the armed record, so a deadline that
    # expires before arming leaves the process waiting at its startup gate.
    def test_deadline_expired_before_arming_retires_the_unadmitted_process(self):
        code, written, signalled, fd = self.run_guard(['4242', '4242'], remaining=-.05)
        self.assertEqual(code, 0)
        self.assertEqual(len(written), 1)
        self.assertEqual(written[0]['kind'], 'result')
        self.assertEqual(written[0]['outcome'], 'unadmitted')
        self.assertEqual((written[0]['operation'], written[0]['start']), (OPERATION, '4242'))
        self.assertIs(written[0]['physical_exit_confirmed'], True)
        self.assertIs(written[0]['retired'], True)
        self.assertEqual(signalled, [fd])
        # Lateness is measured from the operation deadline, under the usual gate.
        self.assertGreaterEqual(written[0]['kill_lateness_ms'], 50)
        self.assertGreaterEqual(written[0]['physical_exit_lateness_ms'], written[0]['kill_lateness_ms'])
        self.assertLessEqual(written[0]['physical_exit_lateness_ms'], 250)

    def test_unadmitted_retirement_after_the_tolerance_is_late_termination(self):
        code, written, _, _ = self.run_guard(['4242', '4242'], remaining=-1)
        self.assertEqual(code, 0)
        self.assertEqual(written[-1]['outcome'], 'late-termination')
        self.assertGreaterEqual(written[-1]['kill_lateness_ms'], 1000)

    # Uncertain ownership is never reported as an unadmitted retirement.
    def test_expired_arming_never_signals_a_changed_start_identity(self):
        code, written, signalled, _ = self.run_guard(['4242', '9999'], remaining=-.05)
        self.assertEqual(signalled, [])
        self.assertEqual(code, 1)
        self.assertEqual(written, [{'kind': 'error', 'category': 'deadline-guard-failed'}])

    def test_expired_arming_that_cannot_bind_its_process_is_uncertain(self):
        def gone(container, pid):
            raise RuntimeError('worker identity unverified')
        code, written, signalled, _ = self.run_guard(['4242'], remaining=-.05, bind=gone)
        self.assertEqual(signalled, [])
        self.assertEqual(code, 1)
        self.assertEqual(written, [{'kind': 'error', 'category': 'deadline-guard-failed'}])


if __name__ == '__main__':
    unittest.main()

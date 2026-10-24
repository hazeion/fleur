"""Deterministic native retirement race regressions; no Docker or Linux required."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixtures = load('review_controller_fixtures', ROOT / 'tests/runtime/review-native-controller.test.py')
controller = fixtures.controller
guard = load('review_deadline_guard', ROOT / 'src/runtime/native/worker_deadline.py')


class RetirementRaces(unittest.TestCase):
    def test_completion_frame_does_not_cancel_worker_before_its_immediate_zero_exit(self):
        worker, watchdog, output = fixtures.Process(), fixtures.Process(), fixtures.Pipe()
        worker.returncode = None
        inventory = [{'fd': 3, 'kind': 'eventfd'}, {'fd': 4, 'kind': 'eventpoll'}]
        threads = [{'pid': pid, 'no_new_privs': 1, 'seccomp': 2, 'seccomp_filters': 1} for pid in [1, 2]]
        line_count = 0

        def line(stream, limit, deadline):
            nonlocal line_count
            line_count += 1
            if line_count == 1:
                return controller.json.dumps({'kind': 'startup-audit', 'inventory': inventory})
            if line_count == 2:
                return '{"kind":"armed"}'
            # The worker has emitted its final bytes but has not yet executed
            # exit_group(0). Closing control here causes the actual guard to kill it.
            cancelled = watchdog.stdin.closed
            worker.returncode = 137 if cancelled else 0
            return controller.json.dumps({'kind': 'result', 'physical_exit_confirmed': True,
                'outcome': 'cancelled' if cancelled else 'premature-exit',
                'kill_lateness_ms': 0, 'physical_exit_lateness_ms': 0})

        with patch.object(controller.sys, 'argv', ['controller', 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64, '00000000-0000-0000-0000-000000000000']), \
             patch.object(controller.sys, 'stdout', SimpleNamespace(buffer=output)), \
             patch.object(controller.sys, 'stdin', SimpleNamespace(buffer=fixtures.Pipe())), \
             patch.object(controller.Path, 'read_text', return_value='owned-boot'), \
             patch.object(controller.subprocess, 'Popen', side_effect=[worker, watchdog]), \
             patch.object(controller, 'inspect_worker_configuration', return_value={'container_id': 'c' * 64, 'host_init_pid': 123}), \
             patch.object(controller, 'inspect_threads', return_value=threads), \
             patch.object(controller, 'inspect_event_inventory', return_value={'passed': True, 'category': 'verified', 'descriptor_count': 2}), \
             patch.object(controller, 'audit_guard', return_value='d' * 64), \
             patch.object(controller, 'owned_remove'), \
             patch.object(controller, 'line', side_effect=line), \
             patch.object(controller, 'frame', side_effect=[
                 {'budgetMs': 5000, 'command': {'mode': 'register'}},
                 {'kind': 'admit', 'value': None},
                 {'kind': 'complete'},
                 {'kind': 'finish', 'value': None},
             ]):
            controller.main()
        self.assertEqual(worker.returncode, 0)
        self.assertIn(b'"kind":"retired"', output.data)
        self.assertNotIn(b'"kind":"failure"', output.data)

    def supervise_eof(self, wake):
        now, calls, records, kills, closed = [9.0], [], [], [], []

        def select(read, write, exceptional, timeout):
            calls.append(timeout)
            if len(calls) == 1:
                now[0] = wake
                return [99], [], []
            now[0] = wake + .003
            return [42], [], []

        with patch.object(guard.time, 'monotonic', side_effect=lambda: now[0]), \
             patch.object(guard.select, 'select', side_effect=select), \
             patch.object(guard.os, 'read', return_value=b''):
            guard.supervise('a' * 64, 123, 10.0, lambda cid, pid: 42,
                            kills.append, closed.append, 99, records.append)
        self.assertEqual(kills, [42])
        self.assertEqual(closed, [42])
        self.assertTrue(records[-1]['physical_exit_confirmed'])
        return records[-1], calls[-1]

    def test_eof_at_deadline_is_deadline_enforcement_not_cancellation(self):
        result, _ = self.supervise_eof(10.0)
        self.assertEqual(result['outcome'], 'deadline')

    def test_eof_after_deadline_does_not_extend_termination_tolerance(self):
        result, remaining = self.supervise_eof(10.005)
        self.assertLessEqual(remaining, .245 + 1e-9)
        self.assertEqual(result['outcome'], 'deadline')
        self.assertEqual(result['kill_lateness_ms'], 5)

    def test_eof_before_deadline_still_cancels_the_owned_worker(self):
        result, _ = self.supervise_eof(9.5)
        self.assertEqual(result['outcome'], 'cancelled')

    def test_natural_exit_observed_after_tolerance_is_not_zero_lateness_success(self):
        now, records, kills = [9.0], [], []

        def select(read, write, exceptional, timeout):
            now[0] = 10.300
            return [42], [], []

        with patch.object(guard.time, 'monotonic', side_effect=lambda: now[0]), \
             patch.object(guard.select, 'select', side_effect=select):
            guard.supervise('a' * 64, 123, 10.0, lambda cid, pid: 42,
                            kills.append, lambda fd: None, 99, records.append)
        self.assertEqual(kills, [])
        self.assertTrue(records[-1]['physical_exit_confirmed'])
        self.assertEqual(records[-1]['outcome'], 'late-termination')
        self.assertEqual(records[-1]['physical_exit_lateness_ms'], 300)


if __name__ == '__main__':
    unittest.main()

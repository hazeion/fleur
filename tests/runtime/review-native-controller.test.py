"""Independent startup gate tests against the actual controller entry point."""
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'src/runtime/native/controller.py'
spec = importlib.util.spec_from_file_location('review_native_controller', SOURCE)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class Pipe:
    def __init__(self):
        self.data = bytearray()
        self.closed = False

    def write(self, data):
        self.data.extend(data)
        return len(data)

    def flush(self):
        pass

    def close(self):
        self.closed = True


class Process:
    def __init__(self):
        self.stdin, self.stdout = Pipe(), Pipe()
        self.returncode = 0

    def wait(self, timeout=None):
        return 0


class DescriptorAdmission(unittest.TestCase):
    def test_failed_host_descriptor_audit_never_approves_application_entry(self):
        worker, guard = Process(), Process()
        inventory = [{'fd': 3, 'kind': 'eventfd'}, {'fd': 4, 'kind': 'eventpoll'}]
        threads = [{'pid': pid, 'no_new_privs': 1, 'seccomp': 2, 'seccomp_filters': 1} for pid in [1, 2]]
        with patch.object(controller.sys, 'argv', ['controller', 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64, '00000000-0000-0000-0000-000000000000']), \
             patch.object(controller.sys, 'stdout', SimpleNamespace(buffer=Pipe())), \
             patch.object(controller.sys, 'stdin', SimpleNamespace(buffer=Pipe())), \
             patch.object(controller.Path, 'read_text', return_value='owned-boot'), \
             patch.object(controller.subprocess, 'Popen', side_effect=[worker, guard]), \
             patch.object(controller, 'inspect_worker_configuration', return_value={'container_id': 'c' * 64, 'host_init_pid': 123}), \
             patch.object(controller, 'inspect_threads', return_value=threads), \
             patch.object(controller, 'inspect_event_inventory', return_value={'passed': False, 'category': 'class-mismatch'}), \
             patch.object(controller, 'owned_remove'), \
             patch.object(controller, 'line', side_effect=[
                 '{"kind":"startup-audit","pid":1,"inventory":' + controller.json.dumps(inventory) + '}',
                 '{"kind":"armed"}',
                 '{"physical_exit_confirmed":true,"outcome":"cancelled"}',
             ]), \
             patch.object(controller, 'frame', side_effect=[
                 {'budgetMs': 5000, 'command': {'mode': 'register'}},
                 {'kind': 'admit', 'value': None},
                 {'kind': 'complete'},
                 {'kind': 'finish', 'value': None},
             ]):
            controller.main()
        self.assertNotIn(b'startup:approved\n', worker.stdin.data)

    def test_final_frame_followed_by_nonzero_worker_exit_is_not_success(self):
        worker, guard, output = Process(), Process(), Pipe()
        worker.returncode = 42
        inventory = [{'fd': 3, 'kind': 'eventfd'}, {'fd': 4, 'kind': 'eventpoll'}]
        threads = [{'pid': pid, 'no_new_privs': 1, 'seccomp': 2, 'seccomp_filters': 1} for pid in [1, 2]]
        with patch.object(controller.sys, 'argv', ['controller', 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64, '00000000-0000-0000-0000-000000000000']), \
             patch.object(controller.sys, 'stdout', SimpleNamespace(buffer=output)), \
             patch.object(controller.sys, 'stdin', SimpleNamespace(buffer=Pipe())), \
             patch.object(controller.Path, 'read_text', return_value='owned-boot'), \
             patch.object(controller.subprocess, 'Popen', side_effect=[worker, guard]), \
             patch.object(controller, 'inspect_worker_configuration', return_value={'container_id': 'c' * 64, 'host_init_pid': 123}), \
             patch.object(controller, 'inspect_threads', return_value=threads), \
             patch.object(controller, 'inspect_event_inventory', return_value={'passed': True, 'category': 'verified', 'descriptor_count': 2}), \
             patch.object(controller, 'audit_guard', return_value='d' * 64), \
             patch.object(controller, 'owned_remove'), \
             patch.object(controller, 'line', side_effect=[
                 '{"kind":"startup-audit","pid":1,"inventory":' + controller.json.dumps(inventory) + '}',
                 '{"kind":"armed"}',
                 '{"physical_exit_confirmed":true,"outcome":"premature-exit","kill_lateness_ms":0,"physical_exit_lateness_ms":0}',
             ]), \
             patch.object(controller, 'frame', side_effect=[
                 {'budgetMs': 5000, 'command': {'mode': 'register'}},
                 {'kind': 'admit', 'value': None},
                 {'kind': 'complete'},
                 {'kind': 'finish', 'value': None},
             ]):
            controller.main()
        self.assertNotIn(b'"kind":"retired"', output.data)
        self.assertIn(b'"kind":"failure"', output.data)

    def test_final_frame_followed_by_zero_worker_exit_is_success(self):
        worker, guard, output = Process(), Process(), Pipe()
        worker.returncode = 0
        inventory = [{'fd': 3, 'kind': 'eventfd'}, {'fd': 4, 'kind': 'eventpoll'}]
        threads = [{'pid': pid, 'no_new_privs': 1, 'seccomp': 2, 'seccomp_filters': 1} for pid in [1, 2]]
        with patch.object(controller.sys, 'argv', ['controller', 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64, '00000000-0000-0000-0000-000000000000']), \
             patch.object(controller.sys, 'stdout', SimpleNamespace(buffer=output)), \
             patch.object(controller.sys, 'stdin', SimpleNamespace(buffer=Pipe())), \
             patch.object(controller.Path, 'read_text', return_value='owned-boot'), \
             patch.object(controller.subprocess, 'Popen', side_effect=[worker, guard]), \
             patch.object(controller, 'inspect_worker_configuration', return_value={'container_id': 'c' * 64, 'host_init_pid': 123}), \
             patch.object(controller, 'inspect_threads', return_value=threads), \
             patch.object(controller, 'inspect_event_inventory', return_value={'passed': True, 'category': 'verified', 'descriptor_count': 2}), \
             patch.object(controller, 'audit_guard', return_value='d' * 64), \
             patch.object(controller, 'owned_remove'), \
             patch.object(controller, 'line', side_effect=[
                 '{"kind":"startup-audit","pid":1,"inventory":' + controller.json.dumps(inventory) + '}',
                 '{"kind":"armed"}',
                 '{"physical_exit_confirmed":true,"outcome":"premature-exit","kill_lateness_ms":0,"physical_exit_lateness_ms":0}',
             ]), \
             patch.object(controller, 'frame', side_effect=[
                 {'budgetMs': 5000, 'command': {'mode': 'register'}},
                 {'kind': 'admit', 'value': None},
                 {'kind': 'complete'},
                 {'kind': 'finish', 'value': None},
             ]):
            controller.main()
        self.assertIn(b'"kind":"retired"', output.data)
        self.assertNotIn(b'"kind":"failure"', output.data)


if __name__ == '__main__':
    unittest.main()

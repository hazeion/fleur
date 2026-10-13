import json
import subprocess
import unittest
from ownership import OwnedContainer, LABEL


class OwnershipTests(unittest.TestCase):
    def scenario(self, launch_fault, matching=True):
        events = []
        def daemon(arguments):
            events.append(arguments)
            if arguments[1] == 'run':
                if launch_fault == 'timeout':
                    raise subprocess.TimeoutExpired(arguments, 1)
                return subprocess.CompletedProcess(arguments, 1, '', 'client exited after creation')
            if arguments[1] == 'inspect':
                row = {'Name': '/owned-probe', 'Config': {'Labels': {LABEL: 'ours' if matching else 'someone-else'}}}
                return subprocess.CompletedProcess(arguments, 0, json.dumps([row]), '')
            return subprocess.CompletedProcess(arguments, 0, '', '')
        owned = OwnedContainer(daemon, 'owned-probe', 'ours')
        try:
            owned.launch(['docker', 'run'])
        except subprocess.TimeoutExpired:
            pass
        return owned, events

    def test_timeout_after_creation_still_verifies_and_cleans_owned_container(self):
        owned, events = self.scenario('timeout')
        self.assertTrue(owned.cleanup())
        self.assertEqual([item[1] for item in events], ['run', 'inspect', 'rm'])

    def test_error_after_creation_still_verifies_and_cleans_owned_container(self):
        owned, events = self.scenario('error')
        self.assertTrue(owned.cleanup())
        self.assertEqual([item[1] for item in events], ['run', 'inspect', 'rm'])

    def test_uncertain_launch_never_removes_a_container_owned_by_someone_else(self):
        owned, events = self.scenario('timeout', matching=False)
        with self.assertRaisesRegex(RuntimeError, 'ownership mismatch'):
            owned.cleanup()
        self.assertEqual([item[1] for item in events], ['run', 'inspect'])


if __name__ == '__main__':
    unittest.main()

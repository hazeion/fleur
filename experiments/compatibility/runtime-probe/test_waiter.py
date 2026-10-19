"""Exit notification requirements at a real external CLI process boundary."""
from contextlib import contextmanager
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from waiter import OwnedWaiter, WaitUnverified

CONTAINER_ID = 'a' * 64

@contextmanager
def cli_fixture(body):
    with tempfile.TemporaryDirectory(prefix='fleur-wait-cli-') as temporary:
        root = Path(temporary)
        executable = root / 'docker'
        executable.write_text('#!' + sys.executable + '\nimport os, sys, time\n'
                              + 'assert sys.argv[1:] == ["wait", "' + CONTAINER_ID + '"]\n'
                              + body)
        executable.chmod(0o700)
        yield str(executable), root

class WaitNotification(unittest.TestCase):
    def finished(self, waiter):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            result = waiter.completion(deadline - time.monotonic())
            if result['completed']:
                return result
            time.sleep(0.01)
        self.fail('fixture completion not observed within test bound')

    def test_zero_notification_requires_actual_cli_exit(self):
        with cli_fixture('os.write(1,b"0\\n")\ntime.sleep(0.15)\n') as (docker, _):
            waiter = OwnedWaiter(CONTAINER_ID, timeout=2, docker=docker)
            try:
                self.assertEqual(waiter.completion(2), {'completed': False})
                self.assertEqual(self.finished(waiter), {'completed': True, 'exit_code': 0})
            finally:
                waiter.close()

    def test_nonzero_malformed_unknown_and_stderr_cannot_pass(self):
        for body in ('os.write(1,b"137\\n")\n', 'os.write(1,b"0\\n0\\n")\n',
                     'os.write(1,b"0")\n', 'os.write(1,b"x"*100)\n',
                     'os.write(1,b"0\\n")\nsys.exit(2)\n',
                     'os.write(2,b"unknown container")\nsys.exit(1)\n',
                     'os.write(1,b"0\\n")\nos.write(2,b"private stderr")\n'):
            with self.subTest(body=body), cli_fixture(body) as (docker, _):
                waiter = OwnedWaiter(CONTAINER_ID, timeout=2, docker=docker)
                try:
                    with self.assertRaises(WaitUnverified) as caught:
                        self.finished(waiter)
                    self.assertNotIn('private', str(caught.exception))
                    self.assertNotIn('unknown container', str(caught.exception.observations))
                finally:
                    waiter.close()

    def test_no_response_expires_original_budget_and_close_reaps_child(self):
        with cli_fixture('time.sleep(60)\n') as (docker, root):
            executable = Path(docker)
            executable.write_text(executable.read_text().replace('time.sleep(60)',
                'open(' + repr(str(root/'pid')) + ',"w").write(str(os.getpid()))\ntime.sleep(60)'))
            waiter = OwnedWaiter(CONTAINER_ID, timeout=0.2, docker=docker)
            startup = time.monotonic() + 1
            while not (root/'pid').exists() and time.monotonic() < startup:
                time.sleep(0.01)
            pid = int((root/'pid').read_text())
            time.sleep(0.21)
            with self.assertRaises(WaitUnverified):
                waiter.completion(10)  # A later caller cannot extend the original budget.
            started = time.monotonic()
            waiter.close()
            self.assertLess(time.monotonic() - started, 1.1)
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            waiter.close()  # Idempotent owned cleanup.

    def test_invalid_identity_and_budget_fail_before_launch(self):
        for identity, budget in (('name',1), ('a'*63,1), ('A'*64,1), (CONTAINER_ID,0),
                                 (CONTAINER_ID,True), (CONTAINER_ID,float('inf'))):
            with self.subTest(identity=identity,budget=budget), self.assertRaises(WaitUnverified):
                OwnedWaiter(identity, timeout=budget, docker='/does/not/exist')

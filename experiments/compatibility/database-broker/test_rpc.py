import os
import sys
import time
import unittest
from rpc import TrustedBroker


class RPCTests(unittest.TestCase):
    def broker(self, program, timeout=0.2):
        return TrustedBroker([sys.executable, '-u', '-S', '-c', program], None, os.environ.copy(), timeout)

    def test_registered_validated_response_admits_only_native_projection(self):
        broker = self.broker("import sys;sys.stdin.readline();print('{\"kind\":\"broker-response\",\"ok\":true,\"value\":{\"id\":1,\"name\":\"Squat\",\"version\":1}}')")
        try:
            self.assertEqual(broker.dispatch({'kind': 'request'}), {'kind': 'broker-response', 'ok': True, 'value': {'id': 1, 'name': 'Squat'}})
        finally:
            broker.close()

    def test_silent_trusted_process_has_its_own_deadline_and_is_terminated(self):
        broker = self.broker('import time;time.sleep(30)')
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'failed closed'):
            broker.dispatch({'kind': 'request'})
        self.assertLess(time.monotonic() - started, 2)
        self.assertIsNotNone(broker.process.poll())

    def test_oversized_reply_is_rejected_and_process_is_terminated(self):
        broker = self.broker("import sys;sys.stdin.readline();print('x'*4097)")
        with self.assertRaisesRegex(RuntimeError, 'failed closed'):
            broker.dispatch({'kind': 'request'})
        self.assertIsNotNone(broker.process.poll())


if __name__ == '__main__':
    unittest.main()

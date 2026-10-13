import os
import sys
import unittest
from execution import run_check


class ExecutionTests(unittest.TestCase):
    def test_actual_timeout_preserves_case_and_redacts_partial_byte_output(self):
        row = run_check('case-one', [sys.executable, '-u', '-c', "import time;print('case-one credential-fixture');time.sleep(30)"],
                        None, os.environ.copy(), 0.2, [('credential-fixture', '<redacted>')])
        self.assertEqual(row['status'], 'timeout')
        self.assertFalse(row['passed'])
        self.assertIn('case-one', row['output_excerpt'])
        self.assertIn('<redacted>', row['output_excerpt'])
        self.assertNotIn('credential-fixture', row['output_excerpt'])


if __name__ == '__main__':
    unittest.main()

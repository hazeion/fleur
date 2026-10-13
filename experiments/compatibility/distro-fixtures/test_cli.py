"""Public prerequisites must fail before any container or downloads exist."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DRIVER = Path(__file__).with_name('run.py')

class Prerequisites(unittest.TestCase):
    def test_wrong_native_architecture_cannot_pass(self):
        import platform
        native = platform.machine()
        target = 'debian-arm64' if native in ('x86_64', 'AMD64') else 'debian-amd64'
        with tempfile.TemporaryDirectory() as out:
            result = subprocess.run([sys.executable, str(DRIVER), '--target', target,
                                     '--out', out], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            report = json.loads(result.stdout)
            self.assertFalse(report['passed'])
            self.assertFalse(report['v1_gate_passed'])
            self.assertEqual(report['failure_stage'], 'native Linux host')
            self.assertEqual(report['commands'], [])

if __name__ == '__main__':
    unittest.main()

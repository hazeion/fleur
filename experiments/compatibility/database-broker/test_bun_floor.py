"""The driver must admit exactly the release floor the shared record declares."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class FloorAdmission(unittest.TestCase):
    def test_runtime_differing_from_the_record_is_rejected_and_names_the_record_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'scripts').mkdir()
            (root/'scripts'/'bun-floor.json').write_text(json.dumps({'version': '9.9.9'}))
            driver = root/'experiments/compatibility/database-broker'
            shutil.copytree(HERE, driver, ignore=shutil.ignore_patterns('__pycache__', 'node_modules'))
            bun = root/'fake-bun'
            bun.write_text('#!/bin/sh\necho 9.9.8\n')
            bun.chmod(0o700)
            result = subprocess.run([sys.executable, '-B', str(driver/'run.py'), '--bun', str(bun)],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertEqual(json.loads(result.stdout)['failure'], 'Bun 9.9.9 required')


if __name__ == '__main__':
    unittest.main()

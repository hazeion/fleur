"""The driver must obtain the release floor in every layout it actually executes from."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
RECORD = 'bun-floor.json'


class ExecutedLayouts(unittest.TestCase):
    def expected_bun(self, root, probe):
        shutil.copytree(HERE, root/probe, ignore=shutil.ignore_patterns('__pycache__'))
        return subprocess.run(
            [sys.executable, '-I', '-B', '-c',
             'import sys;sys.path.insert(0,sys.argv[1]);import run;print(run.REPORT["expected_bun"])', str(root/probe)],
            capture_output=True, text=True, timeout=30)

    def test_checkout_reads_the_scripts_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'scripts').mkdir()
            (root/'scripts'/RECORD).write_text(json.dumps({'version': '9.9.9'}))
            observed = self.expected_bun(root, 'experiments/compatibility/runtime-probe')
            self.assertEqual(observed.stdout.strip(), '9.9.9', observed.stderr)

    def test_fresh_linux_lab_reads_the_record_the_host_staged_beside_the_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)/'lab'
            root.mkdir()
            (root/RECORD).write_text(json.dumps({'version': '9.9.8'}))
            observed = self.expected_bun(root, 'experiments/compatibility/runtime-probe')
            self.assertEqual(observed.stdout.strip(), '9.9.8', observed.stderr)

    def test_desktop_controller_reads_the_record_in_its_source_closure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)/'controller'
            root.mkdir()
            (root/RECORD).write_text(json.dumps({'version': '9.9.7'}))
            observed = self.expected_bun(root, 'runtime-probe')
            self.assertEqual(observed.stdout.strip(), '9.9.7', observed.stderr)

    def test_missing_record_fails_instead_of_assuming_a_version(self):
        with tempfile.TemporaryDirectory() as directory:
            observed = self.expected_bun(Path(directory), 'runtime-probe')
            self.assertNotEqual(observed.returncode, 0, observed.stdout)
            self.assertIn('Bun floor record unavailable', observed.stderr)


if __name__ == '__main__':
    unittest.main()

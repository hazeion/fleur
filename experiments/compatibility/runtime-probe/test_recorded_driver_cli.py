"""Actual experimental CLI refusals; no compiler/Docker or native-positive fixture."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class RecordedDriverCli(unittest.TestCase):
    def test_artifact_path_alone_never_authorizes_recorded_mode(self):
        with tempfile.TemporaryDirectory(prefix='fleur-recorded-cli-') as directory:
            # Empty PATH prevents any accidental compiler/container command execution.
            environment={'PATH':directory, 'HOME':directory, 'TMPDIR':directory}
            observed=subprocess.run([sys.executable, str(Path(__file__).with_name('run.py')),
                                     '--recorded-helper-artifacts', str(Path(directory)/'absent')],
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                    env=environment, timeout=5, check=False)
            self.assertEqual(observed.returncode, 1)
            self.assertEqual(observed.stderr, '')
            report=json.loads(observed.stdout)
            self.assertEqual(report['failure'], 'recorded helpers require original owned guest context')
            self.assertFalse(report['bounded_probe_passed'])
            self.assertFalse(report['v1_gate_passed'])
            self.assertNotIn('gcc', report)


if __name__ == '__main__':
    unittest.main()

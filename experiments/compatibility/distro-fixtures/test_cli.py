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

class CleanupReporting(unittest.TestCase):
    def test_cleanup_launch_errors_preserve_report_and_continue_other_owned_cleanup(self):
        # Run the public CLI with a synthetic Docker process boundary. No daemon,
        # downloaded runtime or fixture result is represented as passing.
        script = r'''import json, os, platform, runpy, shutil, subprocess, sys
from pathlib import Path
original_read = Path.read_text
Path.read_text = lambda self, *a, **kw: 'ID=ubuntu\nVERSION_ID=24.04\n' if str(self) == '/etc/os-release' else original_read(self, *a, **kw)
platform.system = lambda: "Linux"
platform.machine = lambda: "x86_64"
shutil.which = lambda name: "/synthetic/docker"
owner = None

def boundary(command, **kwargs):
    global owner
    action = command[1:3]
    if action == ["version", "--format"]:
        return subprocess.CompletedProcess(command, 0, json.dumps({"Server":{"Os":"linux", "Arch":"amd64"}}), "")
    if command[1] == "build":
        with open(os.path.join(command[-1], "Dockerfile")) as source:
            owner = source.read().split('owner="')[1].split('"')[0]
        return subprocess.CompletedProcess(command, 0, "built", "")
    if action == ["image", "inspect"]:
        metadata = {"Architecture":"amd64", "Config":{"Labels":{"dev.fleur.compatibility.owner":owner}}}
        return subprocess.CompletedProcess(command, 0, json.dumps([metadata]), "")
    if command[1] == "create":
        return subprocess.CompletedProcess(command, 0, "created", "")
    if command[1] == "start":
        raise subprocess.TimeoutExpired(command, 1)
    if command[1] == "cp":
        return subprocess.CompletedProcess(command, 1, "", "fixture evidence unavailable")
    if action in (["container", "inspect"], ["image", "rm"]):
        raise FileNotFoundError("private path must not appear in evidence")
    raise AssertionError(command)

subprocess.run = boundary
sys.argv = [sys.argv[1], "--target", "debian-amd64", "--out", sys.argv[2]]
runpy.run_path(sys.argv[0], run_name="__main__")
'''
        with tempfile.TemporaryDirectory() as out:
            result = subprocess.run([sys.executable, '-c', script, str(DRIVER), out],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report, json.loads((Path(out) / 'driver.json').read_text()))
            self.assertFalse(report['passed'])
            self.assertFalse(report['v1_gate_passed'])
            rows = {row['name']: row for row in report['commands']}
            for name in ('cleanup-inspect-container', 'cleanup-image'):
                self.assertIsNone(rows[name]['exit_code'])
                self.assertEqual(rows[name]['error_class'], 'FileNotFoundError')
                self.assertNotIn('private path', (Path(out) / (name + '.txt')).read_text())
            self.assertIn('cleanup-inspect-image', rows)
            self.assertEqual(len(report['cleanup_errors']), 2)

if __name__ == '__main__':
    unittest.main()

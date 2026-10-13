"""Requirements tests for the experiment's public diagnostic CLI, not isolation proof."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("preflight.py")


class IsolationPreflightTests(unittest.TestCase):
    def run_preflight(self, *args, path=""):
        env = {"PATH": path}
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args], env=env,
            text=True, capture_output=True, timeout=20,
        )
        self.assertEqual(result.stderr, "")
        return result.returncode, json.loads(result.stdout)

    def test_missing_tools_report_blocked_without_application_evaluation(self):
        code, report = self.run_preflight()
        self.assertEqual(code, 2)
        self.assertEqual(report["gate"], "blocked")
        self.assertFalse(report["applicationEvaluated"])
        self.assertIn("docker-missing", report["blockers"])
        self.assertIn("image-pin-missing", report["blockers"])

    def test_mutable_image_tag_is_rejected(self):
        code, report = self.run_preflight("--image", "oven/bun:1.4.3")
        self.assertEqual(code, 2)
        self.assertIn("image-pin-invalid", report["blockers"])

    def test_available_daemon_and_local_pinned_image_are_not_security_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "calls.jsonl"
            docker = root / "docker"
            docker.write_text(
                f"#!{sys.executable}\n"
                "import json, sys\n"
                f"with open({str(log)!r}, 'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n"
                "if sys.argv[1] == 'version':\n"
                " print(json.dumps({'Version':'29.0.0','Os':'linux','Arch':'amd64'}))\n"
                "elif sys.argv[1:3] == ['image','inspect']:\n"
                " print('linux/amd64')\n"
                "else: sys.exit(99)\n"
            )
            docker.chmod(0o755)
            code, report = self.run_preflight(
                "--image", "oven/bun@sha256:" + "a" * 64, path=directory,
            )
            self.assertEqual(code, 2)
            self.assertEqual(report["gate"], "blocked")
            self.assertIn("pre-evaluation-bootstrap-unverified", report["blockers"])
            self.assertIn("negative-syscall-and-broker-tests-unexecuted", report["blockers"])
            self.assertFalse(report["applicationEvaluated"])
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual([call[0] for call in calls], ["version", "image"])

    def test_unavailable_daemon_is_reported_without_leaking_raw_error(self):
        with tempfile.TemporaryDirectory() as directory:
            docker = Path(directory) / "docker"
            docker.write_text(f"#!{sys.executable}\nimport sys\nprint('private diagnostic', file=sys.stderr)\nsys.exit(1)\n")
            docker.chmod(0o755)
            code, report = self.run_preflight(path=directory)
            self.assertEqual(code, 2)
            self.assertIn("docker-unavailable", report["blockers"])
            self.assertNotIn("private diagnostic", json.dumps(report))


if __name__ == "__main__":
    unittest.main()

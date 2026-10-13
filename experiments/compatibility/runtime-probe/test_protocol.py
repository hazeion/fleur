"""Exercise trusted dispatch and real pipe transport at their public boundaries."""
import json
import subprocess
import sys
import unittest
from protocol import REQUEST, fixture_dispatch, run_container

class Protocol(unittest.TestCase):
    def test_only_registered_operation_and_typed_input_are_admitted(self):
        self.assertEqual(fixture_dispatch(REQUEST)["value"], {"id": 1, "name": "Squat"})
        for changed in (dict(REQUEST, action="sql"), dict(REQUEST, token="other"),
                        dict(REQUEST, input={"id": True}), dict(REQUEST, sql="SELECT 1"),
                        dict(REQUEST, input={"id": 1, "url": "https://example.com"})):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                fixture_dispatch(changed)

    def test_actual_worker_pipe_receives_registered_reply(self):
        source = "import json,sys; print(" + repr(json.dumps(REQUEST)) + ",flush=True); reply=sys.stdin.readline(); print(json.dumps({'reply':reply.strip()}))"
        for _ in range(2):
            output = run_container([sys.executable, "-u", "-c", source])
            self.assertEqual(json.loads(output), {"reply": "registered:Squat"})

    def test_stuck_worker_does_not_escape_deadline(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            run_container([sys.executable, "-u", "-c", "import time; time.sleep(30)"], timeout=0.1)

    def test_malformed_success_reply_cannot_be_worker_evidence(self):
        source = "import json,sys; print(" + repr(json.dumps(REQUEST)) + ",flush=True); print(sys.stdin.readline())"
        bad = {"kind":"broker-response", "ok":True, "value":{"id":True,"name":"Squat"}}
        with self.assertRaises(RuntimeError):
            run_container([sys.executable, "-u", "-c", source], dispatch=lambda _: bad)

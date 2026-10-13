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

    def test_observer_runs_at_pipe_pause_before_dispatch_and_ack(self):
        source = "import json,sys; print(" + repr(json.dumps(REQUEST)) + ",flush=True); print(json.dumps({'reply':sys.stdin.readline().strip()}))"
        events = []
        def observe(request):
            self.assertEqual(request,REQUEST)
            events.append('observed')
        def dispatch(request):
            self.assertEqual(events,['observed'])
            events.append('dispatched')
            return fixture_dispatch(request)
        output = run_container([sys.executable,'-u','-c',source],dispatch=dispatch,observer=observe)
        self.assertEqual(json.loads(output),{'reply':'registered:Squat'})
        self.assertEqual(events,['observed','dispatched'])

    def test_timeout_preserves_bounded_post_ack_stage_output(self):
        source = "printf '%s\\n' \"$1\"; IFS= read -r reply; printf '[DEBUG-runtime] file-promise-created\\n' >&2; printf 'partial-evidence\\n'; exec /bin/sleep 30"
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            run_container(['/bin/sh','-c',source,'fixture',json.dumps(REQUEST)],timeout=0.2)
        self.assertIn(b'file-promise-created',caught.exception.stderr or b'')
        self.assertIn(b'partial-evidence',caught.exception.output or b'')

    def test_pre_request_stderr_is_drained_and_retained_without_changing_ack(self):
        source = "import json,sys; print('[DEBUG-runtime] loader-ready',file=sys.stderr,flush=True); print(" + repr(json.dumps(REQUEST)) + ",flush=True); print(json.dumps({'reply':sys.stdin.readline().strip()}))"
        diagnostics = {}
        output = run_container([sys.executable,'-u','-c',source],diagnostics=diagnostics)
        self.assertEqual(json.loads(output),{'reply':'registered:Squat'})
        self.assertIn('loader-ready',diagnostics['stderr'])
        self.assertEqual(diagnostics['timeout_seconds'],30)
        self.assertLessEqual(len(diagnostics['stderr'].encode()),4096)

    def test_pre_request_timeout_retains_stage_and_classifies_phase(self):
        source = "printf '[DEBUG-runtime] prepare-start\\n' >&2; exec /bin/sleep 30"
        diagnostics = {}
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            run_container(['/bin/sh','-c',source],timeout=0.2,diagnostics=diagnostics)
        self.assertIn(b'prepare-start',caught.exception.stderr)
        self.assertEqual(caught.exception.protocol_phase,'waiting-broker-request')
        self.assertEqual(diagnostics['protocol_phase'],'waiting-broker-request')

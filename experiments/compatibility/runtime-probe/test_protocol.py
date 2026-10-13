"""Exercise trusted dispatch and real pipe transport at their public boundaries."""
import contextlib
import json
import selectors
import subprocess
import sys
import unittest
from unittest.mock import patch
from protocol import REQUEST, StartupAuditRejected, fixture_dispatch, run_container

@contextlib.contextmanager
def ready_transport(args, channel):
    # Only evidence-preservation tests exclude fixture process setup. Real
    # deadline tests continue to count launch using the ordinary factory.
    process = subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(getattr(process,channel),selectors.EVENT_READ)
            if not selector.select(5):
                raise AssertionError('owned transport fixture did not become ready')
        with patch('protocol.subprocess.Popen',return_value=process):
            yield
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)
        for stream in (process.stdin,process.stdout,process.stderr):
            if stream is not None: stream.close()


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
        args = ['/bin/sh','-c',source,'fixture',json.dumps(REQUEST)]
        with ready_transport(args,'stdout'), self.assertRaises(subprocess.TimeoutExpired) as caught:
            run_container(args,timeout=0.2)
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
        args = ['/bin/sh','-c',source]
        with ready_transport(args,'stderr'), self.assertRaises(subprocess.TimeoutExpired) as caught:
            run_container(args,timeout=0.2,diagnostics=diagnostics)
        self.assertIn(b'prepare-start',caught.exception.stderr)
        self.assertEqual(caught.exception.protocol_phase,'waiting-broker-request')
        self.assertEqual(diagnostics['protocol_phase'],'waiting-broker-request')

    def test_startup_inventory_is_audited_before_any_registered_request(self):
        startup = {'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source = "import json,sys; print("+repr(json.dumps(startup))+",flush=True); ack=sys.stdin.readline(); print("+repr(json.dumps(REQUEST))+",flush=True); reply=sys.stdin.readline(); print(json.dumps({'startup':ack.strip(),'reply':reply.strip()}))"
        events = []
        def audit(inventory):
            self.assertEqual(inventory,startup['inventory'])
            events.append('startup-audit')
            return {'passed':True,'category':'verified','descriptor_count':2}
        def dispatch(request):
            self.assertEqual(events,['startup-audit'])
            events.append('registered-dispatch')
            return fixture_dispatch(request)
        output = run_container([sys.executable,'-u','-c',source],dispatch=dispatch,startup_audit=audit)
        self.assertEqual(json.loads(output),{'startup':'startup:approved','reply':'registered:Squat'})
        self.assertEqual(events,['startup-audit','registered-dispatch'])

    def test_class_mismatch_has_no_ack_or_registered_dispatch(self):
        startup = {'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source = "import json,sys; print("+repr(json.dumps(startup))+",flush=True); ack=sys.stdin.readline(); print('unexpected-ack',flush=True) if ack else None"
        diagnostics = {}
        dispatched = []
        with self.assertRaises(StartupAuditRejected) as rejected:
            run_container([sys.executable,'-u','-c',source],diagnostics=diagnostics,
                dispatch=lambda request:dispatched.append(request),
                startup_audit=lambda inventory:{'passed':False,'category':'class-mismatch'})
        self.assertEqual(rejected.exception.category,'class-mismatch')
        self.assertEqual(dispatched,[])
        self.assertNotIn('unexpected-ack',diagnostics['stdout'])
        self.assertEqual(diagnostics['protocol_phase'],'startup-audit')

    def test_startup_inventory_shape_is_strict_and_cannot_be_replayed(self):
        for inventory in ([{'fd':True,'kind':'eventfd'}]*2,
                          [{'fd':3,'kind':'eventfd'},{'fd':3,'kind':'eventpoll'}],
                          [{'fd':2,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}],
                          [{'fd':3,'kind':'regular-file'},{'fd':4,'kind':'eventpoll'}]):
            startup = {'kind':'startup-audit','inventory':inventory}
            source = "import json,sys; print("+repr(json.dumps(startup))+",flush=True); sys.stdin.readline()"
            called = []
            with self.assertRaises(StartupAuditRejected):
                run_container([sys.executable,'-u','-c',source],startup_audit=lambda data:called.append(data))
            self.assertEqual(called,[])
        startup = {'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source = "import json,sys; data="+repr(json.dumps(startup))+"; print(data,flush=True); sys.stdin.readline(); print(data,flush=True); sys.stdin.readline()"
        calls = []
        def audit(inventory):
            calls.append(inventory)
            return {'passed':True,'category':'verified','descriptor_count':2}
        with self.assertRaises(ValueError):
            run_container([sys.executable,'-u','-c',source],startup_audit=audit)
        self.assertEqual(len(calls),1)

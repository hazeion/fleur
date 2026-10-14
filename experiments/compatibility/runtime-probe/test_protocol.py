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

    def test_complete_frame_and_verified_stopped_worker_retire_lingering_client(self):
        frame = {'kind':'runtime-evidence','valid':True}
        source = "printf '%s\\n' \"$1\"; IFS= read -r reply; printf '%s\\n' \"$2\"; exec /bin/sleep 30"
        args = ['/bin/sh','-c',source,'fixture',json.dumps(REQUEST),json.dumps(frame)]
        seen = []
        def completion(actual,remaining):
            self.assertEqual(actual,frame)
            self.assertGreater(remaining,0)
            seen.append(actual)
            return {'completed':True,'exit_code':0}
        with ready_transport(args,'stdout'):
            output = run_container(args,timeout=0.2,completion_observer=completion)
        self.assertEqual(json.loads(output),frame)
        self.assertEqual(seen,[frame])

    def test_valid_result_alone_cannot_complete_a_running_worker(self):
        frame = {'kind':'runtime-evidence','valid':True}
        source = "printf '%s\\n' \"$1\"; IFS= read -r reply; printf '%s\\n' \"$2\"; exec /bin/sleep 30"
        args = ['/bin/sh','-c',source,'fixture',json.dumps(REQUEST),json.dumps(frame)]
        with ready_transport(args,'stdout'), self.assertRaises(subprocess.TimeoutExpired):
            run_container(args,timeout=0.2,completion_observer=lambda actual,remaining:{'completed':False})

    def test_nonzero_unowned_and_invalid_frames_never_complete(self):
        source = "printf '%s\\n' \"$1\"; IFS= read -r reply; printf '%s\\n' \"$2\"; exec /bin/sleep 30"
        frame = {'kind':'runtime-evidence','valid':True}
        args = ['/bin/sh','-c',source,'fixture',json.dumps(REQUEST),json.dumps(frame)]
        with ready_transport(args,'stdout'), self.assertRaises(RuntimeError):
            run_container(args,timeout=0.2,completion_observer=lambda actual,remaining:{'completed':True,'exit_code':137})
        def unowned(actual,remaining): raise RuntimeError('owned worker completion unverified')
        with ready_transport(args,'stdout'), self.assertRaises(RuntimeError):
            run_container(args,timeout=0.2,completion_observer=unowned)
        badargs = args[:-1]+[json.dumps({'kind':'arbitrary-log'})]
        called = []
        with ready_transport(badargs,'stdout'), self.assertRaises(RuntimeError):
            run_container(badargs,timeout=0.2,completion_observer=lambda actual,remaining:called.append(actual))
        self.assertEqual(called,[])

    def test_observer_confirmation_after_deadline_cannot_recover_success(self):
        import time
        frame = {'kind':'runtime-evidence','valid':True}
        source = "printf '%s\\n' \"$1\"; IFS= read -r reply; printf '%s\\n' \"$2\"; exec /bin/sleep 30"
        args = ['/bin/sh','-c',source,'fixture',json.dumps(REQUEST),json.dumps(frame)]
        def too_late(actual,remaining):
            time.sleep(remaining+0.02)
            return {'completed':True,'exit_code':0}
        with ready_transport(args,'stdout'), self.assertRaises(subprocess.TimeoutExpired):
            run_container(args,timeout=0.2,completion_observer=too_late)

    def test_local_client_retirement_cannot_consume_deadline_and_return_success(self):
        import time
        frame = {'kind':'runtime-evidence','valid':True}
        source = "printf '%s\\n' \"$1\"; IFS= read -r reply; printf '%s\\n' \"$2\"; exec /bin/sleep 30"
        args = ['/bin/sh','-c',source,'fixture',json.dumps(REQUEST),json.dumps(frame)]
        with ready_transport(args,'stdout'):
            process = subprocess.Popen()
            wait = process.wait
            def delayed_wait(**kwargs):
                time.sleep(0.22)
                return wait(**kwargs)
            with patch.object(process,'wait',side_effect=delayed_wait), self.assertRaises(subprocess.TimeoutExpired):
                run_container(args,timeout=0.2,completion_observer=lambda actual,remaining:{'completed':True,'exit_code':0})

    def test_waiter_starts_at_audited_pause_before_startup_ack_and_is_reaped(self):
        startup = {'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source = "import json,sys; print("+repr(json.dumps(startup))+",flush=True); assert sys.stdin.readline()=='startup:approved\\n'; print("+repr(json.dumps(REQUEST))+",flush=True); sys.stdin.readline(); print(json.dumps({'kind':'runtime-evidence'}),flush=True)"
        events=[]
        class Waiter:
            def completion(self,remaining): events.append('wait-completed');return {'completed':True,'exit_code':0}
            def close(self): events.append('waiter-closed')
        def audit(rows): events.append('audit');return {'passed':True,'category':'verified','descriptor_count':len(rows)}
        def start(remaining): self.assertEqual(events,['audit']);self.assertGreater(remaining,0);events.append('waiter-started');return Waiter()
        def dispatch(request):self.assertEqual(events,['audit','waiter-started']);return fixture_dispatch(request)
        output=run_container([sys.executable,'-u','-c',source],startup_audit=audit,completion_start=start,completion_observer=lambda f,r:{'completed':True,'exit_code':0},dispatch=dispatch)
        self.assertEqual(json.loads(output)['kind'],'runtime-evidence')
        self.assertEqual(events,['audit','waiter-started','wait-completed','waiter-closed'])

    def test_waiter_cleanup_failure_does_not_skip_transport_diagnostics_or_pipe_cleanup(self):
        startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source="import json,sys; print("+repr(json.dumps(startup))+",flush=True); sys.stdin.readline(); print("+repr(json.dumps(REQUEST))+",flush=True); sys.stdin.readline(); print(json.dumps({'kind':'runtime-evidence'}),flush=True)"
        class Waiter:
            def completion(self,r):return {'completed':True,'exit_code':0}
            def close(self):raise RuntimeError('waiter cleanup fixture failure')
        diagnostics={};processes=[];factory=subprocess.Popen
        def launch(*args,**kwargs):p=factory(*args,**kwargs);processes.append(p);return p
        with patch('protocol.subprocess.Popen',side_effect=launch),self.assertRaisesRegex(RuntimeError,'waiter cleanup fixture failure'):
            run_container([sys.executable,'-u','-c',source],startup_audit=lambda rows:{'passed':True,'category':'verified','descriptor_count':len(rows)},completion_start=lambda r:Waiter(),completion_observer=lambda f,r:{'completed':True,'exit_code':0},diagnostics=diagnostics)
        self.assertIn('protocol_phase',diagnostics)
        self.assertFalse(diagnostics['waiter_cleanup_verified'])
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(processes[0].stdout.closed)
        self.assertTrue(processes[0].stderr.closed)

    def test_missing_waiter_cannot_ack_startup_or_accept_evidence(self):
        startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source="import json,sys; print("+repr(json.dumps(startup))+",flush=True); sys.stdin.readline(); print("+repr(json.dumps(REQUEST))+",flush=True); sys.stdin.readline(); print(json.dumps({'kind':'runtime-evidence'}),flush=True)"
        with self.assertRaisesRegex(RuntimeError,'owned waiter startup invalid'):
            run_container([sys.executable,'-u','-c',source],startup_audit=lambda rows:{'passed':True,'category':'verified','descriptor_count':len(rows)},completion_start=lambda r:None,completion_observer=lambda f,r:{'completed':True,'exit_code':0})

    def test_invalid_waiter_keeps_callable_cleanup_handle(self):
        startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source="import json,sys; print("+repr(json.dumps(startup))+",flush=True); sys.stdin.readline()"
        events=[]
        class InvalidWaiter:
            completion=None
            def close(self):events.append('closed')
        with self.assertRaisesRegex(RuntimeError,'owned waiter startup invalid'):
            run_container([sys.executable,'-u','-c',source],startup_audit=lambda rows:{'passed':True,'category':'verified','descriptor_count':len(rows)},completion_start=lambda r:InvalidWaiter())
        self.assertEqual(events,['closed'])

    def test_waiter_zero_cannot_overwrite_observer_nonzero_completion(self):
        startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source="import json,sys; print("+repr(json.dumps(startup))+",flush=True); sys.stdin.readline(); print("+repr(json.dumps(REQUEST))+",flush=True); sys.stdin.readline(); print(json.dumps({'kind':'runtime-evidence'}),flush=True)"
        events=[]
        class Waiter:
            def completion(self,r):events.append('wait-observed');return {'completed':True,'exit_code':0}
            def close(self):events.append('closed')
        with self.assertRaisesRegex(RuntimeError,'owned worker did not complete successfully'):
            run_container([sys.executable,'-u','-c',source],startup_audit=lambda rows:{'passed':True,'category':'verified','descriptor_count':len(rows)},completion_start=lambda r:Waiter(),completion_observer=lambda f,r:{'completed':True,'exit_code':137})
        self.assertEqual(events,['closed'])

    def test_pending_trace_is_captured_once_before_waiter_cleanup(self):
        startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source="printf '%s\\n' \"$1\"; IFS= read -r startup; printf '%s\\n' \"$2\"; IFS= read -r reply; printf '{\"kind\":\"runtime-evidence\"}\\n'; exec /bin/sleep 30"
        args=['/bin/sh','-c',source,'fixture',json.dumps(startup),json.dumps(REQUEST)]
        events=[];diagnostics={}
        class Waiter:
            def completion(self,r):return {'completed':'trace' in events,'exit_code':0}
            def snapshot(self):events.append('snapshot');return {'stdout_bytes':0,'stderr_bytes':0,'cli_returncode':None}
            def close(self):events.append('closed')
        def trace(remaining):
            self.assertGreater(remaining,0);events.append('trace');return {'outcome':'captured','goroutines':[]}
        output=run_container(args,timeout=4,startup_audit=lambda rows:{'passed':True,'category':'verified','descriptor_count':len(rows)},completion_start=lambda r:Waiter(),completion_observer=lambda f,r:{'completed':True,'exit_code':0},completion_stall=trace,diagnostics=diagnostics)
        self.assertEqual(json.loads(output)['kind'],'runtime-evidence')
        self.assertEqual(events,['trace','snapshot','closed'])
        self.assertEqual(diagnostics['waiter_observations']['stdout_bytes'],0)
        self.assertEqual(diagnostics['daemon_stall_trace']['outcome'],'captured')

    def test_unaccepted_frame_cannot_trigger_privileged_stall_capture(self):
        startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source="printf '%s\\n' \"$1\"; IFS= read -r startup; printf '%s\\n' \"$2\"; IFS= read -r reply; printf '{\"kind\":\"runtime-evidence\"}\\n'; exec /bin/sleep 30"
        args=['/bin/sh','-c',source,'fixture',json.dumps(startup),json.dumps(REQUEST)]
        events=[]
        class Waiter:
            def completion(self,r):events.append('wait');return {'completed':False}
            def close(self):pass
        with self.assertRaises(subprocess.TimeoutExpired):
            run_container(args,timeout=2.5,startup_audit=lambda rows:{'passed':True,'category':'verified','descriptor_count':len(rows)},completion_start=lambda r:Waiter(),completion_observer=lambda f,r:{'completed':False},completion_stall=lambda r:events.append('trace'))
        self.assertEqual(events,[])

    def test_malformed_waiter_result_preserves_typed_completion_rejection(self):
        startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source="import json,sys; print("+repr(json.dumps(startup))+",flush=True); sys.stdin.readline(); print("+repr(json.dumps(REQUEST))+",flush=True); sys.stdin.readline(); print(json.dumps({'kind':'runtime-evidence'}),flush=True)"
        class Waiter:
            def completion(self,r):return None
            def close(self):pass
        with self.assertRaisesRegex(RuntimeError,'owned worker completion observer result invalid'):
            run_container([sys.executable,'-u','-c',source],startup_audit=lambda rows:{'passed':True,'category':'verified','descriptor_count':len(rows)},completion_start=lambda r:Waiter(),completion_observer=lambda f,r:{'completed':True,'exit_code':0})

    def test_snapshot_value_error_cannot_replace_original_failure_or_skip_cleanup(self):
        startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source="import json,sys; print("+repr(json.dumps(startup))+",flush=True); sys.stdin.readline(); print("+repr(json.dumps(REQUEST))+",flush=True); sys.stdin.readline(); print(json.dumps({'kind':'runtime-evidence'}),flush=True)"
        events=[]
        class Waiter:
            def completion(self,r):raise RuntimeError('original waiter fixture failure')
            def snapshot(self):raise ValueError('snapshot fixture failure')
            def close(self):events.append('closed')
        with self.assertRaisesRegex(RuntimeError,'original waiter fixture failure'):
            run_container([sys.executable,'-u','-c',source],startup_audit=lambda rows:{'passed':True,'category':'verified','descriptor_count':len(rows)},completion_start=lambda r:Waiter(),completion_observer=lambda f,r:{'completed':True,'exit_code':0},diagnostics={})
        self.assertEqual(events,['closed'])

    def test_observer_prepare_precedes_worker_launch_and_start_bind_precedes_ack(self):
        startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source="import json,sys; print("+repr(json.dumps(startup))+",flush=True); sys.stdin.readline(); print("+repr(json.dumps(REQUEST))+",flush=True); sys.stdin.readline(); print(json.dumps({'kind':'runtime-evidence'}),flush=True)"
        events=[];factory=subprocess.Popen
        class Observer:
            def completion(self,remaining):events.append('exit-observed');return {'completed':True,'exit_code':0,'source':'containerd-init-exit'}
            def close(self,remaining):self_test.assertGreater(remaining,0);events.append('closed');return True
        self_test=self
        def prepare(remaining):self.assertGreater(remaining,0);events.append('prepared');return Observer()
        def launch(*args,**kwargs):self.assertEqual(events,['prepared']);events.append('worker-launched');return factory(*args,**kwargs)
        def audit(rows):events.append('audited');return {'passed':True,'category':'verified','descriptor_count':len(rows)}
        def bind(observer,remaining):self.assertEqual(events,['prepared','worker-launched','audited']);events.append('bound');return {'registered':True}
        def dispatch(request):self.assertEqual(events,['prepared','worker-launched','audited','bound']);return fixture_dispatch(request)
        def accept(frame,remaining):events.append('frame-accepted');return {'completed':True,'exit_code':0}
        with patch('protocol.subprocess.Popen',side_effect=launch):
            result=run_container([sys.executable,'-u','-c',source],startup_audit=audit,completion_prepare=prepare,completion_bind=bind,completion_observer=accept,dispatch=dispatch)
        self.assertEqual(json.loads(result)['kind'],'runtime-evidence')
        self.assertEqual(events,['prepared','worker-launched','audited','bound','frame-accepted','exit-observed','closed'])

    def test_prepared_observer_without_cleanup_ack_cannot_pass(self):
        startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source="import json,sys; print("+repr(json.dumps(startup))+",flush=True); sys.stdin.readline(); print("+repr(json.dumps(REQUEST))+",flush=True); sys.stdin.readline(); print(json.dumps({'kind':'runtime-evidence'}),flush=True)"
        class Observer:
            def completion(self,r):return {'completed':True,'exit_code':0}
            def close(self,r):return None
        with self.assertRaisesRegex(RuntimeError,'init exit observer cleanup unverified'):
            run_container([sys.executable,'-u','-c',source],startup_audit=lambda rows:{'passed':True,'category':'verified','descriptor_count':len(rows)},completion_prepare=lambda r:Observer(),completion_bind=lambda o,r:{'registered':True},completion_observer=lambda f,r:{'completed':True,'exit_code':0})

    def test_missing_init_start_prevents_ack_and_dispatch(self):
        startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
        source="import json,sys; print("+repr(json.dumps(startup))+",flush=True); sys.stdin.readline(); print("+repr(json.dumps(REQUEST))+",flush=True)"
        events=[]
        class Observer:
            def completion(self,r):events.append('exit');return {'completed':True,'exit_code':0}
            def close(self,r):events.append('closed');return True
        with self.assertRaisesRegex(RuntimeError,'init task start registration unverified'):
            run_container([sys.executable,'-u','-c',source],startup_audit=lambda rows:{'passed':True,'category':'verified','descriptor_count':len(rows)},completion_prepare=lambda r:Observer(),completion_bind=lambda o,r:{'registered':False},completion_observer=lambda f,r:{'completed':True,'exit_code':0},dispatch=lambda request:events.append('dispatched'))
        self.assertEqual(events,['closed'])

    def test_prepare_time_is_counted_before_any_worker_launch(self):
        import time
        events=[]
        class Observer:
            def completion(self,r):return {'completed':True,'exit_code':0}
            def close(self,r):events.append('closed');return True
        def prepare(r):time.sleep(.2);return Observer()
        with patch('protocol.subprocess.Popen') as launch,self.assertRaises(subprocess.TimeoutExpired):
            run_container(['owned-worker'],timeout=.1,startup_audit=lambda rows:None,completion_prepare=prepare,completion_bind=lambda o,r:{'registered':True},completion_observer=lambda f,r:{'completed':True,'exit_code':0})
        launch.assert_not_called();self.assertEqual(events,['closed'])

import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from containerd_observer import ContainerdObserver, ObserverUnverified, SUPERVISOR

CID = 'a'*64
STAMP = '2026-10-13 20:00:00 +0000 UTC moby '
START = STAMP+'/tasks/start '+json.dumps({'container_id':CID,'pid':421})+'\n'
EXIT_STAMP = STAMP.replace('20:00:00','20:00:02')
EXIT = EXIT_STAMP+'/tasks/exit '+json.dumps({'container_id':CID,'id':CID,'pid':421,'exited_at':{'seconds':1791921601}})+'\n'

class ObserverTests(unittest.TestCase):
    def observer(self, frames, delay=0, timeout=2):
        directory=tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        script=pathlib.Path(directory.name)/'events.py'
        self.cli_pid_file=pathlib.Path(directory.name)/'observer.pid'
        script.write_text("import sys,time,os,pathlib\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\ntime.sleep("+repr(delay)+")\nsys.stdout.write("+repr(frames)+")\nsys.stdout.flush()\nsys.stdin.read()\nprint('[observer-reaped]',flush=True)\n")
        observer=ContainerdObserver('/usr/bin/ctr','/run/containerd/containerd.sock','moby',timeout,
            launcher=[sys.executable,'-u',str(script),str(self.cli_pid_file)])
        self.addCleanup(lambda: None if observer.snapshot()['cleanup_verified'] else observer.close(0.5))
        return observer

    def test_supervisor_status_never_supplies_task_start_or_exit_proof(self):
        status={'phase':3,'pre_retirement_returncode':None,'child_returncode':-9,
                'ctr_stdout_bytes':0,'ctr_stderr_bytes':0,'control_bytes':0,'diagnostic_requested':False}
        observer=self.observer('[observer-status] '+json.dumps(status)+'\n')
        with self.assertRaisesRegex(ObserverUnverified,'event-timeout'): observer.bind(CID,421,0.05)
        self.assertEqual(observer.snapshot()['event_count'],0)

    def test_malformed_supervisor_status_fails_closed(self):
        observer=self.observer('[observer-status] '+json.dumps({'phase':'private-secret'})+'\n'+START+EXIT)
        with self.assertRaisesRegex(ObserverUnverified,'supervisor-status-invalid'): observer.bind(CID,421,1)
        self.assertNotIn('private-secret',json.dumps(observer.snapshot()))

    def test_early_ctr_exit_reports_safe_status_before_reap_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            ctr=pathlib.Path(directory)/'ctr'
            ctr.write_text('#!'+sys.executable+'\nimport sys\nsys.stderr.write("private-secret-diagnostic")\nsys.exit(7)\n')
            ctr.chmod(0o755)
            address=str(pathlib.Path(directory)/'containerd.sock')
            adapter="""import os
original_stat=os.stat
def same_user_stat(path,*args,**kwargs):
    values=list(original_stat(path,*args,**kwargs));values[0]&=~0o022;values[4]=0
    return os.stat_result(values)
os.stat=same_user_stat
os.geteuid=lambda:0
"""
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as server:
                server.bind(address)
                observer=ContainerdObserver('/usr/bin/ctr','/run/containerd/containerd.sock','moby',3,
                    launcher=[sys.executable,'-I','-u','-c',adapter+SUPERVISOR,
                              str(ctr),address,'moby',str(time.monotonic()+3)])
                self.addCleanup(lambda: None if observer.snapshot()['cleanup_verified'] else observer.close(1))
                with self.assertRaisesRegex(ObserverUnverified,'stream-ended'): observer.bind(CID,421,2)
                self.assertTrue(observer.close(1))
                status=observer.snapshot()['root_supervisor']
                self.assertEqual(status['pre_retirement_returncode'],7)
                self.assertEqual(status['child_returncode'],7)
                self.assertEqual(status['phase'],2)
                self.assertGreater(status['ctr_stderr_bytes'],0)
                self.assertFalse(status['diagnostic_requested'])
                self.assertNotIn('private-secret',json.dumps(status))

    def test_failed_registration_captures_only_sanitized_owned_child_stack(self):
        self.registration_diagnostic_case()

    def registration_diagnostic_case(self, expired=False):
        with tempfile.TemporaryDirectory() as directory:
            ctr=pathlib.Path(directory)/'ctr'
            ready=pathlib.Path(directory)/'ready'
            raw="goroutine 7 gp=0x1234 m=2 mp=0x5678 [IO wait]:\ngithub.com/containerd/containerd/api/services/introspection/v1.(*introspectionClient).Server(secret-argument)\n\t/private/secret-file.go:123\n"
            ctr.write_text('#!'+sys.executable+'\nimport os,pathlib,signal,sys,time\ndef quit_handler(*args):\n os.write(2,'+repr(raw.encode())+');sys.exit(2)\nsignal.signal(signal.SIGQUIT,quit_handler)\npathlib.Path('+repr(str(ready))+').write_text(str(os.getpid()))\nwhile True: signal.pause()\n')
            ctr.chmod(0o755)
            address=str(pathlib.Path(directory)/'containerd.sock')
            adapter="""import os
original_stat=os.stat
def same_user_stat(path,*args,**kwargs):
    values=list(original_stat(path,*args,**kwargs));values[0]&=~0o022;values[4]=0
    return os.stat_result(values)
os.stat=same_user_stat
os.geteuid=lambda:0
"""
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as server:
                server.bind(address)
                allowance=1.5 if expired else 3
                observer=ContainerdObserver('/usr/bin/ctr','/run/containerd/containerd.sock','moby',allowance,
                    launcher=[sys.executable,'-I','-u','-c',adapter+SUPERVISOR,
                              str(ctr),address,'moby',str(time.monotonic()+allowance)])
                self.addCleanup(lambda: None if observer.snapshot()['cleanup_verified'] else observer.close(1))
                deadline=time.monotonic()+1
                while not ready.exists() and time.monotonic()<deadline: time.sleep(0.01)
                self.assertTrue(ready.exists())
                pid=int(ready.read_text())
                with self.assertRaisesRegex(ObserverUnverified,'event-timeout'):
                    observer.bind(CID,421,allowance if expired else 0.05)
                self.assertTrue(observer.diagnose_registration()['requested'])
                if expired:
                    with self.assertRaisesRegex(ObserverUnverified,'observer-cleanup-deadline'): observer.close(-0.01)
                else:
                    self.assertTrue(observer.close(1))
                diagnostic=observer.snapshot()['registration_diagnostic']
                self.assertEqual(diagnostic['goroutines'][0]['functions'],[
                    'github.com/containerd/containerd/api/services/introspection/v1.(*introspectionClient).Server'])
                self.assertNotIn('secret-argument',json.dumps(diagnostic))
                self.assertNotIn('secret-file',json.dumps(diagnostic))
                self.assertNotIn('0x1234',json.dumps(diagnostic))
                self.assertNotIn('0x5678',json.dumps(diagnostic))
                self.assertEqual(diagnostic['ctr_stdout_bytes'],0)
                with self.assertRaises(ProcessLookupError): os.kill(pid,0)

    def test_expired_registration_can_capture_diagnostic_without_late_success(self):
        self.registration_diagnostic_case(expired=True)

    def test_registration_diagnostic_requires_actual_failed_binding(self):
        observer=self.observer(START+EXIT)
        with self.assertRaises(ObserverUnverified): observer.diagnose_registration()

    def test_embedded_supervisor_reaps_real_child_after_os_setup_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file=pathlib.Path(directory)/'ctr.pid'
            ctr=pathlib.Path(directory)/'ctr'
            ctr.write_text('#!'+sys.executable+'\nimport os,pathlib,time\npathlib.Path('+repr(str(pid_file))+').write_text(str(os.getpid()))\ntime.sleep(30)\n')
            ctr.chmod(0o755)
            address=str(pathlib.Path(directory)/'containerd.sock')
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as server:
                server.bind(address)
                # Same-user test adapter bypasses ONLY root path policy. The
                # actual embedded supervisor still owns a real detached child.
                adapter = """import os,selectors,time
original_stat=os.stat
def same_user_stat(path,*args,**kwargs):
    values=list(original_stat(path,*args,**kwargs));values[0]&=~0o022;values[4]=0
    return os.stat_result(values)
os.stat=same_user_stat
os.geteuid=lambda:0
class FailingSelector(selectors.DefaultSelector):
    def register(self,fileobj,events,data=None):
        if fileobj.fileno()!=0:
            deadline=time.monotonic()+2
            while not os.path.exists(PID_FILE) and time.monotonic()<deadline: time.sleep(0.01)
            raise OSError('injected OS registration resource failure')
        return super().register(fileobj,events,data)
selectors.DefaultSelector=FailingSelector
""".replace('PID_FILE',repr(str(pid_file)))
                process=subprocess.Popen([sys.executable,'-I','-u','-c',adapter+SUPERVISOR,
                    str(ctr),address,'moby',str(time.monotonic()+3)],
                    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                process.communicate(timeout=4)
                self.assertNotEqual(process.returncode,0)
                pid=int(pid_file.read_text())
                def retire_leaked_test_group():
                    try: os.killpg(pid,signal.SIGKILL)
                    except ProcessLookupError: pass
                self.addCleanup(retire_leaked_test_group)
                with self.assertRaises(ProcessLookupError): os.kill(pid,0)
                with self.assertRaises(ProcessLookupError): os.killpg(pid,0)

    def test_valid_audit_exec_exit_cannot_block_matching_init_exit(self):
        for status in [0,137]:
            with self.subTest(exec_status=status):
                event=json.loads(EXIT.split('/tasks/exit ',1)[1])
                event.update({'id':'c'*64,'pid':422,'exit_status':status})
                observer=self.observer(START+EXIT_STAMP+'/tasks/exit '+json.dumps(event)+'\n'+EXIT)
                observer.bind(CID,421,1)
                self.assertEqual(observer.completion(1)['exit_code'],0)
                observer.close(1)

    def test_malformed_exec_exits_are_rejected_rather_than_discarded(self):
        for changes in [{'exit_status':True}, {'pid':421}, {'pid':0},
                        {'exited_at':{'seconds':1}}]:
            with self.subTest(changes=changes):
                event=json.loads(EXIT.split('/tasks/exit ',1)[1])
                event.update({'id':'c'*64,'pid':422});event.update(changes)
                observer=self.observer(START+EXIT_STAMP+'/tasks/exit '+json.dumps(event)+'\n'+EXIT)
                observer.bind(CID,421,1)
                with self.assertRaises(ObserverUnverified): observer.completion(1)
                observer.close(1)

    def test_audit_exec_exit_alone_never_proves_init_exit(self):
        event=json.loads(EXIT.split('/tasks/exit ',1)[1])
        event.update({'id':'c'*64,'pid':422,'exit_status':0})
        observer=self.observer(START+EXIT_STAMP+'/tasks/exit '+json.dumps(event)+'\n')
        observer.bind(CID,421,1)
        with self.assertRaisesRegex(ObserverUnverified,'event-timeout'): observer.completion(0.05)

    def test_selector_allocation_failure_never_launches_an_owned_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            marker=pathlib.Path(directory)/'started'
            command=[sys.executable,'-c',
                "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('started');sys.stdin.read()",str(marker)]
            with patch('selectors.DefaultSelector',side_effect=OSError('selector resource unavailable')):
                with self.assertRaisesRegex(ObserverUnverified,'observer-start'):
                    ContainerdObserver('/usr/bin/ctr','/run/containerd/containerd.sock','moby',0.1,launcher=command)
            time.sleep(0.2)
            self.assertFalse(marker.exists(),'observer launched before its OS resources were owned')

    def test_expired_operation_still_reaps_observer_without_late_success(self):
        observer=self.observer('',timeout=0.03)
        time.sleep(0.2)
        pid=int(self.cli_pid_file.read_text())
        with self.assertRaisesRegex(ObserverUnverified,'observer-cleanup-deadline'): observer.close(-0.01)
        with self.assertRaises(ProcessLookupError): os.kill(pid,0)
        self.assertTrue(observer.snapshot()['reaped'])
        self.assertTrue(observer.snapshot()['cleanup_verified'])
        with self.assertRaisesRegex(ObserverUnverified,'observer-cleanup-deadline'): observer.close()

    def test_exit_time_cannot_be_after_its_host_event_envelope(self):
        event=json.loads(EXIT.split('/tasks/exit ',1)[1]);event['exited_at']={'seconds':1791921700}
        observer=self.observer(START+EXIT_STAMP+'/tasks/exit '+json.dumps(event)+'\n')
        observer.bind(CID,421,1)
        with self.assertRaises(ObserverUnverified): observer.completion(1)

    def test_nonzero_worker_exit_is_rejected(self):
        event=json.loads(EXIT.split('/tasks/exit ',1)[1]);event['exit_status']=137
        observer=self.observer(START+EXIT_STAMP+'/tasks/exit '+json.dumps(event)+'\n')
        observer.bind(CID,421,1)
        with self.assertRaisesRegex(ObserverUnverified,'nonzero-exit'): observer.completion(1)

    def test_wrong_init_identity_and_invalid_exit_fields_fail(self):
        for changes in [{'id':'exec-worker'}, {'pid':422}, {'pid':True},
                        {'exit_status':True}, {'exit_status':None}, {'exit_status':-1},
                        {'exited_at':None}, {'exited_at':{'seconds':True}},
                        {'exited_at':{'seconds':1791921601,'nanos':1000000000}}]:
            with self.subTest(changes=changes):
                event=json.loads(EXIT.split('/tasks/exit ',1)[1]);event.update(changes)
                observer=self.observer(START+EXIT_STAMP+'/tasks/exit '+json.dumps(event)+'\n')
                observer.bind(CID,421,1)
                with self.assertRaises(ObserverUnverified): observer.completion(1)
                observer.close(1)

    def test_start_must_be_observed_before_application_approval(self):
        observer=self.observer(EXIT)
        with self.assertRaisesRegex(ObserverUnverified,'start-unobserved'): observer.bind(CID,421,1)

    def test_wrong_start_pid_fails(self):
        observer=self.observer(START)
        with self.assertRaisesRegex(ObserverUnverified,'start-identity'): observer.bind(CID,422,1)

    def test_unrelated_events_do_not_supply_owned_proof(self):
        foreign=START.replace(CID,'b'*64)+EXIT.replace(CID,'b'*64)
        observer=self.observer(foreign+START+EXIT)
        observer.bind(CID,421,1)
        self.assertTrue(observer.completion(1)['completed'])

    def test_wrong_namespace_never_proves_registration(self):
        observer=self.observer(START.replace(' moby ',' other ')+EXIT.replace(' moby ',' other '))
        with self.assertRaisesRegex(ObserverUnverified,'event-timeout'):
                    observer.bind(CID,421,0.05)
        self.assertTrue(observer.close(1))

    def test_malformed_or_duplicate_key_event_fails(self):
        for frame in ['bad event\n',START.replace('"pid": 421','"pid": 421, "pid": 421'),
                      START.replace('2026-10-13','2026-99-99')]:
            with self.subTest(frame=frame[:30]):
                observer=self.observer(frame)
                with self.assertRaisesRegex(ObserverUnverified,'event-malformed'): observer.bind(CID,421,1)
                observer.close(1)

    def test_no_exit_response_does_not_accept_running_worker(self):
        observer=self.observer(START)
        observer.bind(CID,421,1)
        with self.assertRaisesRegex(ObserverUnverified,'event-timeout'): observer.completion(0.05)
        self.assertTrue(observer.close(1))

    def test_deadline_is_not_reset_by_each_stage(self):
        observer=self.observer(START+EXIT,delay=0.1)
        with self.assertRaisesRegex(ObserverUnverified,'event-timeout'): observer.bind(CID,421,0.02)
        self.assertTrue(observer.close(1))

    def test_close_without_bind_reaps_prepared_observer(self):
        observer=self.observer('')
        self.assertTrue(observer.close())
        self.assertTrue(observer.snapshot()['reaped'])
        self.assertTrue(observer.close())

    def test_completion_requires_registered_identity_and_is_single_use(self):
        observer=self.observer(START+EXIT)
        with self.assertRaisesRegex(ObserverUnverified,'completion-order'): observer.completion(1)
        observer.bind(CID,421,1);observer.completion(1)
        with self.assertRaisesRegex(ObserverUnverified,'completion-order'): observer.completion(1)

    def test_explicit_typed_zero_status_is_accepted(self):
        event=json.loads(EXIT.split('/tasks/exit ',1)[1]);event['exit_status']=0
        observer=self.observer(START+EXIT_STAMP+'/tasks/exit '+json.dumps(event)+'\n')
        observer.bind(CID,421,1)
        self.assertEqual(observer.completion(1)['exit_code'],0)

    def test_oversized_event_fails_even_when_it_has_a_newline(self):
        event = json.loads(START.split('/tasks/start ',1)[1])
        event['container_id'] = 'x'*5000
        observer=self.observer(STAMP+'/tasks/start '+json.dumps(event)+'\n'+START+EXIT)
        with self.assertRaises(ObserverUnverified): observer.bind(CID,421,1)

    def test_stale_exit_timestamp_cannot_prove_current_execution(self):
        stale = json.loads(EXIT.split('/tasks/exit ',1)[1])
        stale['exited_at'] = {'seconds':1}
        observer=self.observer(START+EXIT_STAMP+'/tasks/exit '+json.dumps(stale)+'\n')
        observer.bind(CID,421,1)
        with self.assertRaises(ObserverUnverified): observer.completion(1)

    def test_owned_init_exit_is_proven_after_observed_start(self):
        observer=self.observer(START+EXIT)
        observer.bind(CID,421,1)
        self.assertEqual(observer.completion(1),{'completed':True,'exit_code':0,'source':'containerd-init-exit'})
        self.assertTrue(observer.close(1))

if __name__ == '__main__': unittest.main()

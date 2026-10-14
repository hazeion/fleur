import json
import os
import pathlib
import sys
import tempfile
import time
import unittest
from containerd_observer import ContainerdObserver, ObserverUnverified

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
        with self.assertRaisesRegex(ObserverUnverified,'event-timeout'): observer.bind(CID,421,0.05)
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

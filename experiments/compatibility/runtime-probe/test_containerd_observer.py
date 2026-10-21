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

LINUX_ROOT_SIGNAL_ADAPTER = r'''# Explicit Darwin OS seam for Linux-root capability; never native proof.
import subprocess,signal,sys
native_killpg=os.killpg
def linux_root_killpg(pid,sig):
    try:return native_killpg(pid,sig)
    except PermissionError:
        if sys.platform!='darwin' or not sig:raise
        status=os.waitid(os.P_PID,pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
        if status is None or status.si_pid!=pid:raise
        inventory=subprocess.run(['/bin/ps','-axo','pid=,pgid=,stat='],stdin=subprocess.DEVNULL,capture_output=True,timeout=.2,check=True,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
        if len(inventory.stdout)>2*1024*1024 or inventory.stderr:raise PermissionError('ambiguous group inventory')
        leader=False;seen=set()
        for line in inventory.stdout.decode('ascii').splitlines():
            fields=line.split()
            if len(fields)!=3 or not fields[0].isdigit() or not fields[1].isdigit():raise PermissionError('malformed group inventory')
            member,group=map(int,fields[:2])
            if member in seen:raise PermissionError('duplicate group inventory')
            seen.add(member)
            if group==pid:
                if fields[2] not in ('Z','Z+','ZN','ZN+'):raise PermissionError('owned group still has live or unknown members')
                if member==pid:leader=True
        if not leader:raise PermissionError('retained leader absent from inventory')
        return
os.killpg=linux_root_killpg
'''

class ObserverTests(unittest.TestCase):
    def observer(self, frames, delay=0, timeout=2, startup_delay=0):
        directory=tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        script=pathlib.Path(directory.name)/'events.py'
        self.cli_pid_file=pathlib.Path(directory.name)/'observer.pid'
        script.write_text("import sys,time,os,pathlib\ntime.sleep("+repr(startup_delay)+")\npid_path=pathlib.Path(sys.argv[1]);pending_pid=pid_path.with_suffix('.pending');pending_pid.write_text(str(os.getpid()));pending_pid.replace(pid_path)\ntime.sleep("+repr(delay)+")\nsys.stdout.write("+repr(frames)+")\nsys.stdout.flush()\nsys.stdin.read()\nprint('[observer-reaped]',flush=True)\n")
        observer=ContainerdObserver('/usr/bin/ctr','/run/containerd/containerd.sock','moby',timeout,
            launcher=[sys.executable,'-u',str(script),str(self.cli_pid_file)])
        self.addCleanup(lambda: None if observer.snapshot()['cleanup_verified'] else observer.close(0.5))
        return observer

    def supervised_observer(self, source, timeout=3, adapter_extra="", allow_unconfirmed=False):
        directory=tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        ctr=pathlib.Path(directory.name)/'ctr'
        # One shebang argument is portable; combined flags isolate Python
        # and suppress site hooks without a second shell interpreter startup.
        ctr.write_text('#!'+sys.executable+' -ISu\n'+source)
        ctr.chmod(0o755)
        address=str(pathlib.Path(directory.name)/'containerd.sock')
        server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.addCleanup(server.close)
        server.bind(address)
        adapter="""import os
original_stat=os.stat
def same_user_stat(path,*args,**kwargs):
    values=list(original_stat(path,*args,**kwargs));values[0]&=~0o022;values[4]=0
    return os.stat_result(values)
os.stat=same_user_stat
os.geteuid=lambda:0
"""
        observer=ContainerdObserver('/usr/bin/ctr','/run/containerd/containerd.sock','moby',timeout,
            launcher=[sys.executable,'-I','-u','-c',adapter+LINUX_ROOT_SIGNAL_ADAPTER+adapter_extra+SUPERVISOR,
                      str(ctr),address,'moby',str(time.monotonic()+timeout)])
        def cleanup_supervisor():
            try: observer.close(1)
            except ObserverUnverified:
                # Negative fixtures may deliberately retain a namespace in
                # their TemporaryDirectory; always finish reaping their CLI.
                if allow_unconfirmed and observer.closed and observer.process.poll() is not None:return
                if not observer.snapshot()['reaped'] or observer.process.poll() is None: raise
        self.addCleanup(cleanup_supervisor)
        return observer

    def retained_signal_adapter(self, witness):
        return """import subprocess,signal,pathlib,time
released=set()
real_popen=subprocess.Popen
class WitnessPopen(real_popen):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs);time.sleep(.1)
    def poll(self):
        code=super().poll()
        if code is not None:released.add(self.pid)
        return code
    def wait(self,*args,**kwargs):
        code=super().wait(*args,**kwargs);released.add(self.pid);return code
subprocess.Popen=WitnessPopen
real_killpg=os.killpg
def witnessed_killpg(pid,sig):
    if sig and pid in released:
        pathlib.Path(WITNESS).write_text('destructive signal after leader reaped')
        return # Intercept unsafe signal; never target an unrelated reused group.
    if sig and os.waitid(os.P_PID,pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is not None:
        # These two fixtures have no descendants. Model Linux root group signal
        # success for its retained zombie; Darwin same-user kill returns EPERM.
        return
    return real_killpg(pid,sig)
os.killpg=witnessed_killpg
""".replace('WITNESS',repr(str(witness)))

    def test_exited_subscriber_is_never_destructively_signaled_after_reap(self):
        with tempfile.TemporaryDirectory() as name:
            witness=pathlib.Path(name)/'unsafe'
            exited=pathlib.Path(name)/'exiting'
            observer=self.supervised_observer('from pathlib import Path\nPath('+repr(str(exited))+').touch()\nraise SystemExit(0)\n',adapter_extra=self.retained_signal_adapter(witness))
            limit=time.monotonic()+2
            while not exited.exists() and time.monotonic()<limit:time.sleep(.005)
            self.assertTrue(exited.exists());time.sleep(.1)
            try:observer.close(1)
            except ObserverUnverified:
                self.assertTrue(observer.snapshot()['reaped'])
            self.assertEqual(observer.snapshot().get('root_supervisor',{}).get('child_returncode'),0,observer.snapshot())
            self.assertFalse(witness.exists(),'root supervisor signaled a released numeric process group')

    def test_canary_commands_are_never_destructively_signaled_after_reap(self):
        with tempfile.TemporaryDirectory() as name:
            witness=pathlib.Path(name)/'unsafe'
            observer,state=self.canary_observer(adapter_extra=self.retained_signal_adapter(witness))
            self.assertEqual(observer.ready(4),{'ready':True})
            self.assertTrue(observer.close(1))
            self.assertFalse(witness.exists(),'canary cleanup signaled a released numeric process group')

    def test_lost_canary_child_reservation_never_signals_its_released_group(self):
        with tempfile.TemporaryDirectory() as name:
            witness=pathlib.Path(name)/'unsafe'
            adapter=self.retained_signal_adapter(witness)+"""
real_waitid=os.waitid
lost=set()
class LostReservationPopen(WitnessPopen):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        if len(args[0])>5 and args[0][5]=='namespaces':lost.add(self.pid)
subprocess.Popen=LostReservationPopen
def lost_waitid(kind,pid,flags):
    if pid in lost:
        if pid not in released:
            os.waitpid(pid,0);released.add(pid)
        raise ChildProcessError('external fixture reaped this owned child')
    return real_waitid(kind,pid,flags)
os.waitid=lost_waitid
"""
            observer,state=self.canary_observer(adapter_extra=adapter)
            with self.assertRaises(ObserverUnverified):observer.ready(4)
            try:observer.close(1)
            except ObserverUnverified:self.assertTrue(observer.snapshot()['reaped'])
            self.assertFalse(witness.exists(),'lost WNOWAIT reservation authorized a group signal')

    def test_repeated_close_preserves_unconfirmed_terminal_evidence_and_expired_category(self):
        for remaining,category in ((1,'observer-cleanup'),(-.01,'observer-cleanup-deadline')):
            with self.subTest(remaining=remaining):
                observer=ContainerdObserver('/usr/bin/ctr','/run/containerd/containerd.sock','moby',2,launcher=[sys.executable,'-I','-c','raise SystemExit(0)'])
                observer.process.wait(timeout=1)
                for _ in range(2):
                    with self.assertRaisesRegex(ObserverUnverified,category):observer.close(remaining)
                    self.assertFalse(observer.snapshot()['cleanup_verified'])
                self.assertTrue(observer.closed)

    def test_accepted_no_effect_signal_cannot_verify_cleanup_with_closed_pipe_descendant(self):
        adapter="""import subprocess
suppressed=set()
real_popen=subprocess.Popen
class AcceptedNoEffectPopen(real_popen):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        if not suppressed and len(args[0])>6 and args[0][5:7]==['namespaces','list']:suppressed.add(self.pid)
subprocess.Popen=AcceptedNoEffectPopen
real_group_signal=os.killpg
def accepted_no_effect(pid,sig):
    if sig and pid in suppressed:return
    return real_group_signal(pid,sig)
os.killpg=accepted_no_effect
"""
        observer,state=self.canary_observer('closed-pipe-orphan',adapter_extra=adapter)
        try:
            with self.assertRaises(ObserverUnverified):observer.ready(4)
            self.assertFalse(observer.snapshot()['registration']['cleanup_verified'])
        finally:
            (state/'stop-orphan').touch()
            try:observer.close(1)
            except ObserverUnverified:self.assertTrue(observer.snapshot()['reaped'])
            pid=int((state/'orphan.pid').read_text())
            limit=time.monotonic()+3
            while time.monotonic()<limit:
                try:os.kill(pid,0)
                except ProcessLookupError:break
                time.sleep(.005)
            else:self.fail('owned self-terminating fixture descendant remained alive')

    def test_subscriber_cannot_ack_cleanup_with_live_closed_pipe_descendant(self):
        with tempfile.TemporaryDirectory() as name:
            root=pathlib.Path(name);pidfile=root/'orphan.pid';stop=root/'stop'
            descendant='import pathlib,time;stop=pathlib.Path('+repr(str(stop))+');end=time.monotonic()+3\nwhile not stop.exists() and time.monotonic()<end:time.sleep(.005)'
            source='import pathlib,subprocess,sys\nchild=subprocess.Popen([sys.executable,"-c",'+repr(descendant)+'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\npathlib.Path('+repr(str(pidfile))+').write_text(str(child.pid))\nraise SystemExit(0)\n'
            adapter="""real_signal=os.killpg
def accepted_without_effect(pid,sig):
    if sig:return
    return real_signal(pid,sig)
os.killpg=accepted_without_effect
"""
            observer=self.supervised_observer(source,adapter_extra=adapter,allow_unconfirmed=True)
            try:
                limit=time.monotonic()+2
                while not pidfile.exists() and time.monotonic()<limit:time.sleep(.005)
                self.assertTrue(pidfile.exists());time.sleep(.1)
                with self.assertRaises(ObserverUnverified):observer.close(1)
                self.assertFalse(observer.snapshot()['cleanup_verified'])
            finally:
                stop.touch()
                try:observer.close(1)
                except ObserverUnverified:pass
                pid=int(pidfile.read_text());limit=time.monotonic()+3
                while time.monotonic()<limit:
                    try:os.kill(pid,0)
                    except ProcessLookupError:break
                    time.sleep(.005)
                else:self.fail('controlled descendant failed its independent stop boundary')

    def test_cancelled_namespace_cleanup_confirms_absence_after_transient_zero_denial(self):
        original=self.canary_observer
        adapter="""import subprocess,errno
cleanup_pids=set();denied=set()
cleanup_popen=subprocess.Popen
class CleanupObservationPopen(cleanup_popen):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        if len(args[0])>6 and args[0][5:7]==['namespaces','list'] and '--quiet' not in args[0]:cleanup_pids.add(self.pid)
subprocess.Popen=CleanupObservationPopen
cleanup_signal=os.killpg
def transient_cleanup_observation(pid,sig):
    if not sig and pid in cleanup_pids and pid not in denied:
        denied.add(pid);raise PermissionError(errno.EPERM,'controlled transient group observation')
    return cleanup_signal(pid,sig)
os.killpg=transient_cleanup_observation
"""
        def fixture(mode='valid',timeout=5,adapter_extra=''):
            return original(mode,timeout=timeout,adapter_extra=adapter_extra+adapter)
        self.canary_observer=fixture
        try:self.test_control_eof_during_namespace_cleanup_cannot_grant_readiness()
        finally:self.canary_observer=original

    def test_subscriber_arguments_preserve_literal_equality_value_quotes(self):
        # Literal quotes are required by the pinned containerd filter parser:
        # slash-delimited values are valid only for the regex operator.
        source="import sys,time\nexpected=['topic==\"/tasks/start\"','topic==\"/tasks/exit\"']\nif sys.argv[6:8]!=expected: sys.exit(7)\nsys.stdout.write("+repr(START+EXIT)+");sys.stdout.flush()\ntime.sleep(10)\n"
        observer=self.supervised_observer(source)
        observer.bind(CID,421,2)
        self.assertEqual(observer.completion(1)['exit_code'],0)
        self.assertTrue(observer.close(1))

    def test_child_exit_after_output_eof_is_reported_without_waiting_for_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            ready=pathlib.Path(directory)/'ready'
            go=pathlib.Path(directory)/'go'
            source='import os,pathlib,time\npathlib.Path('+repr(str(ready))+').touch()\nwhile not pathlib.Path('+repr(str(go))+').exists(): time.sleep(.005)\nos.close(1);os.close(2)\ntime.sleep(.08)\nos._exit(7)\n'
            observer=self.supervised_observer(source,timeout=5)
            limit=time.monotonic()+3
            while not ready.exists() and time.monotonic()<limit: time.sleep(.005)
            self.assertTrue(ready.exists())
            started=time.monotonic()
            go.touch()
            with self.assertRaisesRegex(ObserverUnverified,'stream-ended'):
                observer.bind(CID,421,1)
            self.assertLess(time.monotonic()-started,.7)
            self.assertTrue(observer.close(1))
            self.assertEqual(observer.snapshot()['root_supervisor']['child_returncode'],7)

    def canary_observer(self, mode="valid", timeout=5, adapter_extra=""):
        directory=tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        state=pathlib.Path(directory.name)
        source=r"""import json,os,pathlib,subprocess,sys,time
root=pathlib.Path(STATE)
rows_path=root/'namespaces.json'
queue=root/'events'
args=sys.argv[5:]
if args[0]=='events':
    time.sleep(.2)
    (root/'subscribed').touch()
    offset=0
    while True:
        if queue.exists():
            data=queue.read_bytes()
            if len(data)>offset:
                os.write(1,data[offset:]);offset=len(data)
        time.sleep(.005)
rows=json.loads(rows_path.read_text()) if rows_path.exists() else {}
verb=args[1]
if verb=='list':
    if MODE=='cancel-during-cleanup' and '--quiet' not in args:
        (root/'cleanup-ready').touch()
        while not (root/'continue-cleanup').exists(): time.sleep(.005)
    if MODE=='closed-pipe-orphan' and not (root/'orphan.pid').exists():
        child=subprocess.Popen([sys.executable,'-c','import pathlib,time;root=pathlib.Path('+repr(str(root))+');end=time.monotonic()+3\nwhile not (root/"stop-orphan").exists() and time.monotonic()<end:time.sleep(.005)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        (root/'orphan.pid').write_text(str(child.pid))
        sys.exit(0)
    if MODE=='orphan-command' and not (root/'orphan.pid').exists():
        child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
        (root/'orphan.pid').write_text(str(child.pid))
        sys.exit(0)
    for name,labels in rows.items():
        print(name if '--quiet' in args else name+' '+','.join(key+'='+value for key,value in sorted(labels.items())))
elif verb=='create':
    if args[2] in rows: sys.exit(17)
    rows[args[2]]=dict(value.split('=',1) for value in args[3:])
elif verb=='label':
    name=args[2]
    labels=dict(value.split('=',1) for value in args[3:])
    rows[name].update(labels)
    if (root/'subscribed').exists() and MODE!='missing-echo':
        if MODE=='wrong-nonce': labels={'fleur.observer.echo':'unrelated'}
        with queue.open('ab') as stream:
            stream.write(('2026-10-13 20:00:00 +0000 UTC '+name+' /namespaces/update '+json.dumps({'name':name,'labels':labels})+'\n').encode())
elif verb=='remove':
    if MODE=='failed-delete': sys.exit(19)
    del rows[args[2]]
else: sys.exit(18)
rows_path.write_text(json.dumps(rows))
""".replace('STATE',repr(str(state))).replace('MODE',repr(mode))
        return self.supervised_observer(source,timeout=timeout,adapter_extra=adapter_extra.replace('CANARY_STATE',repr(str(state)))),state

    def test_delayed_subscription_requires_echo_and_namespace_cleanup_before_ready(self):
        observer,state=self.canary_observer()
        self.assertEqual(observer.ready(4),{'ready':True})
        self.assertEqual(json.loads((state/'namespaces.json').read_text()),{})
        with (state/'events').open('ab') as stream: stream.write((START+EXIT).encode())
        observer.bind(CID,421,1)
        self.assertEqual(observer.completion(1)['exit_code'],0)
        snapshot=observer.snapshot()
        self.assertTrue(snapshot['registration']['cleanup_verified'])
        self.assertGreaterEqual(snapshot['registration']['command_count'],6)
        # This seam proves the four-second readiness allowance. Native ctr
        # startup performance is measured separately from fake Python CLIs.
        self.assertLess(snapshot['registration']['duration_ms'],4000)
        observer.close(1)

    def test_missing_or_wrong_echo_never_grants_readiness_and_retires_owned_namespace(self):
        for mode in ('missing-echo','wrong-nonce'):
            with self.subTest(mode=mode):
                observer,state=self.canary_observer(mode,timeout=5)
                with self.assertRaisesRegex(ObserverUnverified,'readiness-unverified'):
                    observer.ready(5)
                self.assertEqual(json.loads((state/'namespaces.json').read_text()),{})
                self.assertTrue(observer.snapshot()['registration']['cleanup_verified'])
                self.assertFalse(observer.snapshot()['registration']['ready'])
                observer.close(1)

    def test_echo_without_verified_namespace_removal_never_grants_readiness(self):
        observer,state=self.canary_observer('failed-delete')
        with self.assertRaisesRegex(ObserverUnverified,'readiness-unverified'):
            observer.ready(4)
        self.assertFalse(observer.snapshot()['registration']['cleanup_verified'])
        self.assertEqual(observer.snapshot()['registration']['category'],'canary-cleanup')
        self.assertTrue(json.loads((state/'namespaces.json').read_text()))
        with self.assertRaisesRegex(ObserverUnverified,'observer-cleanup'):
            observer.close(1)
        self.assertTrue(observer.snapshot()['reaped'])
        self.assertFalse(observer.snapshot()['cleanup_verified'])

    def test_timed_out_control_command_retires_children_after_its_leader_exits(self):
        observer,state=self.canary_observer('orphan-command',timeout=3)
        try:
            with self.assertRaisesRegex(ObserverUnverified,'readiness-unverified'):
                observer.ready(3)
            pid=int((state/'orphan.pid').read_text())
            limit=time.monotonic()+.5
            while time.monotonic()<limit:
                try: os.kill(pid,0)
                except ProcessLookupError: break
                time.sleep(.01)
            with self.assertRaises(ProcessLookupError): os.kill(pid,0)
        finally:
            if (state/'orphan.pid').exists():
                try: os.kill(int((state/'orphan.pid').read_text()),signal.SIGKILL)
                except ProcessLookupError: pass
        observer.close(.5)

    def test_control_eof_during_namespace_cleanup_cannot_grant_readiness(self):
        import threading
        observer,state=self.canary_observer('cancel-during-cleanup')
        def disconnect_owner():
            limit=time.monotonic()+3
            while not (state/'cleanup-ready').exists() and time.monotonic()<limit: time.sleep(.005)
            observer.process.stdin.close()
            (state/'continue-cleanup').touch()
        thread=threading.Thread(target=disconnect_owner)
        thread.start()
        try:
            with self.assertRaisesRegex(ObserverUnverified,'readiness-unverified'):
                observer.ready(4)
            self.assertEqual(json.loads((state/'namespaces.json').read_text()),{})
            self.assertTrue(observer.snapshot()['registration']['cleanup_verified'])
            self.assertFalse(observer.snapshot()['registration']['ready'])
        finally: thread.join(4)
        observer.close(1)

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
                    launcher=[sys.executable,'-I','-u','-c',adapter+LINUX_ROOT_SIGNAL_ADAPTER+SUPERVISOR,
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
                    launcher=[sys.executable,'-I','-u','-c',adapter+LINUX_ROOT_SIGNAL_ADAPTER+SUPERVISOR,
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
                process=subprocess.Popen([sys.executable,'-I','-u','-c',adapter+LINUX_ROOT_SIGNAL_ADAPTER+SUPERVISOR,
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
        observer=self.observer('',timeout=0.03,startup_delay=0.3)
        startup_limit=time.monotonic()+2
        while not self.cli_pid_file.exists() and time.monotonic()<startup_limit:
            time.sleep(0.005)
        self.assertTrue(self.cli_pid_file.exists(),'owned test child did not become ready')
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


class ExplicitOwnedObserverBoundary(unittest.TestCase):
    def test_data_only_binding_refuses_before_new_privileged_subscriber(self):
        from unittest.mock import patch
        from containerd_observer import ContainerdObserver
        with patch('subprocess.Popen',side_effect=AssertionError('untyped binding started privilege')):
            with self.assertRaisesRegex(ValueError,'typed host daemon binding'):
                ContainerdObserver('/usr/bin/ctr','/run/containerd/containerd.sock','moby',1,host_binding={'ok':True})

if __name__ == '__main__':
    unittest.main()

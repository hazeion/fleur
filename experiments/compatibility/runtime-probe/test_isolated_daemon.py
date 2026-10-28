"""Counterfactual scope and endpoint invariants; privileged proof belongs to CI."""
import os
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from isolated_daemon import CLEANUP_SECONDS, Endpoint, IsolatedDaemonError, eligible_host, isolated_vfs_daemon

def timeout_fixture(root):
    """Cheap native timeout stand-in; child is always killed and reaped on expiry."""
    import subprocess
    source=root/'timeout.c'; binary=root/'fixture-timeout'
    source.write_text(r'''
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec+t.tv_nsec/1e9; }
int main(int n,char **a) {
 int i=1; while(i<n && (!strncmp(a[i],"--signal=",9)||!strncmp(a[i],"--kill-after=",13)))i++;
 if(i+1>=n)return 2;
 double end=now()+atof(a[i++]);
 pid_t child=fork(); if(child<0)return 2;
 if(!child){
   if(!strcmp(a[i],"/usr/bin/env")){setenv("CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS","true",1);i+=2;}
   execvp(a[i],a+i);_exit(127);
 }
 int status=0;
 for(;;){if(waitpid(child,&status,WNOHANG)==child)return WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);
   if(now()>=end){kill(child,SIGKILL);waitpid(child,&status,0);return 124;}usleep(1000);}
}
''')
    subprocess.run(['cc','-O2',str(source),'-o',str(binary)],check=True,capture_output=True,timeout=10)
    return binary

def daemon_fixture(root):
    """Native signal-aware fake daemon keeps Python startup out of lifecycle timing."""
    import subprocess
    source=root/'daemon.c';binary=root/'fixture-daemon'
    source.write_text(r'''
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
static void stop(int s) { (void)s; _exit(0); }
int main(int n,char **a) {
 signal(SIGTERM,stop);
 for(int i=1;i+1<n;i++) {
   if(!strcmp(a[i],"--data-root")||!strcmp(a[i],"--exec-root"))mkdir(a[i+1],0700);
   if(!strcmp(a[i],"--pidfile")){FILE *p=fopen(a[i+1],"w");if(!p)return 2;fprintf(p,"%ld",(long)getpid());fclose(p);}
 }
 char path[4096];snprintf(path,sizeof(path),"%s",a[0]);char *end=strrchr(path,'/');if(!end)return 2;
 strcpy(end+1,"docker.sock");FILE *p=fopen(path,"w");if(!p)return 2;fputs("fixture-ready",p);fclose(p);
 strcpy(end+1,"ready");p=fopen(path,"w");if(!p)return 2;fputs("ready",p);fclose(p);
 for(;;)pause();
}
''')
    subprocess.run(['cc','-O2',str(source),'-o',str(binary)],check=True,capture_output=True,timeout=10)
    return binary

class OwnedCounterfactual(unittest.TestCase):
    def test_endpoint_cannot_inherit_context_or_tls_redirects(self):
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-endpoint-') as temporary:
            hostile = {'DOCKER_CONTEXT':'other-daemon', 'DOCKER_HOST':'tcp://other-daemon',
                       'DOCKER_TLS':'1', 'DOCKER_TLS_VERIFY':'1', 'DOCKER_CERT_PATH':'private',
                       'DOCKER_API_VERSION':'1.12', 'PATH':'fixture-path'}
            with patch.dict(os.environ, hostile):
                endpoint = Endpoint(Path(temporary), 'fleur-vfs-'+'a'*32, 0)
            self.assertEqual(endpoint.environment['DOCKER_HOST'], 'unix://'+temporary+'/docker.sock')
            self.assertEqual(endpoint.environment['PATH'], 'fixture-path')
            for key in hostile.keys()-{'PATH','DOCKER_HOST'}:
                self.assertFalse(key in endpoint.environment, 'Docker redirect retained')

    def test_unapproved_job_or_platform_cannot_launch_daemon(self):
        with patch('isolated_daemon.eligible_host', return_value=False), patch('isolated_daemon.subprocess.Popen') as launch:
            with self.assertRaises(IsolatedDaemonError):
                with isolated_vfs_daemon():
                    self.fail('unapproved host entered context')
            launch.assert_not_called()

    def test_only_fixed_hosted_counterfactual_job_is_eligible(self):
        expected = {'GITHUB_ACTIONS':'true', 'RUNNER_ENVIRONMENT':'github-hosted', 'RUNNER_OS':'Linux',
                    'GITHUB_REPOSITORY':'hazeion/fleur', 'GITHUB_WORKFLOW':'Compatibility experiments',
                    'GITHUB_JOB':'runtime-vfs-counterfactual'}
        with patch('isolated_daemon.platform.system', return_value='Linux'), patch.dict(os.environ, expected):
            self.assertTrue(eligible_host())
            with patch.dict(os.environ, {'GITHUB_JOB':'runtime-probe'}):
                self.assertFalse(eligible_host())
            with patch.dict(os.environ, {'RUNNER_ENVIRONMENT':'self-hosted'}):
                self.assertFalse(eligible_host())

    def test_lifetime_and_runner_temp_must_be_valid_before_launch(self):
        with patch('isolated_daemon.eligible_host', return_value=True), patch('isolated_daemon.subprocess.Popen') as launch:
            for value in (True, 0, 44, 541, float('inf')):
                with self.subTest(value=value), self.assertRaises(IsolatedDaemonError):
                    with isolated_vfs_daemon(lifetime=value):
                        self.fail('invalid lifetime entered context')
            with patch.dict(os.environ, {'RUNNER_TEMP':'relative-path'}), self.assertRaises(IsolatedDaemonError):
                with isolated_vfs_daemon():
                    self.fail('invalid temporary root entered context')
            launch.assert_not_called()

    def test_root_supervisor_shell_stops_owned_child_and_preserves_unrelated_paths(self):
        # Actual POSIX shell/process fixture; substitutions represent only the
        # unavailable local dockerd and Linux comm file, not lifecycle checks.
        import shlex
        import subprocess
        import time
        from isolated_daemon import ROOT_BODY, ROOT_CAPTURE_COMMAND, ROOT_REMOVE_COMMAND
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-supervisor-') as temporary:
            root = Path(temporary)
            token = 'fleur-vfs-'+'b'*32
            (root/'owner').write_text(token)
            (root/'comm').write_text('dockerd\n')
            (root/'unrelated').write_text('preserve')
            daemon = daemon_fixture(root)
            body = ROOT_BODY.replace(ROOT_CAPTURE_COMMAND,"printf '{}'").replace(ROOT_REMOVE_COMMAND,'rm -rf -- "$base/data" "$base/exec"').replace('/usr/bin/dockerd', shlex.quote(str(daemon))).replace('"/proc/$child/comm"', shlex.quote(str(root/'comm')))
            body = body.replace('record=$(cat "/proc/$child/stat")', 'record="$child (fixture) S $$ $$"')
            body = body.replace('ctr_owned --address', '/usr/bin/true --address')
            process = subprocess.Popen(['/bin/sh','-c',body,'fixture',json.dumps([root.stat().st_dev,root.stat().st_ino,root.stat().st_uid]),str(root),token,str(os.getgid())],
                                       stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                ready = time.monotonic()+2
                while not (root/'ready').exists() and time.monotonic()<ready:
                    time.sleep(.01)
                self.assertTrue((root/'ready').exists(), 'daemon premise not ready')
                pid = int((root/'docker.pid').read_text())
                output, errors = process.communicate(b'stop\n',timeout=5)
                self.assertEqual(process.returncode,0)
                self.assertEqual(output,b'stopped\n')
                self.assertEqual(errors,b'')
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid,0)
                self.assertFalse((root/'data').exists())
                self.assertFalse((root/'exec').exists())
                self.assertEqual((root/'unrelated').read_text(),'preserve')
            finally:
                if process.poll() is None:
                    process.kill();process.wait(timeout=1)
                for stream in (process.stdin,process.stdout,process.stderr):
                    stream.close()

    def test_unverified_initial_mount_snapshot_cannot_launch_normal_daemon(self):
        import subprocess
        import isolated_daemon as module
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-no-owner-') as temporary:
            root=Path(temporary);token='fleur-vfs-'+'b'*32
            (root/'owner').write_text(token)
            # The real shell must stop before invoking Docker when its root
            # ownership/mount-table boundary cannot establish the initial identity.
            body=module.ROOT_BODY.replace(module.ROOT_CAPTURE_COMMAND,'/usr/bin/false')
            body=body.replace('/usr/bin/dockerd','touch "'+str(root/'launched')+'"')
            result=subprocess.run(['/bin/sh','-c',body,'fixture',json.dumps([root.stat().st_dev,root.stat().st_ino,root.stat().st_uid]),str(root),token,str(os.getgid())],
                                  input=b'stop\n',capture_output=True,timeout=3)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse((root/'launched').exists())

    def test_failed_inspection_cannot_skip_actual_supervisor_stop_and_reap(self):
        import shlex
        import subprocess
        import sys
        from isolated_daemon import ROOT_BODY, ROOT_CAPTURE_COMMAND, ROOT_REMOVE_COMMAND
        real_popen = subprocess.Popen
        processes = []
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-failure-',dir='/tmp') as temporary:
            compiled_daemon=daemon_fixture(Path(temporary))
            def launch(arguments, **kwargs):
                root = Path(arguments[-3])
                (root/'comm').write_text('dockerd\n')
                import shutil
                fixture=root/'fixture-daemon'
                shutil.copyfile(compiled_daemon,fixture);fixture.chmod(0o700)
                body = ROOT_BODY.replace(ROOT_CAPTURE_COMMAND,"printf '{}'").replace(ROOT_REMOVE_COMMAND,'rm -rf -- "$base/data" "$base/exec"').replace('/usr/bin/dockerd',shlex.quote(str(fixture)))
                body = body.replace('"/proc/$child/comm"',shlex.quote(str(root/'comm')))
                body = body.replace('record=$(cat "/proc/$child/stat")','record="$child (fixture) S $$ $$"')
                body = body.replace('ctr_owned --address','/usr/bin/true --address')
                process = real_popen(['/bin/sh','-c',body,'fixture',*arguments[-4:]],**kwargs)
                processes.append(process)
                import time
                deadline = time.monotonic()+2
                while not (root/'docker.sock').exists() and time.monotonic()<deadline:
                    time.sleep(.01)
                if not (root/'docker.sock').exists():
                    details = (root/'daemon.log').read_text() if (root/'daemon.log').exists() else 'no fixture log'
                    process.communicate(b'stop\n',timeout=3)
                    self.fail('fixture startup failed: '+details)
                return process
            def verified(endpoint):
                endpoint.facts = {'driver':'vfs'}
            endpoint = None
            try:
                with patch('isolated_daemon.eligible_host',return_value=True), patch.dict(os.environ,{'RUNNER_TEMP':temporary}), \
                     patch('isolated_daemon._default_identity',return_value={'ID':'fixture','Driver':'overlay2','DockerRootDir':'fixture'}), \
                     patch('isolated_daemon.subprocess.Popen',side_effect=launch), patch.object(Endpoint,'verify',verified), \
                     patch.object(Endpoint,'command',side_effect=subprocess.TimeoutExpired('inspection',1)):
                    with self.assertRaises(IsolatedDaemonError):
                        with isolated_vfs_daemon(lifetime=45) as endpoint:
                            self.assertEqual(len(processes),1)
                self.assertIsNotNone(endpoint)
                self.assertEqual(processes[0].returncode,0,'supervisor was not stopped/reaped')
                self.assertFalse(endpoint.cleanup_verified)
                self.assertTrue(endpoint.facts['default_daemon_unchanged'])
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.wait(timeout=3)

    def test_forced_retirement_targets_only_two_owned_namespaces_and_verifies_absence(self):
        import shlex
        import subprocess
        import sys
        from isolated_daemon import RETIRE_BODY, MOUNT_RETIRE_COMMAND, ROOT_REMOVE_COMMAND
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-retirement-') as temporary:
            root=Path(temporary); token='fleur-vfs-'+'c'*32
            (root/'owner').write_text(token); (root/'docker.pid').write_text('2147483647')
            (root/'data').mkdir(); (root/'exec').mkdir()
            (root/'unrelated').write_text('preserve')
            cli=root/'fixture-ctr'
            program = ('import sys; from pathlib import Path; a=sys.argv; root=Path('+repr(str(root))+'); '
                       'ns=a[a.index("--namespace")+1]; '
                       'assert ns in ['+repr(token)+','+repr(token+'-plugins')+']; '
                       'with_log=root/"calls"; '
                       'with_log.open("a").write(ns+" "+" ".join(a[a.index("tasks"):])+"\\n"); '
                       'done=root/(ns+".done"); '
                       'cmd=a[a.index("tasks")+1]; '
                       'print("a"*64) if cmd=="list" and not done.exists() else None; '
                       'done.write_text("retired") if cmd=="delete" else None')
            cli.write_text('#!'+sys.executable+'\n'+program+'\n');cli.chmod(0o700)
            body=RETIRE_BODY.replace(ROOT_REMOVE_COMMAND,'rm -rf -- "$base/data" "$base/exec"').replace(MOUNT_RETIRE_COMMAND,'printf \'0\\n\'').replace('ctr_owned --address',shlex.quote(str(cli))+' --address')
            result=subprocess.run(['/bin/sh','-c',body,'fixture',str(root),token,'10000','{}','2147483647','1'],
                                  text=True,capture_output=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout,'retired\n')
            calls=(root/'calls').read_text()
            for namespace in (token,token+'-plugins'):
                self.assertIn(namespace+' tasks kill --all --signal SIGKILL '+'a'*64,calls)
                self.assertIn(namespace+' tasks delete --force '+'a'*64,calls)
            self.assertNotIn('moby ',calls)
            self.assertFalse((root/'data').exists());self.assertFalse((root/'exec').exists())
            self.assertEqual((root/'unrelated').read_text(),'preserve')
            # A failed owned-root removal must preserve the roots and expose a
            # numeric return code without returning the success marker.
            (root/'docker.pid').write_text('2147483647')
            (root/'data').mkdir();(root/'exec').mkdir()
            remove=root/'fixture-remove'
            remove.write_text('#!/bin/sh\nprintf "private-path: Device or resource busy\\n" >&2\nexit 1\n')
            remove.chmod(0o700)
            failing=body.replace('rm -rf -- "$base/data" "$base/exec"',shlex.quote(str(remove)))
            failed=subprocess.run(['/bin/sh','-c',failing,'fixture',str(root),token,'10000','{}','2147483647','1'],
                                  text=True,capture_output=True,timeout=5)
            self.assertNotEqual(failed.returncode,0)
            self.assertEqual(failed.stdout,'')
            self.assertTrue((root/'data').exists());self.assertTrue((root/'exec').exists())
            from isolated_daemon import retirement_observations
            evidence=retirement_observations(root,failed.returncode,failed.stdout.encode())
            self.assertEqual(evidence['last_stage'],15)
            self.assertEqual(evidence['last_command_returncode'],1)
            self.assertEqual(evidence['last_count'],1)
            self.assertNotIn('private-path',str(evidence))

    def test_capture_cli_reports_safe_failure_without_private_paths_or_traceback(self):
        import subprocess
        import sys
        from isolated_daemon import MOUNT_PROGRAM
        with tempfile.TemporaryDirectory(prefix='fleur-private-capture-') as temporary:
            root=Path(temporary).resolve();record=root.stat()
            result=subprocess.run([sys.executable,'-I','-c',MOUNT_PROGRAM,'capture',str(root),
                                   'fleur-vfs-'+'a'*32,json.dumps([record.st_dev,record.st_ino,record.st_uid])],
                                  capture_output=True,timeout=5,check=False)
            self.assertEqual(result.returncode,1)
            payload=json.loads(result.stdout)
            self.assertEqual(payload['capture_error']['phase'],'owner')
            self.assertEqual(payload['capture_error']['category'],'filesystem')
            self.assertEqual(payload['capture_error']['errno'],2)
            self.assertLessEqual(len(result.stdout),2048)
            self.assertEqual(result.stderr,b'')
            self.assertNotIn(str(root).encode(),result.stdout)

    def test_capture_failure_observations_distinguish_timeout_and_reject_raw_details(self):
        import subprocess
        import owned_mounts
        from isolated_daemon import capture_observations
        failure={'phase':'mount-plan','category':'shared-parent',
                 'layout':dict.fromkeys(owned_mounts.LAYOUT_COUNTS,0)}
        failure['layout']['shared_parent']=1
        result=subprocess.CompletedProcess([],1,json.dumps({'capture_error':failure}).encode(),b'private stderr')
        facts=capture_observations(result,17)
        self.assertEqual(facts['cli_returncode'],1)
        self.assertEqual(facts['elapsed_ms'],17)
        self.assertEqual(facts['capture_error'],failure)
        self.assertNotIn('private stderr',str(facts))
        timeout=subprocess.CompletedProcess([],124,b'',b'')
        self.assertEqual(capture_observations(timeout,9700)['cli_returncode'],124)
        malformed={'phase':'/private/path','category':'shared-parent','raw':'secret'}
        result=subprocess.CompletedProcess([],1,json.dumps({'capture_error':malformed}).encode(),b'')
        facts=capture_observations(result,19)
        self.assertTrue(facts['diagnostic_invalid'])
        self.assertNotIn('/private/path',str(facts));self.assertNotIn('secret',str(facts))

    def test_capture_rejection_preserves_diagnostics_before_any_group_kill(self):
        import subprocess
        import time
        from isolated_daemon import _retire_supervisor
        real_text=Path.read_text;real_bytes=Path.read_bytes
        with tempfile.TemporaryDirectory(prefix='fleur-capture-failure-') as temporary:
            root=Path(temporary);token='fleur-vfs-'+'a'*32
            (root/'supervisor.pid').write_text('12345')
            endpoint=Endpoint(root,token,time.monotonic()+30)
            def text(path,*args,**kwargs):
                if str(path)=='/proc/12345/comm':return 'timeout\n'
                if str(path)=='/proc/12345/stat':return '12345 (timeout) S 1 12345 0\n'
                return real_text(path,*args,**kwargs)
            def binary(path,*args,**kwargs):
                if str(path)=='/proc/12345/cmdline':
                    return b'/usr/bin/timeout\0'+str(root).encode()+b'\0'+token.encode()+b'\0'
                return real_bytes(path,*args,**kwargs)
            diagnostic={'phase':'mount-plan','category':'shared-parent'}
            result=subprocess.CompletedProcess([],1,json.dumps({'capture_error':diagnostic}).encode(),b'private error')
            try:
                with patch.object(Path,'read_text',text),patch.object(Path,'read_bytes',binary), \
                     patch('isolated_daemon.subprocess.run',return_value=result) as command:
                    with self.assertRaises(IsolatedDaemonError) as raised:_retire_supervisor(endpoint,5)
                self.assertEqual(command.call_count,1)
                self.assertIn('capture',command.call_args.args[0])
                self.assertEqual(raised.exception.observations['capture_error'],diagnostic)
                self.assertEqual(raised.exception.observations['cli_returncode'],1)
                self.assertGreaterEqual(raised.exception.observations['elapsed_ms'],0)
                self.assertNotIn('private error',str(raised.exception))
            finally:endpoint.close()

    def test_retirement_failure_journal_is_bounded_numeric_and_redacted(self):
        from isolated_daemon import retirement_observations
        with tempfile.TemporaryDirectory(prefix='fleur-retire-journal-') as temporary:
            root=Path(temporary)
            (root/'retirement.facts').write_text('1 1 0 1\n3 1 0 1\n4 1 124 1\n')
            facts=retirement_observations(root,124,b'')
            self.assertEqual(facts['cli_returncode'],124)
            self.assertEqual(facts['last_stage'],4)
            self.assertEqual(facts['last_namespace'],1)
            self.assertEqual(facts['last_command_returncode'],124)
            self.assertEqual(facts['last_count'],1)
            self.assertEqual(facts.get('stages'),[[1,1,0,1],[3,1,0,1],[4,1,124,1]])
            for malformed in ('1 1 0 /private/path\n','99 1 0 1\n','1 3 0 1\n','x'*8193):
                (root/'retirement.facts').write_text(malformed)
                result=retirement_observations(root,1,b'')
                self.assertTrue(result['journal_invalid'])
                self.assertNotIn('private',str(result))

    def test_delayed_cli_startup_can_retire_owned_tasks_inside_original_budget(self):
        import shlex
        import subprocess
        import sys
        import time
        from isolated_daemon import RETIRE_BODY, MOUNT_RETIRE_COMMAND, ROOT_REMOVE_COMMAND
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-delayed-') as temporary:
            root=Path(temporary);token='fleur-vfs-'+'d'*32
            (root/'owner').write_text(token);(root/'docker.pid').write_text('2147483647')
            (root/'data').mkdir();(root/'exec').mkdir()
            cli=root/'fixture-ctr'; timer=root/'fixture-timeout'
            program=('import sys,time; from pathlib import Path; time.sleep(.6); a=sys.argv; '
                     'root=Path('+repr(str(root))+'); ns=a[a.index("--namespace")+1]; '
                     'assert ns in ['+repr(token)+','+repr(token+'-plugins')+']; '
                     'done=root/(ns+".done"); cmd=a[a.index("tasks")+1]; '
                     'print("a"*64) if cmd=="list" and not done.exists() else None; '
                     'done.write_text("retired") if cmd=="delete" else None')
            cli.write_text('#!'+sys.executable+'\n'+program+'\n');cli.chmod(0o700)
            timer=timeout_fixture(root)
            body=RETIRE_BODY.replace(ROOT_REMOVE_COMMAND,'rm -rf -- "$base/data" "$base/exec"').replace(MOUNT_RETIRE_COMMAND,'printf \'0\\n\'').replace('/usr/bin/timeout',shlex.quote(str(timer))).replace('/usr/bin/ctr',shlex.quote(str(cli)))
            body=body.replace('/usr/bin/python3',shlex.quote(sys.executable))
            clock='clock_ms() { IFS= read -r now < '+shlex.quote(str(root/'clock'))+'; printf \'%s\\n\' "$now"; }\n'
            begin=body.index('clock_ms()'); finish=body.index('ctr_owned()',begin)
            body=body[:begin]+clock+body[finish:]
            import threading
            finished=threading.Event()
            def clock_writer():
                while not finished.is_set():
                    (root/'clock.new').write_text(str(int(time.monotonic()*1000))+'\n')
                    (root/'clock.new').replace(root/'clock')
                    finished.wait(.01)
            (root/'clock').write_text(str(int(time.monotonic()*1000))+'\n')
            thread=threading.Thread(target=clock_writer);thread.start()
            started=time.monotonic()
            try:
                result=subprocess.run(['/bin/sh','-c',body,'fixture',str(root),token,'10000','{}','2147483647','1'],
                                      text=True,capture_output=True,timeout=10)
            finally:
                finished.set();thread.join(timeout=1)
            self.assertEqual(result.returncode,0,'delayed CLI never reached kill/delete')
            self.assertEqual(result.stdout,'retired\n')
            self.assertLess(time.monotonic()-started,10)
            for namespace in (token,token+'-plugins'):
                self.assertTrue((root/(namespace+'.done')).exists())

    def test_single_slow_cli_startup_uses_remaining_retirement_budget(self):
        import shlex
        import subprocess
        import sys
        import time
        from isolated_daemon import RETIRE_BODY, MOUNT_RETIRE_COMMAND, ROOT_REMOVE_COMMAND
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-delayed-') as temporary:
            root=Path(temporary);token='fleur-vfs-'+'d'*32
            (root/'owner').write_text(token);(root/'docker.pid').write_text('2147483647')
            (root/'data').mkdir();(root/'exec').mkdir()
            cli=root/'fixture-ctr'; timer=root/'fixture-timeout'
            program=('import sys,time; from pathlib import Path; a=sys.argv; '
                     'root=Path('+repr(str(root))+'); ns=a[a.index("--namespace")+1]; '
                     'assert ns in ['+repr(token)+','+repr(token+'-plugins')+']; '
                     'time.sleep(2.15) if not (root/"started").exists() else None; (root/"started").touch(); '
                     'done=root/(ns+".done"); cmd=a[a.index("tasks")+1]; '
                     'print("a"*64) if cmd=="list" and not done.exists() else None; '
                     'done.write_text("retired") if cmd=="delete" else None')
            cli.write_text('#!'+sys.executable+'\n'+program+'\n');cli.chmod(0o700)
            timer=timeout_fixture(root)
            body=RETIRE_BODY.replace(ROOT_REMOVE_COMMAND,'rm -rf -- "$base/data" "$base/exec"').replace(MOUNT_RETIRE_COMMAND,'printf \'0\\n\'').replace('/usr/bin/timeout',shlex.quote(str(timer))).replace('/usr/bin/ctr',shlex.quote(str(cli)))
            body=body.replace('/usr/bin/python3',shlex.quote(sys.executable))
            clock='clock_ms() { IFS= read -r now < '+shlex.quote(str(root/'clock'))+'; printf \'%s\\n\' "$now"; }\n'
            begin=body.index('clock_ms()'); finish=body.index('ctr_owned()',begin)
            body=body[:begin]+clock+body[finish:]
            import threading
            finished=threading.Event()
            def clock_writer():
                while not finished.is_set():
                    (root/'clock.new').write_text(str(int(time.monotonic()*1000))+'\n')
                    (root/'clock.new').replace(root/'clock')
                    finished.wait(.01)
            (root/'clock').write_text(str(int(time.monotonic()*1000))+'\n')
            thread=threading.Thread(target=clock_writer);thread.start()
            started=time.monotonic()
            try:
                result=subprocess.run(['/bin/sh','-c',body,'fixture',str(root),token,'10000','{}','2147483647','1'],
                                      text=True,capture_output=True,timeout=10)
            finally:
                finished.set();thread.join(timeout=1)
            self.assertEqual(result.returncode,0,'delayed CLI never reached kill/delete')
            self.assertEqual(result.stdout,'retired\n')
            self.assertLess(time.monotonic()-started,10)
            for namespace in (token,token+'-plugins'):
                self.assertTrue((root/(namespace+'.done')).exists())

    def test_replacement_after_normal_child_success_cannot_be_deleted_or_reported_clean(self):
        import io
        import subprocess
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-final-replacement-') as temporary:
            parent=Path(temporary).resolve();replacement=None;original=None
            class Process:
                def __init__(self,arguments,**kwargs):
                    self.root=Path(arguments[-3]);self.returncode=None
                    self.stdin=io.BytesIO();self.stdout=io.BytesIO()
                    (self.root/'docker.pid').write_text('12345')
                    (self.root/'docker.sock').write_text('ready')
                def poll(self):return self.returncode
                def communicate(self,**kwargs):
                    nonlocal replacement,original
                    original=parent/'preserved-original';self.root.rename(original)
                    replacement=self.root;replacement.mkdir(mode=0o700)
                    (replacement/'unrelated').write_text('preserve')
                    self.returncode=0;return b'stopped\n',None
            def verified(endpoint):endpoint.facts={'driver':'vfs'}
            with patch('isolated_daemon.eligible_host',return_value=True), \
                 patch.dict(os.environ,{'RUNNER_TEMP':str(parent)}), \
                 patch('isolated_daemon._default_identity',return_value={'ID':'unchanged'}), \
                 patch('isolated_daemon.subprocess.Popen',side_effect=Process), \
                 patch.object(Endpoint,'verify',verified), \
                 patch.object(Endpoint,'command',return_value=subprocess.CompletedProcess([],0,b'',b'')):
                with self.assertRaises(IsolatedDaemonError):
                    with isolated_vfs_daemon(lifetime=45) as endpoint:pass
            self.assertFalse(endpoint.cleanup_verified)
            self.assertEqual((replacement/'unrelated').read_text(),'preserve')
            self.assertTrue(original.is_dir())

    def test_final_root_cleanup_rejects_unexpected_directories_without_traversal(self):
        import time
        with tempfile.TemporaryDirectory(prefix='fleur-final-mounted-') as temporary:
            root=Path(temporary).resolve()/'owned';root.mkdir(mode=0o700)
            (root/'unexpected').mkdir();(root/'unexpected/keep').write_text('preserve')
            endpoint=Endpoint(root,'fleur-vfs-'+'a'*32,time.monotonic()+5)
            try:
                with self.assertRaises(IsolatedDaemonError):endpoint.remove_root()
                self.assertEqual((root/'unexpected/keep').read_text(),'preserve')
            finally:endpoint.close()

    def test_final_root_cleanup_rejects_replacement_and_preserves_both_directories(self):
        import time
        with tempfile.TemporaryDirectory(prefix='fleur-final-original-') as temporary:
            parent=Path(temporary);root=parent/'owned';root.mkdir(mode=0o700)
            (root/'original').write_text('original')
            endpoint=Endpoint(root,'fleur-vfs-'+'a'*32,time.monotonic()+5)
            try:
                original=parent/'saved';root.rename(original);root.mkdir(mode=0o700)
                (root/'unrelated').write_text('preserve')
                with self.assertRaises(IsolatedDaemonError):endpoint.remove_root()
                self.assertEqual((root/'unrelated').read_text(),'preserve')
                self.assertEqual((original/'original').read_text(),'original')
            finally:endpoint.close()

    def test_replaced_root_cannot_authorize_forced_kill_or_remove_replacement_contents(self):
        import json
        import subprocess
        import time
        import owned_mounts
        from isolated_daemon import _retire_supervisor
        real_text=Path.read_text;real_bytes=Path.read_bytes
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-original-root-') as temporary:
            parent=Path(temporary).resolve();root=parent/'owned';root.mkdir(mode=0o700)
            token='fleur-vfs-'+'a'*32
            (root/'owner').write_text(token);(root/'supervisor.pid').write_text('12345')
            endpoint=Endpoint(root,token,time.monotonic()+30)
            original=parent/'original';root.rename(original);root.mkdir(mode=0o700)
            (root/'owner').write_text(token);(root/'supervisor.pid').write_text('12345')
            (root/'data').mkdir();(root/'exec').mkdir();(root/'data/unrelated').write_text('preserve')
            actions=[];snapshot=None
            def text(path,*args,**kwargs):
                if str(path)=='/proc/12345/comm':return 'timeout\n'
                if str(path)=='/proc/12345/stat':return '12345 (timeout) S 1 12345 0\n'
                return real_text(path,*args,**kwargs)
            def binary(path,*args,**kwargs):
                if str(path)=='/proc/12345/cmdline':
                    return b'/usr/bin/timeout\0'+str(root).encode()+b'\0'+token.encode()+b'\0'
                return real_bytes(path,*args,**kwargs)
            def command(arguments,**kwargs):
                nonlocal snapshot
                if 'capture' in arguments:
                    snapshot=owned_mounts.capture(root,token)
                    return subprocess.CompletedProcess(arguments,0,json.dumps(snapshot).encode(),b'')
                if '/bin/kill' in arguments:
                    actions.append('kill');return subprocess.CompletedProcess(arguments,0,b'',b'')
                actions.append('remove');owned_mounts.remove_roots(root,token,snapshot)
                return subprocess.CompletedProcess(arguments,0,b'retired\n',b'')
            with patch.object(Path,'read_text',text),patch.object(Path,'read_bytes',binary), \
                 patch('owned_mounts._table',return_value='1 0 8:1 / / rw - ext4 /dev/root rw\n'), \
                 patch('isolated_daemon.subprocess.run',side_effect=command):
                with self.assertRaises(IsolatedDaemonError):_retire_supervisor(endpoint,5)
            self.assertEqual(actions,[])
            self.assertEqual((root/'data/unrelated').read_text(),'preserve')
            self.assertTrue(original.is_dir())

    def test_late_observation_cannot_escape_overall_retirement_deadline(self):
        import sys
        import time
        from isolated_daemon import _retire_supervisor
        real_text=Path.read_text; real_bytes=Path.read_bytes
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-late-') as temporary:
            root=Path(temporary);token='fleur-vfs-'+'e'*32
            (root/'supervisor.pid').write_text('12345')
            executable=root/'sudo'
            executable.write_text('#!/bin/sh\ncase "$*" in *" capture "*) printf \'{"root":ROOT_ID_FIXTURE,"mounts":[]}\\n\'; exit 0 ;; esac\ncase "$2" in /bin/kill) exit 0 ;; /usr/bin/timeout) printf "retired\\n" ;; *) exit 9 ;; esac\n'.replace('ROOT_ID_FIXTURE',json.dumps([root.stat().st_dev,root.stat().st_ino,root.stat().st_uid])))
            executable.chmod(0o700)
            def text(path,*args,**kwargs):
                if str(path)=='/proc/12345/comm': return 'timeout\n'
                if str(path)=='/proc/12345/stat': return '12345 (timeout) S 1 12345 0'
                return real_text(path,*args,**kwargs)
            def binary(path,*args,**kwargs):
                if str(path)=='/proc/12345/cmdline':
                    return b'/usr/bin/timeout\0'+str(root).encode()+b'\0'+token.encode()+b'\0'
                return real_bytes(path,*args,**kwargs)
            def delayed_observations(*args):
                time.sleep(1.05)
                return {'cli_returncode':0}
            endpoint=Endpoint(root,token,time.monotonic()+5)
            endpoint.daemon_identity=(2147483647,1)
            with patch.dict(os.environ,{'PATH':temporary+os.pathsep+os.environ['PATH']}), \
                 patch.object(Path,'read_text',text),patch.object(Path,'read_bytes',binary), \
                 patch('isolated_daemon.retirement_observations',side_effect=delayed_observations):
                self.assertFalse(_retire_supervisor(endpoint,1),'late successful output escaped overall deadline')

    def test_owned_mount_count_includes_only_exact_data_exec_trees(self):
        from isolated_daemon import owned_mount_count
        root=Path('/runner/fleur-vfs-owned')
        body=('1 0 0:1 / / rw - ext4 /dev/root rw\n'
              '2 1 0:2 / /runner/fleur-vfs-owned/data/containers/a/shm rw - tmpfs shm rw\n'
              '3 1 0:3 / /runner/fleur-vfs-owned/exec rw - tmpfs state rw\n'
              '4 1 0:4 / /runner/fleur-vfs-owned/data-other rw - tmpfs unrelated rw\n'
              '5 1 0:5 / /var/lib/docker/containers/a/shm rw - tmpfs default rw\n')
        self.assertEqual(owned_mount_count(body,root),2)
        self.assertEqual(owned_mount_count(body.replace('fleur-vfs-owned','fleur-vfs-owned\\040space'),Path('/runner/fleur-vfs-owned space')),2)
        self.assertNotIn('/var/lib/docker',str(owned_mount_count(body,root)))

class RetainedDaemonRetirement(unittest.TestCase):
    def test_deleted_pidfile_does_not_block_verified_absent_daemon_retirement(self):
        import subprocess
        from isolated_daemon import RETIRE_BODY, MOUNT_RETIRE_COMMAND, ROOT_REMOVE_COMMAND
        with tempfile.TemporaryDirectory(prefix='fleur-retained-daemon-') as temporary:
            root=Path(temporary);token='fleur-vfs-'+'a'*32
            (root/'owner').write_text(token);(root/'data').mkdir();(root/'exec').mkdir()
            body=RETIRE_BODY.replace('retire_namespaces\n', ':\n')
            body=body.replace(MOUNT_RETIRE_COMMAND, "printf '0\\n'")
            body=body.replace(ROOT_REMOVE_COMMAND,'rmdir "$base/data" "$base/exec"')
            body=body.replace('"/proc/$daemon/stat"','"$base/fixture-proc-stat"')
            result=subprocess.run(['/bin/sh','-c',body,'fixture',str(root),token,'10000','{}','2147483647','12345'],capture_output=True,text=True,timeout=3)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout,'retired\n')
            self.assertFalse((root/'data').exists());self.assertFalse((root/'exec').exists())

    def test_live_or_reused_daemon_identity_cannot_authorize_removal(self):
        import subprocess
        from isolated_daemon import RETIRE_BODY, MOUNT_RETIRE_COMMAND, ROOT_REMOVE_COMMAND
        for state,start in (('S','12345'),('Z','54321')):
            with self.subTest(state=state,start=start),tempfile.TemporaryDirectory(prefix='fleur-retained-reject-') as temporary:
                root=Path(temporary);token='fleur-vfs-'+'a'*32
                (root/'owner').write_text(token);(root/'data').mkdir();(root/'exec').mkdir()
                fields=[state]+['0']*18+[start]
                (root/'fixture-proc-stat').write_text('2147483647 (dockerd) '+' '.join(fields))
                body=RETIRE_BODY.replace('retire_namespaces\n', ':\n')
                body=body.replace(MOUNT_RETIRE_COMMAND, "printf '0\\n'")
                body=body.replace(ROOT_REMOVE_COMMAND,'rmdir "$base/data" "$base/exec"')
                body=body.replace('"/proc/$daemon/stat"','"$base/fixture-proc-stat"')
                result=subprocess.run(['/bin/sh','-c',body,'fixture',str(root),token,'10000','{}','2147483647','12345'],capture_output=True,text=True,timeout=3)
                self.assertNotEqual(result.returncode,0)
                self.assertNotIn('retired',result.stdout)
                self.assertTrue((root/'data').exists());self.assertTrue((root/'exec').exists())

    def test_parent_timeout_accepts_only_independently_verified_retirement_and_reap(self):
        import io,subprocess,shutil
        from isolated_daemon import isolated_vfs_daemon
        for verified in (True,False):
            with self.subTest(verified=verified),tempfile.TemporaryDirectory(prefix='fleur-fallback-',dir='/tmp') as temporary:
                class Process:
                    def __init__(self,arguments,**kwargs):
                        self.root=Path(arguments[-3]);self.returncode=None
                        self.stdin=io.BytesIO();self.stdout=io.BytesIO()
                        for name in ('data','exec'):(self.root/name).mkdir()
                        (self.root/'docker.pid').write_text('2147483647')
                        (self.root/'docker.sock').write_text('fixture')
                    def poll(self):return self.returncode
                    def communicate(self,**kwargs):raise subprocess.TimeoutExpired('owned-supervisor',1)
                    def wait(self,**kwargs):self.returncode=-9;return -9
                def verify(endpoint):
                    endpoint.facts={'driver':'vfs'};endpoint.daemon_identity=(2147483647,12345)
                def remove_root(endpoint):
                    # The Linux unlink-count proof is tested natively in CI;
                    # APFS retains a nonzero open-directory link count.
                    endpoint.verify_root()
                    for path in endpoint.root.iterdir():path.unlink()
                    endpoint.root.rmdir()
                def retire(endpoint,budget):
                    self.assertGreater(budget,0);self.assertLessEqual(budget,CLEANUP_SECONDS)
                    if verified:
                        endpoint.retirement_facts={'cli_returncode':0,'stdout_bytes':8,'last_stage':12}
                        for name in ('data','exec'):shutil.rmtree(endpoint.root/name)
                        for name in ('docker.pid','docker.sock'):(endpoint.root/name).unlink()
                    return verified
                with patch('isolated_daemon.eligible_host',return_value=True),patch.dict(os.environ,{'RUNNER_TEMP':temporary}),patch('isolated_daemon._default_identity',return_value={'ID':'unchanged'}),patch('isolated_daemon.subprocess.Popen',side_effect=Process),patch.object(Endpoint,'verify',verify),patch.object(Endpoint,'command',return_value=subprocess.CompletedProcess([],0,b'',b'')),patch('isolated_daemon._retire_supervisor',side_effect=retire),patch.object(Endpoint,'remove_root',remove_root):
                    if verified:
                        with isolated_vfs_daemon(lifetime=45) as endpoint:pass
                        self.assertTrue(endpoint.cleanup_verified)
                        self.assertEqual(endpoint.retirement_facts['cli_returncode'],0)
                        self.assertEqual(endpoint.retirement_facts['last_stage'],12)
                        self.assertFalse(endpoint.root.exists())
                    else:
                        with self.assertRaises(IsolatedDaemonError):
                            with isolated_vfs_daemon(lifetime=45) as endpoint:pass
                        self.assertFalse(endpoint.cleanup_verified)
                        self.assertTrue((endpoint.root/'data').exists())

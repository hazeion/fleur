import json
import unittest
from daemon_trace import parse_stacks

class TraceSanitizer(unittest.TestCase):
    def test_only_canonical_function_names_and_states_leave_boundary(self):
        raw = '''goroutine 12 [semacquire]:
sync.runtime_SemacquireMutex(0x123, "private-token")
\t/private/workspace/secret.go:42 +0x12
github.com/docker/docker/container.(*State).Wait(0xabc, "DATABASE_URL=private-token")
created by net/http.(*Server).Serve in goroutine 9
\t/secret/daemon.go:7 +0x12
private-token(credential)
'''
        result = parse_stacks(raw)
        self.assertEqual(result['goroutines'],[{'state':'semacquire','functions':['sync.runtime_SemacquireMutex','github.com/docker/docker/container.(*State).Wait','net/http.(*Server).Serve']}])
        self.assertNotIn('private-token',json.dumps(result))
        self.assertNotIn('/secret',json.dumps(result))

class HostedCapture(unittest.TestCase):
    def test_other_hosts_cannot_signal_daemon(self):
        from unittest.mock import patch
        from daemon_trace import capture_daemon_trace
        with patch.dict('os.environ',{},clear=True),patch('daemon_trace.subprocess.Popen') as launch:
            self.assertEqual(capture_daemon_trace(5),{'outcome':'ineligible-host'})
            launch.assert_not_called()

    def test_invalid_pid_or_wrong_process_never_signals(self):
        from pathlib import Path
        import subprocess,tempfile
        from daemon_trace import TRACE_COMMAND
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);pid=root/'pid';comm=root/'comm';marker=root/'signal';trace=root/'trace';trace.mkdir()
            command=TRACE_COMMAND.replace('/var/run/docker.pid',str(pid)).replace('"/proc/$daemon/comm"',str(comm)).replace('/var/run/docker/goroutine-stacks-',str(trace/'goroutine-stacks-')).replace('kill -USR1 "$daemon"',f'printf signal > {marker}')
            for value,process in [('1','dockerd'),('abc','dockerd'),('99999999999','dockerd'),('42','unrelated')]:
                pid.write_text(value+'\n');comm.write_text(process+'\n')
                result=subprocess.run(['/bin/sh','-c',command],capture_output=True,timeout=1)
                self.assertNotEqual(result.returncode,0)
                self.assertFalse(marker.exists())

    def test_capture_cli_boundary_emits_only_safe_frames_and_reaps(self):
        import os,subprocess
        from unittest.mock import patch
        from daemon_trace import capture_daemon_trace
        factory=subprocess.Popen;processes=[]
        env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux','GITHUB_REPOSITORY':'hazeion/fleur','GITHUB_WORKFLOW':'Compatibility experiments','GITHUB_JOB':'runtime-probe'}
        def launch(args,**kwargs):
            self.assertEqual(args[:4],['sudo','-n','/bin/sh','-c'])
            self.assertTrue(kwargs['start_new_session'])
            self.assertNotIn('GITHUB_TOKEN',kwargs['env'])
            process=factory(['/bin/sh','-c',"printf 'trace-ready\\ngoroutine 7 [IO wait]:\\nnet.(*netFD).Read(secret-value)\\n\\t/private/secret.go:7\\n'"],**kwargs)
            processes.append(process);return process
        with patch.dict(os.environ,env,clear=True),patch('daemon_trace.platform.system',return_value='Linux'),patch('daemon_trace.subprocess.Popen',side_effect=launch):
            result=capture_daemon_trace(2)
        self.assertEqual(result['outcome'],'captured')
        self.assertNotIn('secret',json.dumps(result))
        self.assertEqual(result['goroutines'][0]['functions'],['net.(*netFD).Read'])
        self.assertIsNotNone(processes[0].poll());self.assertTrue(processes[0].stdout.closed)

    def test_stack_output_and_fanout_are_bounded(self):
        from daemon_trace import OUTPUT_LIMIT,parse_stacks
        raw=('goroutine 7 [IO wait]:\n'+'github.com/docker/docker/daemon.(*Daemon).monitorContainer(0x1)\n'*40)*300
        result=parse_stacks(raw)
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(json.dumps(result).encode()),OUTPUT_LIMIT)

    def test_relevant_daemon_frames_after_many_idle_rows_are_retained(self):
        raw=('goroutine 7 [IO wait]:\nruntime.gopark(0x1)\n'*300)+('goroutine 999 [chan receive]:\ngithub.com/docker/docker/container/stream.(*Config).Wait(0x1)\n')
        result=parse_stacks(raw)
        self.assertTrue(any('github.com/docker/docker/container/stream.(*Config).Wait' in row['functions'] for row in result['goroutines']))

    def test_timeout_supervisor_and_cleanup_are_inside_privileged_command(self):
        import os,subprocess
        from unittest.mock import patch
        from daemon_trace import capture_daemon_trace
        env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux','GITHUB_REPOSITORY':'hazeion/fleur','GITHUB_WORKFLOW':'Compatibility experiments','GITHUB_JOB':'runtime-probe'}
        factory=subprocess.Popen
        def launch(args,**kwargs):
            self.assertEqual(args[:4],['sudo','-n','/bin/sh','-c'])
            self.assertIn('/usr/bin/timeout --signal=TERM --kill-after=0.2s',args[4])
            self.assertIn("trap 'cleanup || exit 126' EXIT",args[4])
            self.assertIn('regular',args[4])
            self.assertGreater(float(args[-1]),0)
            self.assertLess(float(args[-1]),2)
            return factory(['/bin/sh','-c','exit 4'],**kwargs)
        with patch.dict(os.environ,env,clear=True),patch('daemon_trace.platform.system',return_value='Linux'),patch('daemon_trace.subprocess.Popen',side_effect=launch):
            result=capture_daemon_trace(2)
        self.assertEqual(result['outcome'],'command-failed')

    def test_native_privileged_timeout_kills_its_group_and_removes_new_raw_dump(self):
        from pathlib import Path
        import os,shlex,subprocess,tempfile,time
        from daemon_trace import eligible_host,ROOT_SUPERVISOR,TRACE_COMMAND
        if not eligible_host():self.skipTest('privileged supervisor requires the verified native GitHub host')
        with tempfile.TemporaryDirectory(prefix='fleur-root-trace-check-') as directory:
            root=Path(directory);existing=root/'goroutine-stacks-existing.log';existing.write_text('preserve')
            generated=root/'goroutine-stacks-fixture.log';pidfile=root/'pid';childfile=root/'child';uidfile=root/'uid'
            fixture=f'printf private > {shlex.quote(str(generated))}; id -u > {shlex.quote(str(uidfile))}; printf "%s" "$$" > {shlex.quote(str(pidfile))}; trap "" TERM; sleep 30 & printf "%s" "$!" > {shlex.quote(str(childfile))}; wait'
            command=ROOT_SUPERVISOR.replace(shlex.quote(TRACE_COMMAND),shlex.quote(fixture)).replace('/var/run/docker/goroutine-stacks-',str(root/'goroutine-stacks-'))
            started=time.monotonic()
            result=subprocess.run(['sudo','-n','/bin/sh','-c',command,'fleur-trace-selftest','0.400'],stdin=subprocess.DEVNULL,capture_output=True,timeout=2)
            self.assertLess(time.monotonic()-started,2)
            self.assertIn(result.returncode,(124,137))
            self.assertTrue(existing.exists());self.assertFalse(generated.exists());self.assertEqual(uidfile.read_text().strip(),'0')
            pid=int(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):os.kill(pid,0)
            child=int(childfile.read_text());status=Path(f'/proc/{child}/stat')
            if status.exists():self.assertEqual(status.read_text().rsplit(')',1)[1].split()[0],'Z')

    def test_numeric_docker_pidfile_without_newline_reaches_validated_signal(self):
        from pathlib import Path
        import shlex,subprocess,tempfile
        from daemon_trace import TRACE_COMMAND
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);pid=root/'pid';comm=root/'comm';marker=root/'signal';trace=root/'trace';trace.mkdir()
            pid.write_text('42');comm.write_text('dockerd\n')
            dump=trace/'goroutine-stacks-fixture.log'
            replacement=f'printf "%s" "$daemon" > {shlex.quote(str(marker))}; printf "goroutine 7 [running]:\\nruntime.goexit(0x1)\\n" > {shlex.quote(str(dump))}'
            command=TRACE_COMMAND.replace('/var/run/docker.pid',str(pid)).replace('"/proc/$daemon/comm"',str(comm)).replace('/var/run/docker/goroutine-stacks-',str(trace/'goroutine-stacks-')).replace('kill -USR1 "$daemon"',replacement)
            result=subprocess.run(['/bin/sh','-c',command],capture_output=True,timeout=1)
            self.assertEqual(result.returncode,0)
            self.assertEqual(marker.read_text(),'42')
            self.assertTrue(result.stdout.startswith(b'trace-ready\n'))
            self.assertFalse(dump.exists())

    def test_failed_capture_preserves_safe_command_returncode(self):
        import os,subprocess
        from unittest.mock import patch
        from daemon_trace import capture_daemon_trace
        env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux','GITHUB_REPOSITORY':'hazeion/fleur','GITHUB_WORKFLOW':'Compatibility experiments','GITHUB_JOB':'runtime-probe'}
        factory=subprocess.Popen
        with patch.dict(os.environ,env,clear=True),patch('daemon_trace.platform.system',return_value='Linux'),patch('daemon_trace.subprocess.Popen',side_effect=lambda args,**kwargs:factory(['/bin/sh','-c','exit 3'],**kwargs)):
            result=capture_daemon_trace(2)
        self.assertEqual(result['cli_returncode'],3)
        self.assertEqual(result['stdout_bytes'],0)
        self.assertEqual(result['stderr_bytes'],0)

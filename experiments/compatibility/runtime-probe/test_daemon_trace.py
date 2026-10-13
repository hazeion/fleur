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

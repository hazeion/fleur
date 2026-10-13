"""Counterfactual scope and endpoint invariants; privileged proof belongs to CI."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from isolated_daemon import Endpoint, IsolatedDaemonError, eligible_host, isolated_vfs_daemon

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
        from isolated_daemon import ROOT_BODY
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-supervisor-') as temporary:
            root = Path(temporary)
            token = 'fleur-vfs-'+'b'*32
            (root/'owner').write_text(token)
            (root/'comm').write_text('dockerd\n')
            (root/'unrelated').write_text('preserve')
            daemon = root/'fixture-daemon'
            import sys
            stop_program = 'import signal,sys,time; from pathlib import Path; signal.signal(signal.SIGTERM,lambda *_:sys.exit(0)); Path('+repr(str(root/'ready'))+').write_text("ready"); time.sleep(60)'
            daemon.write_text('#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\ncase "$1" in\n'
                              '--data-root) mkdir -p "$2" ;;\n--exec-root) mkdir -p "$2" ;;\n'
                              '--pidfile) printf "%s" "$$" > "$2" ;;\nesac\nshift\ndone\nexec '
                              + shlex.quote(sys.executable) + ' -c ' + shlex.quote(stop_program) + '\n')
            daemon.chmod(0o700)
            body = ROOT_BODY.replace('/usr/bin/dockerd', shlex.quote(str(daemon))).replace('"/proc/$child/comm"', shlex.quote(str(root/'comm')))
            body = body.replace('record=$(cat "/proc/$child/stat")', 'record="$child (fixture) S $$ $$"')
            body = body.replace('/usr/bin/timeout 2s /usr/bin/ctr', '/usr/bin/true')
            process = subprocess.Popen(['/bin/sh','-c',body,'fixture',str(root),token,str(os.getgid())],
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

    def test_failed_inspection_cannot_skip_actual_supervisor_stop_and_reap(self):
        import shlex
        import subprocess
        import sys
        from isolated_daemon import ROOT_BODY
        real_popen = subprocess.Popen
        processes = []
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-failure-',dir='/tmp') as temporary:
            def launch(arguments, **kwargs):
                root = Path(arguments[-3])
                (root/'comm').write_text('dockerd\n')
                fixture = root/'fixture-daemon'
                program = ('import os,sys,signal,time; from pathlib import Path; '
                           'signal.signal(signal.SIGTERM,lambda *_:sys.exit(0)); '
                           'a=sys.argv; root=Path(a[a.index("--pidfile")+1]).parent; '
                           '(root/"data").mkdir(); (root/"exec").mkdir(); '
                           '(root/"docker.pid").write_text(str(os.getpid())); '
                           '(root/"docker.sock").write_text("fixture-ready"); time.sleep(60)')
                fixture.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' -c '+shlex.quote(program)+' "$@"\n')
                fixture.chmod(0o700)
                body = ROOT_BODY.replace('/usr/bin/dockerd',shlex.quote(str(fixture)))
                body = body.replace('"/proc/$child/comm"',shlex.quote(str(root/'comm')))
                body = body.replace('record=$(cat "/proc/$child/stat")','record="$child (fixture) S $$ $$"')
                body = body.replace('/usr/bin/timeout 2s /usr/bin/ctr','/usr/bin/true')
                process = real_popen(['/bin/sh','-c',body,'fixture',*arguments[-3:]],**kwargs)
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

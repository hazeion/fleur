"""Real Linux child exits at the normal-wait/forced-retirement handoff."""
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from isolated_daemon import Endpoint, IsolatedDaemonError, isolated_vfs_daemon


class SupervisorExitRace(unittest.TestCase):
    def observe(self, *, exit_code=0, receipt='stopped\n', leave_data=False, empty=True,
                handoff='before-retire', hold_stdout=False, replace_root=False):
        real_popen = subprocess.Popen
        processes = []
        descendant_fds = []
        retirement_calls = []
        roots = []
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-exit-race-') as temporary:
            def release_and_exit(process):
                root = roots[0]
                with (root/'release').open('wb', buffering=0) as stream:stream.write(b'go\n')
                fd = os.pidfd_open(process.pid, 0)
                try:self.assertTrue(select.select([fd], [], [], 2)[0])
                finally:os.close(fd)
                if replace_root:
                    root.rename(Path(temporary)/'original')
                    root.mkdir(mode=0o700);(root/'foreign').write_text('preserve')
            def launch(arguments, **kwargs):
                root = Path(arguments[-3]);roots.append(root)
                program = '''import os,sys
from pathlib import Path
root=Path(sys.argv[1]);(root/'data').mkdir();(root/'exec').mkdir()
(root/'docker.pid').write_text(str(os.getpid()));(root/'docker.sock').write_text('fixture')
(root/'supervisor.pid').write_text(str(os.getpid()));os.mkfifo(root/'release',0o600)
if sys.argv[5]=='hold':
 os.mkfifo(root/'descendant-release',0o600)
 child=os.fork()
 if child==0:
  os.close(0)
  with (root/'descendant-release').open('rb') as stream:stream.read()
  os._exit(0)
 (root/'descendant.pid').write_text(str(child))
print('ready',flush=True)
assert sys.stdin.buffer.readline()==b'stop\\n'
with (root/'release').open('rb') as stream:assert stream.readline()==b'go\\n'
if sys.argv[4]!='leave':(root/'data').rmdir()
(root/'exec').rmdir();(root/'docker.pid').unlink();(root/'docker.sock').unlink()
sys.stdout.write(sys.argv[3]);sys.stdout.flush();raise SystemExit(int(sys.argv[2]))
'''
                process = real_popen([sys.executable, '-I', '-c', program, str(root), str(exit_code), receipt,
                                      'leave' if leave_data else 'remove', 'hold' if hold_stdout else 'closed'], **kwargs)
                processes.append(process)
                self.assertEqual(process.stdout.readline(), b'ready\n')
                if hold_stdout:descendant_fds.append(os.pidfd_open(int((root/'descendant.pid').read_text()),0))
                communicate = process.communicate
                first = True
                def timeout_handoff(**options):
                    nonlocal first
                    if first:
                        first = False
                        # Simulate the timeout decision, retaining actual process,
                        # output, resource retirement and unreaped-exit evidence.
                        if handoff=='before-retire':release_and_exit(process)
                        raise subprocess.TimeoutExpired('owned-supervisor', options['timeout'])
                    return communicate(**options)
                process.communicate = timeout_handoff
                return process
            def retire(endpoint, budget):
                retirement_calls.append(budget)
                self.assertGreater(budget,0);self.assertLessEqual(budget,15)
                if handoff=='during-retire':release_and_exit(processes[0])
                raise IsolatedDaemonError('controlled supervisor identity unavailable')
            def verified(endpoint):endpoint.facts = {'driver': 'vfs'}
            endpoint = None
            try:
                with patch('isolated_daemon.eligible_host', return_value=True), \
                     patch.dict(os.environ, {'RUNNER_TEMP': temporary}), \
                     patch('isolated_daemon._default_identity', return_value={'ID': 'unchanged'}), \
                     patch('isolated_daemon.subprocess.Popen', side_effect=launch), \
                     patch('isolated_daemon._retire_supervisor', side_effect=retire), \
                     patch.object(Endpoint, 'verify', verified), \
                     patch.object(Endpoint, 'command', return_value=subprocess.CompletedProcess([], 0, b'' if empty else b'not-empty', b'')):
                    try:
                        with isolated_vfs_daemon(lifetime=45) as endpoint:pass
                    except IsolatedDaemonError:pass
                return {'passed': endpoint.cleanup_verified, 'observations': endpoint.cleanup_observations,
                        'code': processes[0].returncode, 'retirement_calls': len(retirement_calls),
                        'foreign_preserved': (roots[0]/'foreign').exists() if replace_root else None}
            finally:
                for fd in descendant_fds:
                    try:
                        signal.pidfd_send_signal(fd,signal.SIGKILL)
                        self.assertTrue(select.select([fd],[],[],2)[0])
                    finally:os.close(fd)
                for process in processes:
                    if process.poll() is None:process.kill()
                    process.wait(timeout=2)
                    for stream in (process.stdin, process.stdout):
                        if stream is not None:stream.close()

    def test_natural_exit_at_timeout_handoff_is_reaped_and_requires_normal_receipt(self):
        result = self.observe()
        self.assertTrue(result['passed'], result['observations'])
        self.assertEqual(result['code'], 0);self.assertEqual(result['retirement_calls'],0)
        for field in ('owned_process_reaped','data_root_removed','exec_root_removed'):
            self.assertTrue(result['observations'][field])

    def test_exit_during_helper_validation_uses_only_the_original_child_receipt(self):
        result = self.observe(handoff='during-retire')
        self.assertTrue(result['passed'], result['observations'])
        self.assertEqual(result['code'],0);self.assertEqual(result['retirement_calls'],1)
        self.assertTrue(result['observations']['owned_process_reaped'])

    def test_helper_failure_with_live_supervisor_is_never_normal_completion(self):
        result = self.observe(handoff='still-live')
        self.assertFalse(result['passed']);self.assertEqual(result['retirement_calls'],1)
        self.assertIsNone(result['code'])
        self.assertEqual(result['observations']['cleanup_failure_stage'],'forced-retirement')

    def test_exited_parent_with_pipeholding_descendant_cannot_pass_drain(self):
        result = self.observe(hold_stdout=True)
        self.assertFalse(result['passed']);self.assertEqual(result['code'],0)
        self.assertEqual(result['observations']['cleanup_exception'],'timeout')
        self.assertEqual(result['observations']['cleanup_failure_stage'],'natural-drain')
        self.assertFalse(result['observations']['cleanup_deadline_exceeded'])

    def test_exit_race_never_excuses_bad_receipts_leftovers_inventory_or_root_replacement(self):
        for options in ({'exit_code': 1}, {'receipt': 'unexpected\n'}, {'leave_data': True},
                        {'empty': False}, {'replace_root': True}):
            with self.subTest(options=options):
                result = self.observe(**options)
                self.assertFalse(result['passed'])
                self.assertTrue(result['observations']['owned_process_reaped'])
                if options.get('replace_root'):self.assertTrue(result['foreign_preserved'])

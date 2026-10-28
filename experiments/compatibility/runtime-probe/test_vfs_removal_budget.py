"""Hosted VFS data-root removal must fit the aggregate cleanup fence (#99)."""
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

from isolated_daemon import Endpoint, IsolatedDaemonError, isolated_vfs_daemon

# Run 40681832613 (amd64), the slowest first-attempt failure: the normal stop
# removed 37735 files and 4994 directories in 9.52 s; the forced attempt removed
# 18464 files and 2321 directories in 4.50 s, then timed out. Every hosted report
# has the same VFS tree, 90.8k files and 12.0k directories, so removal at the
# observed 4.53k entries/s needs 22.7 s, plus ~0.4 s for daemon stop and checks.
SLOWEST_OBSERVED_STOP_AND_REMOVAL_SECONDS = 23.1


class Clock:
    def __init__(self):self.now = 1000.0
    def monotonic(self):return self.now
    def sleep(self, seconds):self.now += max(0, seconds)


class SlowRemovalSupervisor:
    """Owned supervisor whose stop receipt waits for a fixed removal workload."""
    def __init__(self, root, clock, work):
        self.root, self.clock, self.remaining = root, clock, work
        self.returncode, self.output = None, b''
        for name in ('data', 'exec'):(root/name).mkdir()
        (root/'data/layer').write_text('vfs copy')
        (root/'docker.pid').write_text('4242');(root/'docker.sock').write_text('fixture')
        self.stdin = types.SimpleNamespace(write=lambda data:None, flush=lambda:None, close=lambda:None)
        self.stdout = types.SimpleNamespace(close=lambda:None)

    def retire_roots(self):
        (self.root/'data/layer').unlink()
        for name in ('data', 'exec'):(self.root/name).rmdir()
        for name in ('docker.pid', 'docker.sock'):(self.root/name).unlink()
        self.remaining = 0

    def poll(self):return self.returncode

    def communicate(self, timeout=None):
        if self.returncode is None:
            if timeout < self.remaining:
                self.clock.sleep(timeout);self.remaining -= timeout
                raise subprocess.TimeoutExpired('owned-supervisor', timeout)
            self.clock.sleep(self.remaining);self.retire_roots()
            self.returncode, self.output = 0, b'stopped\n'
        return self.output, b''

    def wait(self, timeout=None):
        if self.returncode is None:raise subprocess.TimeoutExpired('owned-supervisor', timeout)
        return self.returncode


class VfsRemovalBudget(unittest.TestCase):
    def observe(self, work):
        clock = Clock()
        supervisors, forced = [], []
        def launch(arguments, **kwargs):
            supervisors.append(SlowRemovalSupervisor(Path(arguments[-3]), clock, work))
            return supervisors[-1]
        def forced_retirement(endpoint, budget):
            # Group kill, then the same anchored removal resumes inside the
            # helper's own window (at most ten seconds, minus capture/escalation).
            supervisor = supervisors[0]
            forced.append(budget)
            supervisor.returncode = -9
            window = min(10, budget)-.5
            if supervisor.remaining <= window:
                clock.sleep(supervisor.remaining);supervisor.retire_roots();return True
            clock.sleep(window);supervisor.remaining -= window
            return False
        def verified(endpoint):endpoint.facts = {'driver': 'vfs'}
        def remove_root(endpoint):
            # The Linux unlink-count proof runs natively in CI; APFS retains a
            # nonzero link count on an open removed directory.
            endpoint.verify_root()
            for path in endpoint.root.iterdir():path.unlink()
            endpoint.root.rmdir()
        endpoint = None
        with tempfile.TemporaryDirectory(prefix='fleur-vfs-removal-') as temporary:
            raised = None
            with patch('isolated_daemon.eligible_host', return_value=True), \
                 patch.dict(os.environ, {'RUNNER_TEMP': temporary}), \
                 patch('isolated_daemon.time', types.SimpleNamespace(monotonic=clock.monotonic, sleep=clock.sleep)), \
                 patch('isolated_daemon._default_identity', return_value={'ID': 'unchanged'}), \
                 patch('isolated_daemon.subprocess.Popen', side_effect=launch), \
                 patch('isolated_daemon._retire_supervisor', side_effect=forced_retirement), \
                 patch.object(Endpoint, 'verify', verified), \
                 patch.object(Endpoint, 'remove_root', remove_root), \
                 patch.object(Endpoint, 'command', return_value=subprocess.CompletedProcess([], 0, b'', b'')):
                try:
                    with isolated_vfs_daemon(lifetime=540) as endpoint:pass
                except IsolatedDaemonError as error:raised = error
            return endpoint, raised, forced

    def test_slowest_observed_hosted_removal_completes_through_normal_stop(self):
        endpoint, raised, forced = self.observe(SLOWEST_OBSERVED_STOP_AND_REMOVAL_SECONDS)
        observations = endpoint.cleanup_observations
        self.assertIsNone(raised, observations)
        self.assertTrue(endpoint.cleanup_verified, observations)
        self.assertNotIn('cleanup_failure_stage', observations)
        self.assertEqual(forced, [])
        self.assertEqual(observations['daemon_returncode'], 0)
        self.assertTrue(observations['data_root_removed'] and observations['exec_root_removed'])
        self.assertTrue(endpoint.facts['default_daemon_unchanged'])
        self.assertFalse(endpoint.root.exists())

    def test_removal_beyond_the_cleanup_fence_still_fails_closed(self):
        endpoint, raised, forced = self.observe(120)
        observations = endpoint.cleanup_observations
        self.assertIsInstance(raised, IsolatedDaemonError)
        self.assertFalse(endpoint.cleanup_verified)
        self.assertEqual(len(forced), 1)
        self.assertEqual(observations['cleanup_failure_stage'], 'forced-reap')
        self.assertFalse(observations['data_root_removed'])
        self.assertFalse(observations['cleanup_deadline_exceeded'])


class ProbeCleanupReserve(unittest.TestCase):
    def test_full_probe_deadline_leaves_the_whole_cleanup_fence(self):
        from contextlib import contextmanager
        import json
        import isolated_daemon
        from test_vfs import facts, probe
        from vfs import run_counterfactual
        endpoint = types.SimpleNamespace(facts=dict(facts(), default_daemon_unchanged=True), environment={},
                                         remaining_seconds=lambda:525, cleanup_verified=True)
        @contextmanager
        def context(**kwargs):yield endpoint
        with tempfile.TemporaryDirectory() as directory, \
             patch('isolated_daemon.isolated_vfs_daemon', side_effect=context), \
             patch('vfs.execute_probe', return_value=(0, json.dumps(probe()).encode(), {'stderr_bytes':0})) as execute:
            self.assertEqual(run_counterfactual('amd64', directory), 0)
        timeout = execute.call_args.args[2]
        self.assertGreater(timeout, 0)
        self.assertGreaterEqual(525-timeout, isolated_daemon.CLEANUP_SECONDS)
        self.assertGreater(isolated_daemon.CLEANUP_SECONDS-5, SLOWEST_OBSERVED_STOP_AND_REMOVAL_SECONDS)


if __name__ == '__main__':
    unittest.main()

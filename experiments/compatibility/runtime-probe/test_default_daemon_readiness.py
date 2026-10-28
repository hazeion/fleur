"""Default daemon readiness: a slow hosted start is waited for, never-ready fails closed in bound."""
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest
from unittest.mock import patch

import isolated_daemon
from isolated_daemon import IsolatedDaemonError, isolated_vfs_daemon, wait_for_default_daemon

IDENTITY = {'ID': 'default-engine', 'Driver': 'overlay2', 'DockerRootDir': '/var/lib/docker'}
FAKE_DOCKER = r'''#!/bin/sh
# Fixture CLI: behaves per invocation number from a fixed plan; "hang" stands for an unresponsive daemon.
state=$(dirname "$0")
count=$(($(cat "$state/count")+1)); printf '%s' "$count" > "$state/count"
printf '%s\n' "$*" >> "$state/arguments"
plan=$(sed -n "${count}p" "$state/plan"); [ -n "$plan" ] || plan=$(tail -n 1 "$state/plan")
case "$plan" in
  hang) exec sleep 30 ;;
  refused) echo 'Cannot connect to the Docker daemon' >&2; exit 1 ;;
  invalid) printf '%s\n' '{"ID":"default-engine"}' ;;
  ready) printf '%s\n' '{"ID":"default-engine","Driver":"overlay2","DockerRootDir":"/var/lib/docker"}' ;;
esac
'''


class DefaultDaemonReadiness(unittest.TestCase):
    def fake_docker(self, *plan):
        directory = Path(tempfile.mkdtemp(prefix='fleur-docker-cli-'))
        self.addCleanup(shutil.rmtree, directory)
        (directory/'count').write_text('0')
        (directory/'arguments').write_text('')
        (directory/'plan').write_text('\n'.join(plan)+'\n')
        (directory/'docker').write_text(FAKE_DOCKER)
        (directory/'docker').chmod(0o700)
        environment = patch.dict(os.environ, {'PATH': str(directory)+os.pathsep+os.environ['PATH'],
                                              'DOCKER_HOST': 'tcp://redirected.invalid:2375',
                                              'DOCKER_CONTEXT': 'redirected'})
        environment.start()
        self.addCleanup(environment.stop)
        return directory

    # Fixture timings tolerate a heavily loaded host: outcomes follow the invocation plan, not the clock.
    def test_slow_daemon_start_is_waited_for_and_returns_default_identity(self):
        state = self.fake_docker('hang', 'refused', 'ready')
        identity = wait_for_default_daemon(window=60, attempt_timeout=1.5, interval=.05)
        self.assertEqual(identity, IDENTITY)
        arguments = (state/'arguments').read_text().splitlines()
        self.assertGreaterEqual(len(arguments), 3)
        # Every attempt is pinned to the default socket, never an inherited context or host.
        self.assertTrue(all(line.startswith('--host unix:///var/run/docker.sock info --format ') for line in arguments))

    def test_never_ready_daemon_fails_closed_within_its_explicit_deadline(self):
        self.fake_docker('hang')
        started = time.monotonic()
        with self.assertRaises(IsolatedDaemonError) as raised:
            wait_for_default_daemon(window=2, attempt_timeout=.5, interval=.05)
        elapsed = time.monotonic()-started
        self.assertGreaterEqual(elapsed, 2)
        # The final attempt is clipped to the window; only killing and reaping it may overrun.
        self.assertLess(elapsed, 2+1)
        self.assertTrue(str(raised.exception).startswith('default daemon not ready within 2s readiness deadline'))
        observations = raised.exception.observations
        self.assertGreaterEqual(observations['attempts'], 2)
        self.assertEqual(observations['timeouts'], observations['attempts'])
        self.assertEqual(observations['refusals'], 0)

    def test_daemon_refusing_until_deadline_is_retried_then_fails_closed(self):
        self.fake_docker('refused')
        with self.assertRaises(IsolatedDaemonError) as raised:
            wait_for_default_daemon(window=4, attempt_timeout=3, interval=.05)
        self.assertTrue(str(raised.exception).startswith('default daemon not ready within 4s readiness deadline'))
        self.assertGreaterEqual(raised.exception.observations['refusals'], 2)

    def test_invalid_identity_from_a_ready_daemon_is_not_retried(self):
        state = self.fake_docker('invalid')
        with self.assertRaisesRegex(IsolatedDaemonError, 'default daemon identity invalid'):
            wait_for_default_daemon(window=60, attempt_timeout=3, interval=.05)
        self.assertEqual((state/'count').read_text(), '1')

    def test_never_ready_default_daemon_launches_no_owned_root(self):
        self.fake_docker('hang')
        with tempfile.TemporaryDirectory(prefix='fleur-runner-temp-') as temporary, \
             patch('isolated_daemon.eligible_host', return_value=True), \
             patch.dict(os.environ, {'RUNNER_TEMP': temporary}), \
             patch.object(isolated_daemon, 'DEFAULT_DAEMON_READY_SECONDS', 1), \
             patch.object(isolated_daemon, 'DEFAULT_DAEMON_ATTEMPT_SECONDS', .4):
            with self.assertRaisesRegex(IsolatedDaemonError, 'default daemon not ready within 1s readiness deadline'):
                with isolated_vfs_daemon(lifetime=45):
                    self.fail('owned daemon must not start without a ready default daemon')
            self.assertEqual(os.listdir(temporary), [])


if __name__ == '__main__':
    unittest.main()

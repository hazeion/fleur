import os
from pathlib import Path
import select
import json
import sys
import signal
import subprocess
import tempfile
import threading
import time
import unittest

from worker_deadline import bind_owned_pidfd, supervise, HostDeadlineGuard

CID = 'a' * 64

class BindingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.process = self.root / '73'
        self.process.mkdir()
        self.identity()
        self.read_fd, self.write_fd = os.pipe()
    def tearDown(self):
        os.close(self.read_fd); os.close(self.write_fd); self.tmp.cleanup()
    def identity(self, cid=CID, started='500'):
        (self.process/'cgroup').write_text('0::/system.slice/docker-'+cid+'.scope\n')
        (self.process/'stat').write_text('73 (fixture) S '+'0 '*18+started+' 0\n')
    def bind(self, opener=None):
        return bind_owned_pidfd(CID, 73, self.root,
            opener=opener or (lambda pid, flags: os.dup(self.read_fd)))
    def test_exact_owned_cgroup_binds_one_process(self):
        fd = self.bind()
        try: self.assertEqual(select.select([fd], [], [], 0)[0], [])
        finally: os.close(fd)
    def test_foreign_process_is_never_opened(self):
        self.identity('b'*64)
        with self.assertRaisesRegex(RuntimeError, 'identity'):
            self.bind(opener=lambda *args: self.fail('opened unrelated process'))
    def test_container_prefix_or_host_process_cgroup_is_rejected(self):
        for value in ('0::/system.slice/docker-'+CID+'extra.scope\n', '0::/user.slice/session.scope\n'):
            with self.subTest(value=value):
                (self.process/'cgroup').write_text(value)
                with self.assertRaisesRegex(RuntimeError,'identity'):
                    self.bind(opener=lambda *args: self.fail('opened unrelated process'))
    def test_reused_pid_during_binding_is_rejected(self):
        opened = []
        def racing_open(*args):
            fd = os.dup(self.read_fd); opened.append(fd)
            self.identity(started='501')
            return fd
        with self.assertRaisesRegex(RuntimeError, 'identity'): self.bind(racing_open)
        with self.assertRaises(OSError): os.fstat(opened[0])

class ChildBoundary:
    """Same-user child exit pipe substitutes only Linux pidfd operations on macOS."""
    def __init__(self, delay=0):
        self.child = subprocess.Popen(['sleep', '20'], stdout=subprocess.PIPE)
        self.delay = delay
    def bind(self, cid, pid):
        if cid != CID or pid != self.child.pid: raise RuntimeError('worker identity unverified')
        return self.child.stdout.fileno()
    def kill(self, fd):
        time.sleep(self.delay)
        self.child.kill()
    def close(self, fd): self.child.wait(timeout=2); self.child.stdout.close()

class SupervisionTests(unittest.TestCase):
    def run_guard(self, delay=0, cancel=False):
        boundary = ChildBoundary(delay)
        control, writer = os.pipe()
        records = []
        deadline = time.monotonic()+.2
        if cancel: os.close(writer)
        try:
            supervise(CID, boundary.child.pid, deadline, boundary.bind,
                      boundary.kill, boundary.close, control, records.append)
        finally:
            os.close(control)
            if not cancel: os.close(writer)
        return records, boundary.child.returncode
    def test_deadline_observes_actual_child_exit_and_preserves_unrelated_child(self):
        unrelated = subprocess.Popen(['sleep','20'])
        try:
            records, status = self.run_guard()
            self.assertEqual(status, -signal.SIGKILL)
            self.assertIsNone(unrelated.poll())
            self.assertEqual(records[0], {'kind':'armed'})
            self.assertEqual(records[1]['outcome'], 'deadline')
            self.assertTrue(records[1]['physical_exit_confirmed'])
            self.assertLessEqual(records[1]['physical_exit_lateness_ms'], 250)
        finally: unrelated.kill(); unrelated.wait(timeout=2)
    def test_delayed_actual_termination_is_rejected(self):
        records, status = self.run_guard(delay=.4)
        self.assertEqual(status, -signal.SIGKILL)
        self.assertEqual(records[1]['outcome'], 'late-termination')
    def test_control_eof_terminates_owned_child_promptly(self):
        started=time.monotonic()
        records,status=self.run_guard(cancel=True)
        self.assertEqual(status,-signal.SIGKILL)
        self.assertEqual(records[1]['outcome'],'cancelled')
        self.assertLess(time.monotonic()-started,.2)

class GuardProtocolTests(unittest.TestCase):
    def launcher(self, record, exit_code=0):
        def launch(args, **kwargs):
            # Actual child process exercises parent framing, EOF and reap.
            program = 'import json,time,sys\nprint(json.dumps({"kind":"armed"}),flush=True)\ntime.sleep(.02)\nprint('+repr(json.dumps(record))+',flush=True)\nsys.exit('+str(exit_code)+')'
            return subprocess.Popen([sys.executable,'-I','-c',program], **kwargs)
        return launch
    def record(self):
        return {'kind':'result','outcome':'deadline','physical_exit_confirmed':True,
                'kill_lateness_ms':0,'physical_exit_lateness_ms':20}
    def test_rejected_kernel_outcomes_retain_safe_facts_after_helper_cleanup(self):
        for outcome in ('premature-exit','cancelled','late-termination'):
            with self.subTest(outcome=outcome):
                record=dict(self.record(),outcome=outcome)
                guard=HostDeadlineGuard(CID,73,time.monotonic()+3,launcher=self.launcher(record))
                try:
                    with self.assertRaisesRegex(RuntimeError,'termination') as caught:guard.completion()
                    facts=caught.exception.observations
                    self.assertEqual(facts['record_kind'],'result')
                    self.assertEqual(facts['record_outcome'],outcome)
                    self.assertTrue(facts['record_physical_exit_confirmed'])
                    self.assertGreater(facts['deadline_remaining_ms'],0)
                    self.assertFalse(facts['parent_control_closed_before_failure'])
                finally:guard.close()
                self.assertTrue(facts['helper_reaped'])
                self.assertEqual(facts['launcher_returncode_after_cleanup'],0)

    def test_unknown_result_payload_is_not_copied_to_failure_observations(self):
        record=dict(self.record(),outcome='private-secret',private_payload={'token':'private-secret'},kill_lateness_ms=True)
        guard=HostDeadlineGuard(CID,73,time.monotonic()+3,launcher=self.launcher(record))
        try:
            with self.assertRaisesRegex(RuntimeError,'termination') as caught:guard.completion()
            facts=caught.exception.observations
            self.assertEqual(facts['record_outcome'],'unknown')
            self.assertIsNone(facts['record_kill_lateness_ms'])
            self.assertFalse(facts['record_shape_valid'])
            self.assertNotIn('private-secret',json.dumps(facts))
            self.assertNotIn('private_payload',json.dumps(facts))
        finally:guard.close()

    def test_helper_error_record_retains_only_fixed_category_and_exit_status(self):
        guard=HostDeadlineGuard(CID,73,time.monotonic()+3,launcher=self.launcher(
            {'kind':'error','category':'deadline-guard-failed','private':'secret-value'},1))
        try:
            with self.assertRaisesRegex(RuntimeError,'termination') as caught:guard.completion()
        finally:guard.close()
        facts=caught.exception.observations
        self.assertEqual(facts['record_kind'],'error')
        self.assertEqual(facts['helper_error_category'],'deadline-guard-failed')
        self.assertEqual(facts['launcher_returncode_after_cleanup'],1)
        self.assertNotIn('secret-value',json.dumps(facts))

    def test_bounded_kernel_result_requires_helper_reap(self):
        guard=HostDeadlineGuard(CID,73,time.monotonic()+1,launcher=self.launcher(self.record()))
        evidence=guard.completion()
        self.assertTrue(evidence['guard_reaped'])
        self.assertEqual(guard.process.returncode,0)
    def test_boolean_or_late_result_is_rejected(self):
        for update in ({'physical_exit_lateness_ms':True},{'physical_exit_lateness_ms':251},{'physical_exit_confirmed':False}):
            with self.subTest(update=update):
                record=dict(self.record(),**update)
                guard=HostDeadlineGuard(CID,73,time.monotonic()+1,launcher=self.launcher(record))
                try:
                    with self.assertRaisesRegex(RuntimeError,'termination'):guard.completion()
                finally:guard.close()
    def test_helper_failure_after_result_cannot_claim_reap_success(self):
        guard=HostDeadlineGuard(CID,73,time.monotonic()+1,launcher=self.launcher(self.record(),1))
        with self.assertRaisesRegex(RuntimeError,'guard failed'):guard.completion()
        self.assertTrue(guard.closed)


class ExplicitOwnedDeadlineBoundary(unittest.TestCase):
    def test_observation_dictionary_cannot_arm_a_privileged_guard(self):
        from unittest.mock import patch
        from worker_deadline import HostDeadlineGuard
        import time
        with patch('subprocess.Popen',side_effect=AssertionError('untyped binding armed privilege')):
            with self.assertRaisesRegex(ValueError,'typed host daemon binding'):
                HostDeadlineGuard('a'*64,47,time.monotonic()+5,host_binding={'ok':True})

if __name__ == '__main__':
    unittest.main()

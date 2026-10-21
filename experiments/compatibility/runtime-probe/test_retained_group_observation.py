"""Transient observations do not replace actual group disappearance proof."""
import errno
import os
import signal
import subprocess
import time
import unittest
from unittest.mock import patch
from registration_canary import retire_owned_group


class RetainedGroupObservation(unittest.TestCase):
    def child(self):
        process=subprocess.Popen(['sleep','20'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        def cleanup():
            if process.returncode is None:
                os.waitid(os.P_PID,process.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                process.wait(timeout=1)
        self.addCleanup(cleanup)
        return process

    def test_transient_observation_denial_requires_later_actual_esrch_within_same_cap(self):
        child=self.child();real_signal=os.killpg;observations=[];absence=[]
        def controlled(pid,sig):
            self.assertEqual(pid,child.pid)
            if sig:
                self.assertIsNone(child.returncode,'destructive send occurred after reap')
            else:
                observations.append(time.monotonic())
                if len(observations)==1:raise PermissionError(errno.EPERM,'controlled observation-only transient')
            try:return real_signal(pid,sig)
            except ProcessLookupError:
                if not sig:absence.append(pid)
                raise
        started=time.monotonic()
        with patch('os.killpg',side_effect=controlled):retire_owned_group(child,.2)
        self.assertGreaterEqual(len(observations),2)
        self.assertEqual(absence,[child.pid])
        self.assertIsNotNone(child.returncode)
        self.assertLess(time.monotonic()-started,.3)

    def test_persistent_denied_observation_remains_unconfirmed_at_original_cap(self):
        child=self.child();real_signal=os.killpg;observations=[]
        def controlled(pid,sig):
            self.assertEqual(pid,child.pid)
            if not sig:observations.append(pid);raise PermissionError(errno.EPERM,'persistent denied observation')
            return real_signal(pid,sig)
        started=time.monotonic()
        with patch('os.killpg',side_effect=controlled),self.assertRaises(RuntimeError):retire_owned_group(child,.05)
        self.assertGreaterEqual(len(observations),1)
        self.assertLess(time.monotonic()-started,.3)

    def test_destructive_signal_denial_never_becomes_cleanup_success(self):
        child=self.child();calls=[]
        def denied(pid,sig):calls.append(sig);raise PermissionError(errno.EPERM,'destructive signal denied')
        with patch('os.killpg',side_effect=denied),self.assertRaises(PermissionError):retire_owned_group(child,.2)
        self.assertEqual(calls,[signal.SIGKILL]);self.assertIsNone(child.returncode)

    def test_unknown_observation_error_remains_unconfirmed(self):
        child=self.child();real_signal=os.killpg
        def controlled(pid,sig):
            if not sig:raise OSError(errno.EIO,'unknown observation state')
            return real_signal(pid,sig)
        with patch('os.killpg',side_effect=controlled),self.assertRaises(OSError):retire_owned_group(child,.2)


if __name__=='__main__':unittest.main()

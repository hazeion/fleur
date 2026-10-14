"""The host-command timing boundary reports useful facts without output disclosure."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from cli_latency import measure_command


class HostCommandTiming(unittest.TestCase):
    def test_command_success_records_bounded_numeric_facts_without_disclosing_output(self):
        secret='fixture-secret-that-must-not-appear'
        result=measure_command([sys.executable,'-c',
            'import sys;print('+repr(secret)+');print('+repr(secret)+',file=sys.stderr)'],timeout=2)
        self.assertEqual(result['returncode'],0)
        self.assertFalse(result['timed_out'])
        self.assertEqual(result['stdout_bytes'],len(secret)+1)
        self.assertEqual(result['stderr_bytes'],len(secret)+1)
        self.assertGreaterEqual(result['duration_ms'],0)
        self.assertNotIn(secret,json.dumps(result))

    def test_failed_command_is_never_presented_as_a_successful_speed_measurement(self):
        result=measure_command([sys.executable,'-c','raise SystemExit(7)'],timeout=2)
        self.assertEqual(result['returncode'],7)
        self.assertFalse(result['passed'])

    def test_deadline_failure_is_reported_and_direct_child_is_reaped(self):
        with tempfile.TemporaryDirectory() as folder:
            pidfile=Path(folder)/'pid'
            result=measure_command([sys.executable,'-c',
                'import os,time;open('+repr(str(pidfile))+',"w").write(str(os.getpid()));time.sleep(10)'],timeout=.3)
            self.assertTrue(result['timed_out'])
            self.assertFalse(result['passed'])
            pid=int(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):os.kill(pid,0)



class NativeComparisonPolicy(unittest.TestCase):
    def test_failed_baseline_is_retained_without_rejecting_successful_optimized_commands(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from cli_latency import compare_host_cli
        control={'ctr':'/usr/bin/ctr','address':'/run/containerd/containerd.sock','namespace':'moby',
                 'host_version_duration_ms':4000,'host_startup_budget_seconds':15,
                 'ctr_revision_verified':True,'containerd_version':'2.3.6','containerd_commit':'ee2735368117d2eb259779949d5e75cdafec9761',
                 'docker_version':'28.0.4','docker_commit':'6430e49'}
        def command(args,**kwargs):
            optimized='CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS=true' in args
            detail=b'Client:\n Version: v2.3.6\n Revision: ee2735368117d2eb259779949d5e75cdafec9761\nServer:\n Version: v2.3.6\n Revision: ee2735368117d2eb259779949d5e75cdafec9761\n'
            return SimpleNamespace(returncode=0 if optimized else 124,stdout=detail if optimized else b'',stderr=b'')
        with patch('cli_latency.subprocess.run',side_effect=command):
            report=compare_host_cli(control)
        self.assertTrue(report['passed'])
        self.assertFalse(report['baseline_comparable'])
        self.assertEqual([row['returncode'] for row in report['samples']],[0,124,0,0,124])
        self.assertEqual([row['passed'] for row in report['samples']],[True,False,True,True,False])

    def test_optimized_sample_with_wrong_revision_fails_even_when_cli_exits_zero(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from cli_latency import compare_host_cli
        control={'ctr':'/usr/bin/ctr','address':'/run/containerd/containerd.sock','namespace':'moby',
                 'host_version_duration_ms':40,'host_startup_budget_seconds':15,
                 'ctr_revision_verified':True,'containerd_version':'2.3.6',
                 'containerd_commit':'ee2735368117d2eb259779949d5e75cdafec9761',
                 'docker_version':'28.0.4','docker_commit':'6430e49'}
        detail=b'Client:\n Version: v2.3.6\n Revision: wrong\nServer:\n Version: v2.3.6\n Revision: wrong\n'
        with patch('cli_latency.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=detail,stderr=b'')):
            report=compare_host_cli(control)
        self.assertFalse(report['passed'])
        self.assertFalse(report['baseline_comparable'])
        self.assertFalse(report['samples'][2]['passed'])


if __name__=='__main__':unittest.main()

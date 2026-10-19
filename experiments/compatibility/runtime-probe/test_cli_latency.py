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
                 'host_startup_duration_ms':5000,'host_startup_phases_ms':{'authoritative_version':4000,'binary_sha256':1000},
                 'first_version_preceded_by_startup_probes':True,
                 'ctr_revision_verified':True,'containerd_version':'2.4.1','containerd_commit':'f2551031d7276a770f65f98c9b52e57e7dad07e8',
                 'docker_version':'28.0.4','docker_commit':'6430e49',
                 'runc_version':'1.5.2','runc_commit':'v1.5.2-0-g29dd3dc2'}
        def command(args,**kwargs):
            optimized='CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS=true' in args
            detail=b'Client:\n Version: v2.4.1\n Revision: f2551031d7276a770f65f98c9b52e57e7dad07e8\nServer:\n Version: v2.4.1\n Revision: f2551031d7276a770f65f98c9b52e57e7dad07e8\n'
            return SimpleNamespace(returncode=0 if optimized else 124,stdout=detail if optimized else b'',stderr=b'')
        with patch('cli_latency.subprocess.run',side_effect=command):
            report=compare_host_cli(control)
        self.assertTrue(report['passed'])
        self.assertEqual(report['first_authoritative_version_ms'],4000)
        self.assertEqual(report['host_startup_duration_ms'],5000)
        self.assertTrue(report['first_version_preceded_by_startup_probes'])
        self.assertFalse(report['baseline_comparable'])
        self.assertEqual([row['returncode'] for row in report['samples']],[0,124,0,0,124])
        self.assertEqual([row['passed'] for row in report['samples']],[True,False,True,True,False])

    def test_optimized_sample_with_wrong_revision_fails_even_when_cli_exits_zero(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from cli_latency import compare_host_cli
        control={'ctr':'/usr/bin/ctr','address':'/run/containerd/containerd.sock','namespace':'moby',
                 'host_version_duration_ms':40,'host_startup_budget_seconds':15,
                 'host_startup_duration_ms':50,'host_startup_phases_ms':{'authoritative_version':40,'binary_sha256':10},
                 'first_version_preceded_by_startup_probes':True,
                 'ctr_revision_verified':True,'containerd_version':'2.4.1',
                 'containerd_commit':'f2551031d7276a770f65f98c9b52e57e7dad07e8',
                 'docker_version':'28.0.4','docker_commit':'6430e49',
                 'runc_version':'1.5.2','runc_commit':'v1.5.2-0-g29dd3dc2'}
        detail=b'Client:\n Version: v2.4.1\n Revision: wrong\nServer:\n Version: v2.4.1\n Revision: wrong\n'
        with patch('cli_latency.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=detail,stderr=b'')):
            report=compare_host_cli(control)
        self.assertFalse(report['passed'])
        self.assertFalse(report['baseline_comparable'])
        self.assertFalse(report['samples'][2]['passed'])


class FailureEvidence(unittest.TestCase):
    def test_failure_json_preserves_only_safe_counts_and_completed_startup_phases(self):
        import contextlib
        import io
        from unittest.mock import patch
        from cli_latency import main
        from configuration import ContainerdControlUnverified
        error=ContainerdControlUnverified('ctr-version-command',{
            'duration_ms':4000,'cli_returncode':124,'stdout_bytes':22,'stderr_bytes':11,
            'raw_error':'private-host-output',
            'host_startup_phases_ms':{'privileged_noop':12,'ctr_banner':4000,'unknown':'private-host-output'},
            'host_startup_probes':{'ctr_banner':{'passed':False,'timed_out':True,'cli_returncode':124,
                'duration_ms':4000,'raw_error':'private-host-output'}}})
        output=io.StringIO()
        with patch('configuration.inspect_containerd_control',side_effect=error),contextlib.redirect_stdout(output):
            status=main()
        report=json.loads(output.getvalue())
        self.assertEqual(status,1)
        self.assertFalse(report['passed'])
        facts=report['failure_observations']
        self.assertEqual(facts['duration_ms'],4000)
        self.assertEqual(facts['cli_returncode'],124)
        self.assertEqual(facts['host_startup_phases_ms'],{'privileged_noop':12,'ctr_banner':4000})
        self.assertFalse(facts['host_startup_probes']['ctr_banner']['passed'])
        self.assertNotIn('private-host-output',output.getvalue())
        self.assertNotIn('raw_error',output.getvalue())


if __name__=='__main__':unittest.main()

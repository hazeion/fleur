"""Counterfactual acceptance cannot turn partial native evidence into success."""
import copy
import unittest
from vfs import validate_result


def facts():
    return {'driver':'vfs','server_version':'28.0.4',**{key:True for key in
        ('owned','socket_verified','data_root_verified','exec_root_verified','namespace_verified','pid_verified','config_verified')}}


def probe():
    return {'bounded_probe_passed':True,'v1_gate_passed':False,'cleanup_complete':True,
            'restricted_worker_lifecycle':{'passed':True,'repeats':[{},{}]},
            'event_replacement_negative':{'passed':True}}


class Counterfactual(unittest.TestCase):
    def test_only_actual_owned_vfs_and_full_successful_probe_can_pass(self):
        self.assertTrue(validate_result(facts(),0,probe(),True))
        for key,value in [('driver','overlay2'),('server_version','29.0.0'),('owned',False),
                          ('socket_verified',1),('namespace_verified',False)]:
            changed=facts();changed[key]=value
            with self.subTest(key=key):self.assertFalse(validate_result(changed,0,probe(),True))
        for exit_code in (1,137):self.assertFalse(validate_result(facts(),exit_code,probe(),True))
        self.assertFalse(validate_result(facts(),0,probe(),False))

    def test_counterfactual_never_claims_global_gate_or_skips_required_native_cases(self):
        for changed in ({'v1_gate_passed':True},{'bounded_probe_passed':False},{'cleanup_complete':False},
                        {'restricted_worker_lifecycle':{'passed':True,'repeats':[{}]}},
                        {'event_replacement_negative':{'passed':False}}):
            with self.subTest(changed=changed):self.assertFalse(validate_result(facts(),0,dict(probe(),**changed),True))

    def test_actual_child_transport_uses_same_probe_and_bounded_output(self):
        import os,subprocess
        from unittest.mock import patch
        from vfs import execute_probe
        factory=subprocess.Popen;processes=[]
        environment=dict(os.environ,DOCKER_HOST='unix:///owned/socket')
        def launch(args,**kwargs):
            self.assertTrue(args[1].endswith('/run.py'))
            self.assertEqual(args[2:],['--architecture','amd64','--trusted-build-network','host','--kernel-private-network'])
            self.assertEqual(kwargs['env']['DOCKER_HOST'],'unix:///owned/socket')
            self.assertTrue(kwargs['start_new_session'])
            child=factory(['/bin/sh','-c',"printf '{\"bounded_probe_passed\":true}\\n'; printf 'private' >&2"],**kwargs)
            processes.append(child);return child
        with patch('vfs.subprocess.Popen',side_effect=launch):
            code,raw,transport=execute_probe('amd64',environment,2)
        self.assertEqual(code,0);self.assertIn(b'bounded_probe_passed',raw)
        self.assertEqual(transport['stderr_bytes'],7)
        self.assertNotIn('private',str(transport))
        self.assertIsNotNone(processes[0].poll());self.assertTrue(processes[0].stdout.closed)

    def test_stuck_probe_child_is_terminated_and_reaped(self):
        import os,subprocess
        from unittest.mock import patch
        from vfs import execute_probe
        factory=subprocess.Popen;processes=[]
        def launch(args,**kwargs):
            child=factory(['/bin/sh','-c','exec sleep 30'],**kwargs);processes.append(child);return child
        with patch('vfs.subprocess.Popen',side_effect=launch),self.assertRaises(TimeoutError):
            execute_probe('amd64',dict(os.environ),.2)
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(processes[0].stdout.closed);self.assertTrue(processes[0].stderr.closed)

    def test_context_failure_cannot_be_overwritten_by_success_metadata(self):
        from contextlib import contextmanager
        import json,tempfile
        from pathlib import Path
        from types import SimpleNamespace
        from unittest.mock import patch
        from vfs import run_counterfactual
        endpoint=SimpleNamespace(facts=facts(),environment={},remaining_seconds=lambda:60,cleanup_verified=True)
        @contextmanager
        def failed_context(**kwargs):
            try:yield endpoint
            finally:
                endpoint.facts['default_daemon_unchanged']=True
                raise RuntimeError('supervisor cleanup fixture failure')
        with tempfile.TemporaryDirectory() as directory,patch('isolated_daemon.isolated_vfs_daemon',side_effect=failed_context),patch('vfs.execute_probe',return_value=(0,json.dumps(probe()).encode(),{'stderr_bytes':0})):
            code=run_counterfactual('amd64',directory)
            result=json.loads((Path(directory)/'vfs-counterfactual.json').read_text())
        self.assertEqual(code,1);self.assertFalse(result['passed'])
        self.assertEqual(result['failure_category'],'RuntimeError')

    def test_unverified_backend_never_executes_native_probe(self):
        from contextlib import contextmanager
        import json,tempfile
        from pathlib import Path
        from types import SimpleNamespace
        from unittest.mock import patch
        from vfs import run_counterfactual
        changed=facts();changed['driver']='overlay2'
        endpoint=SimpleNamespace(facts=changed,environment={},remaining_seconds=lambda:60,cleanup_verified=True)
        @contextmanager
        def context(**kwargs):
            yield endpoint
            endpoint.facts['default_daemon_unchanged']=True
        with tempfile.TemporaryDirectory() as directory,patch('isolated_daemon.isolated_vfs_daemon',side_effect=context),patch('vfs.execute_probe') as execute:
            code=run_counterfactual('amd64',directory)
            result=json.loads((Path(directory)/'vfs-counterfactual.json').read_text())
        self.assertEqual(code,1);self.assertFalse(result['passed'])
        execute.assert_not_called()
        self.assertNotIn('daemon',result)

class CleanupDiagnostics(unittest.TestCase):
    def test_cleanup_failure_retains_only_bounded_safe_observations(self):
        from contextlib import contextmanager
        import json,tempfile
        from pathlib import Path
        from types import SimpleNamespace
        from unittest.mock import patch
        from vfs import run_counterfactual
        endpoint=SimpleNamespace(facts=facts(),environment={},remaining_seconds=lambda:60,cleanup_verified=False,
            cleanup_observations={'empty_inspection':'timeout','empty_inspection_ms':1000,
                'daemon_returncode':0,'daemon_stdout_bytes':8,'owned_process_reaped':True,
                'private_path':'SECRET'},
            retirement_facts={'cli_returncode':1,'stages':[[5,1,1,0]],'journal_missing':False,'unknown':'SECRET'})
        @contextmanager
        def failed_context(**kwargs):
            try:yield endpoint
            finally:
                endpoint.facts['default_daemon_unchanged']=True
                raise RuntimeError('SECRET')
        with tempfile.TemporaryDirectory() as directory,patch('isolated_daemon.isolated_vfs_daemon',side_effect=failed_context),patch('vfs.execute_probe',return_value=(0,json.dumps(probe()).encode(),{'stderr_bytes':0})):
            self.assertEqual(run_counterfactual('amd64',directory),1)
            result=json.loads((Path(directory)/'vfs-counterfactual.json').read_text())
        self.assertEqual(result['daemon_cleanup_observations']['empty_inspection'],'timeout')
        self.assertEqual(result['daemon_retirement_observations']['stages'],[[5,1,1,0]])
        self.assertNotIn('SECRET',json.dumps(result))

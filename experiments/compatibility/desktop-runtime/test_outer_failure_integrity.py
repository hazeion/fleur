"""Independent outer finalization fault injection; never invokes Docker."""
import ast
from pathlib import Path
import time
from types import SimpleNamespace
import unittest

class FinalizationIntegrity(unittest.TestCase):
    def execute(self,**changes):
        tree=ast.parse((Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py').read_text())
        observe=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='observe')
        final=next(n.finalbody for n in observe.body if isinstance(n,ast.Try) and n.finalbody)
        events=[]
        def inventory(cleanup=False):events.append('final-preservation');return {'original':True}
        environment={'report':{'ok':True,'cleanup':[]},'workers':[],'owned':[],'guardian':None,
            'channels':[],'imported':[],'held':None,'original':{'original':True},'ledger_dir':None,
            'end':time.monotonic()+600,'inventory':inventory,'time':time}
        environment.update(changes)
        exec(compile(ast.fix_missing_locations(ast.Module(body=final,type_ignores=[])),'<actual-outer-finalization>','exec'),environment)
        return environment,events

    def test_artifact_descriptor_close_failure_retains_final_preservation_and_failed_report(self):
        def close():raise OSError('controlled close uncertainty')
        result,events=self.execute(held=SimpleNamespace(close=close))
        self.assertIn('final-preservation',events)
        self.assertFalse(result['report']['ok'])

    def test_scratch_disposal_failure_is_a_failed_report_not_lost_evidence(self):
        def cleanup():raise OSError('controlled scratch uncertainty')
        result,events=self.execute(ledger_dir=SimpleNamespace(cleanup=cleanup))
        self.assertIn('final-preservation',events)
        self.assertFalse(result['report']['ok'])
        self.assertIn('elapsedMs',result['report'])

    def test_unconfirmed_worker_retirement_preserves_guardian_and_rejects_success(self):
        guardian={'cid':'guardian','name':'guardian'};retired=[]
        def inspect(*args,**kwargs):return {'Id':'worker'}
        result,_=self.execute(workers=[{'name':'worker','owner':'owned'}],owned=[guardian],guardian=guardian,
            inspect=inspect,entry=SimpleNamespace(worker_profile=lambda *args:False),prep={'imageId':'image'},
            retire_role=lambda value:retired.append(value))
        self.assertEqual(retired,[])
        self.assertFalse(result['report']['ok'])
        self.assertEqual(result['report']['cleanup'],[{'resource':'worker','name':'worker','absent':False},{'resource':'guardian','absent':False}])

    def test_unconfirmed_manager_client_retirement_preserves_guardian(self):
        guardian={'cid':'guardian','name':'guardian'};retired=[]
        class Channel:
            def close(self,deadline):raise RuntimeError('controlled live client')
        result,_=self.execute(owned=[guardian],guardian=guardian,guardian_channel=object(),channels=[Channel()],
            retire_role=lambda value:retired.append(value))
        self.assertEqual(retired,[])
        self.assertFalse(result['report']['ok'])
        self.assertTrue(result['report']['clientRetirementUnconfirmed'])

if __name__=='__main__':unittest.main()

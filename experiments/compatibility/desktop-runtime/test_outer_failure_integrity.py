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

    def test_preservation_observation_error_is_distinct_from_an_actual_snapshot_difference(self):
        import importlib.util
        path=Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py'
        spec=importlib.util.spec_from_file_location('review_final_error_categories',path)
        outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)
        def unavailable(cleanup):raise RuntimeError('inventory deadline')
        unknown,_=self.execute(inventory=unavailable,error_category=outer.error_category)
        self.assertFalse(unknown['report']['ok'])
        self.assertFalse(unknown['report']['originalPreserved'])
        self.assertEqual(unknown['report']['preservationObservationError'],'HOST_INVENTORY_DEADLINE')
        different,_=self.execute(inventory=lambda cleanup:{'changed':True},error_category=outer.error_category)
        self.assertFalse(different['report']['ok'])
        self.assertFalse(different['report']['originalPreserved'])
        self.assertNotIn('preservationObservationError',different['report'])

    def test_unconfirmed_worker_retirement_preserves_guardian_and_rejects_success(self):
        guardian={'cid':'guardian','name':'guardian'};retired=[]
        def inspect(*args,**kwargs):return {'Id':'worker'}
        result,_=self.execute(workers=[{'name':'worker','owner':'owned'}],owned=[guardian],guardian=guardian,
            inspect=inspect,entry=SimpleNamespace(worker_profile=lambda *args:False),runtime_image='image',
            retire_role=lambda value:retired.append(value))
        self.assertEqual(retired,[])
        self.assertFalse(result['report']['ok'])
        self.assertEqual(result['report']['cleanup'],[{'resource':'worker','name':'worker','absent':False},{'resource':'guardian','containerId':'guardian','absent':False}])

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

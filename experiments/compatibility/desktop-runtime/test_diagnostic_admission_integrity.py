"""A successful underlying capabilities result never qualifies the trace lane."""
import ast
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

path=Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py'
spec=importlib.util.spec_from_file_location('review_trace_admission_outer',path);outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)

class DiagnosticAdmissionIntegrity(unittest.TestCase):
    def execute(self,wrong_binding=False):
        tree=ast.parse(path.read_text());observe=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='observe')
        branch=next(n for n in ast.walk(observe) if isinstance(n,ast.If) and isinstance(n.test,ast.Compare) and isinstance(n.test.left,ast.Name) and n.test.left.id=='mode' and any(isinstance(v,ast.Constant) and v.value=='--controller-diagnostic' for v in n.test.comparators))
        trace={'kind':'trace-installed','nonce':'foreign' if wrong_binding else 'owned','managerId':'a'*64,'entrySourceSha256':'b'*64,'traceApplied':True,'entryMainCodeUnmodified':True,'readyRoleMetadataAdapted':True}
        class Channel:
            def __init__(self):self.frames=iter([trace,{'kind':'result','ok':True}]);self.child=SimpleNamespace(returncode=0)
            def frame(self,end):return next(self.frames)
            def drain(self,end):return b'',b''
            def close(self,end):pass
        channel=Channel();environment={'mode':'--controller-diagnostic','nonce':'owned','binding':{'sources':{'entry.py':'b'*64}},'image':'fixed','base_env':[],
            'DIAGNOSTIC_PROGRAM':outer.DIAGNOSTIC_PROGRAM,'sha':outer.sha,'work_end':100,'report':{'ok':False,'runtimeAdmission':False,'nativeQualification':False},
            'channels':[channel],'start_role':lambda *args,**kwargs:({'cid':'a'*64},channel,{'kind':'ready'})}
        fn=ast.FunctionDef(name='actual_branch',args=ast.arguments(posonlyargs=[],args=[],kwonlyargs=[],kw_defaults=[],defaults=[]),body=[branch],decorator_list=[])
        exec(compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),'<actual-diagnostic-admission>','exec'),environment)
        return environment['actual_branch']()

    def test_underlying_capabilities_success_is_still_diagnostic_only(self):
        result=self.execute();self.assertFalse(result['ok']);self.assertFalse(result['nativeQualification']);self.assertFalse(result['runtimeAdmission'])
        self.assertTrue(result['diagnosticComplete']);self.assertTrue(result['diagnosticOnly']);self.assertEqual(result['error'],'DIAGNOSTIC_ONLY_NOT_QUALIFICATION')

    def test_trace_marker_from_another_binding_is_refused(self):
        with self.assertRaisesRegex(RuntimeError,'DIAGNOSTIC_RECEIPT_UNCONFIRMED'):self.execute(True)

if __name__=='__main__':unittest.main()

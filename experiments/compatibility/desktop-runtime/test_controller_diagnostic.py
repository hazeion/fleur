import importlib.util
import hashlib
import json
import os
import sys
import types
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace
import unittest

spec=importlib.util.spec_from_file_location('controller_diagnostic_outer',Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py');outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)

class FixedControllerDiagnostic(unittest.TestCase):
    def definitions(self):
        namespace={'__name__':'diagnostic_contract_fixture'}
        exec(compile(outer.DIAGNOSTIC_PROGRAM,'<actual-fixed-diagnostic>','exec'),namespace)
        return namespace
    def test_only_existing_fixed_controller_commands_are_labelled(self):
        ns=self.definitions();failure=ns['failure_record']
        record=failure(['/usr/bin/sudo','-n','/usr/bin/python3','-I','-c','import os;assert os.geteuid()==0;print("root-launch-confirmed")'],SimpleNamespace(returncode=1,stdout=b'',stderr=b'permission denied\n'),'fixed','a'*64,{'isSocket':True,'uid':501,'gid':20,'mode':432})
        self.assertEqual(record['command'],'root-launch');self.assertEqual(record['exitCode'],1);self.assertEqual(record['stderr'],'permission denied\n')
        with self.assertRaises(ValueError):failure(['docker','run','unapproved'],SimpleNamespace(returncode=1,stdout=b'',stderr=b''),'fixed','a'*64,{})
    def test_diagnostic_output_is_bounded_and_never_declares_qualification(self):
        ns=self.definitions();record=ns['failure_record'](['docker','version','--format','{{json .Server}}'],SimpleNamespace(returncode=1,stdout=b'x'*10000,stderr=b'y'*5000),'fixed','a'*64,{})
        self.assertEqual(len(record['stderr']),4096);self.assertTrue(record['stderrTruncated']);self.assertEqual(record['stdoutBytes'],10000)
        self.assertNotIn('stdout',record);self.assertNotIn('ok',record);self.assertNotIn('nativeQualification',record)

    def test_trace_preserves_the_original_failed_command_and_result(self):
        source="""def main():
 emit({'kind':'ready','role':'manager','managerId':'a'*64})
 def command(args):
  calls.append(args)
  result=SimpleNamespace(returncode=1,stdout=b'',stderr=b'fixed permission denial\\n')
  if result.returncode or result.stderr:raise RuntimeError('FIXED_COMMAND_FAILED')
 try:command(['docker','version','--format','{{json .Server}}'])
 except RuntimeError as error:
  emit({'kind':'result','ok':False,'error':str(error)})
  return 4
"""
        fake=types.ModuleType('entry');frames=[];calls=[]
        fake.__dict__.update(emit=frames.append,calls=calls,SimpleNamespace=SimpleNamespace)
        exec(compile(source,'/controller/entry.py','exec'),fake.__dict__)
        binding={'nonce':'fixed','sources':{'entry.py':hashlib.sha256(source.encode()).hexdigest()}}
        previous=sys.gettrace()
        try:
            with patch.dict(sys.modules,{'entry':fake}),patch.dict(os.environ,{'FLEUR_DESKTOP_BINDING':json.dumps(binding)}),patch.object(Path,'read_bytes',return_value=source.encode()),patch.object(sys,'path',list(sys.path)),patch.object(sys,'argv',list(sys.argv)):
                with self.assertRaises(SystemExit) as outcome:exec(compile(outer.DIAGNOSTIC_PROGRAM,'<actual-fixed-diagnostic>','exec'),{'__name__':'__main__'})
            self.assertEqual(outcome.exception.code,4)
        finally:sys.settrace(previous)
        self.assertEqual(calls,[['docker','version','--format','{{json .Server}}']])
        self.assertEqual([frame['kind'] for frame in frames],['ready','trace-installed','command-failure','result'])
        self.assertTrue(frames[1]['traceApplied']);self.assertTrue(frames[1]['entryMainCodeUnmodified'])
        self.assertEqual(frames[-1],{'kind':'result','ok':False,'error':'FIXED_COMMAND_FAILED'})

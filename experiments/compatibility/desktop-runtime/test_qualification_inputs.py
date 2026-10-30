"""Exercise driver input refusals with private files and bounded-command fixtures."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('qualification_inputs_outer',Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py')
outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)
CANDIDATE='desktop-4.97.0-244584'

class QualificationInputs(unittest.TestCase):
    def execute(self, *, candidate=CANDIDATE, body=b'fixture authenticated executable', version=b'1.4.3\n', proof_candidate=CANDIDATE, drift=False, replace_after_version=False):
        events=[]
        with tempfile.TemporaryDirectory() as directory:
            executable=Path(directory).resolve()/'bun with spaces';executable.write_bytes(body);executable.chmod(0o700)
            def bounded(args,**kwargs):
                events.append(args)
                stdout=b''
                if args[0]=='/usr/sbin/sysctl':stdout=b'7\n'
                elif args[:2]==['git','rev-parse']:stdout=b'a'*40+b'\n'
                elif args[:2]==['git','diff']:pass
                elif args[:2]==['git','show']:
                    relative=args[2].split(':',1)[1];stdout=(outer.ROOT/relative).read_bytes()
                    if drift and relative=='scripts/observe-desktop-control.ts':stdout+=b'changed'
                elif args==[str(executable),'--version']:
                    stdout=version
                    if replace_after_version:executable.write_bytes(b'replaced after authentication')
                elif args[0]==str(executable):
                    stdout=json.dumps({'ok':True,'candidate':proof_candidate,'controlCapabilityVerified':True,'originalPreserved':True,'transportUncertain':False}).encode()
                else:raise AssertionError('unexpected external command: '+args[0])
                return SimpleNamespace(returncode=0,stdout=stdout,stderr=b'')
            # Use an independently specified synthetic pin for a synthetic executable.
            # Real Darwin binary provenance is checked separately against the pinned archive.
            with patch.dict(os.environ,{'FLEUR_DESKTOP_RUNTIME_QUALIFICATION':'yes'}), patch.object(outer.platform,'system',return_value='Darwin'), patch.object(outer.platform,'machine',return_value='x86_64'), patch.object(outer.processes,'bounded',side_effect=bounded), patch.object(outer,'BUN_SHA256',hashlib.sha256(b'fixture authenticated executable').hexdigest(),create=True):
                result=outer.observe('--capabilities',directory,candidate=candidate,pinned_bun=str(executable))
        self.assertFalse(result['ok']);self.assertFalse(result['runtimeAdmission'])
        return result,events

    def test_explicit_executable_is_one_argument_and_candidate_is_bound_to_preflight(self):
        result,events=self.execute(proof_candidate='desktop-4.96.1-244132')
        self.assertEqual(result['error'],'CONTROL_PREFLIGHT_CANDIDATE_CHANGED')
        self.assertEqual(events[-1][1:],['scripts/observe-desktop-control.ts','--run','--candidate='+CANDIDATE])
        self.assertEqual(result['bun'],{'version':'1.4.3','sha256':hashlib.sha256(b'fixture authenticated executable').hexdigest()})
        self.assertNotIn('bun with spaces',json.dumps(result))

    def test_unknown_candidate_refuses_before_any_external_command(self):
        result,events=self.execute(candidate='arbitrary; command')
        self.assertEqual(result['error'],'EXACT_DESKTOP_TUPLE_REQUIRED');self.assertEqual(events,[])

    def test_wrong_binary_hash_refuses_before_execution(self):
        result,events=self.execute(body=b'wrong executable')
        self.assertEqual(result['error'],'PINNED_BUN_REQUIRED')
        self.assertFalse(any('bun with spaces' in args[0] for args in events))

    def test_wrong_version_refuses_before_control_preflight(self):
        for version in (b'1.4.4\n',b'1.4.3',b'1.4.3\nextra\n'):
            result,events=self.execute(version=version)
            self.assertEqual(result['error'],'PINNED_BUN_VERSION_REQUIRED')
            self.assertEqual(events[-1][1:],['--version'])

    def test_binary_replacement_after_version_refuses_before_preflight(self):
        result,events=self.execute(replace_after_version=True)
        self.assertEqual(result['error'],'PINNED_BUN_REQUIRED')
        self.assertEqual(events[-1][1:],['--version'])

    def test_changed_control_source_refuses_before_executable_or_docker_use(self):
        result,events=self.execute(drift=True)
        self.assertEqual(result['error'],'OPERATOR_SOURCE_BYTES_CHANGED')
        self.assertFalse(any('bun with spaces' in args[0] for args in events))

if __name__=='__main__':unittest.main()

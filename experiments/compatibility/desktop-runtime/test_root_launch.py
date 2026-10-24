"""Root proof accepts only the measured isolated-controller sudo warnings."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec=importlib.util.spec_from_file_location('root_launch_entry',Path(__file__).with_name('entry.py'))
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)

class RootLaunch(unittest.TestCase):
    cid='891a2ae570d9'+'a'*52
    warnings=(b'sudo: unable to resolve host 891a2ae570d9: Temporary failure in name resolution\n'
              b'sudo: unable to send audit message: Operation not permitted\n')

    def launch(self,stderr=b'',stdout=b'root-launch-confirmed\n',code=0,cid=None):
        calls=[]
        def bounded(args,**kwargs):
            calls.append((args,kwargs))
            return SimpleNamespace(returncode=code,stdout=stdout,stderr=stderr)
        proof=entry.root_launch(self.cid if cid is None else cid,bounded)
        self.assertEqual(calls,[(['/usr/bin/sudo','-n','/usr/bin/python3','-I','-c','import os;assert os.geteuid()==0;print("root-launch-confirmed")'],{'timeout':5})])
        return proof

    def test_exact_actual_success_with_measured_warnings_is_root_proof(self):
        self.assertEqual(self.launch(self.warnings),{'verified':True,'stderr':self.warnings.decode()})

    def test_silent_actual_success_is_root_proof(self):
        self.assertEqual(self.launch(),{'verified':True,'stderr':''})

    def test_status_output_identity_and_warning_changes_refuse(self):
        for kwargs in ({'code':1},{'code':-9},{'code':True},{'stdout':b''},
                       {'stdout':b'root-launch-confirmed\nextra'},
                       {'stderr':self.warnings.replace(b'891a2ae570d9',b'aaaaaaaaaaaa')},
                       {'stderr':self.warnings.splitlines(keepends=True)[0]},
                       {'stderr':b''.join(reversed(self.warnings.splitlines(keepends=True)))},
                       {'stderr':self.warnings+b'extra\n'},{'stderr':b'permission denied\n'},
                       {'cid':'a'*12},{'cid':'A'*64}):
            with self.subTest(kwargs=kwargs),self.assertRaises(RuntimeError):self.launch(**kwargs)

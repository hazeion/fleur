import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('desktop_entry', Path(__file__).with_name('entry.py'))
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)

class BindingTests(unittest.TestCase):
    def good(self):
        return {'nonce':'a1234567-1234-4234-8234-123456789abc', 'bootId':'b1234567-1234-4234-8234-123456789abc',
                'daemonId':'abcd:efgh', 'kernel':'7.0.14-linuxkit', 'sourceCommit':'a'*40,
                'sources':{'runtime-probe/run.py':'b'*64, 'entry.py':'c'*64},'guardianId':'d'*64,'preparedImage':None}
    def test_exact_controller_binding(self):
        self.assertTrue(entry.valid_binding(self.good()))
    def test_missing_extra_coercible_foreign_bindings_refuse(self):
        good=self.good()
        for field in good:
            missing=dict(good);missing.pop(field)
            self.assertFalse(entry.valid_binding(missing))
        for changed in ({'extra':True},{'nonce':'arbitrary'},{'bootId':'unknown'}, {'kernel':'another-kernel'},
                        {'sourceCommit':'a'*39},{'sources':{}},{'sources':{'../escape':'a'*64}},
                        {'sources':{'entry.py':True}},{'daemonId':''}):
            self.assertFalse(entry.valid_binding(dict(good,**changed)))
        self.assertFalse(entry.valid_binding(None))
    def test_runtime_result_requires_all_original_oracles(self):
        # The controller must use run.main's result, not relabel successful preparation.
        self.assertFalse(entry.complete_result(0, {'bounded_probe_passed':False}))
        self.assertFalse(entry.complete_result(1, {'bounded_probe_passed':True}))
        self.assertFalse(entry.complete_result(0, {'bounded_probe_passed':True,'cleanup_complete':True}))
        self.assertFalse(entry.complete_result(False, {}))


class GuardianContractTests(unittest.TestCase):
    def test_complete_ledger_accounts_for_every_original_worker(self):
        rows=entry.worker_ledger('fleur-runtime-probe-123','sha256:'+'a'*64)
        self.assertEqual(len(rows),13);self.assertEqual(len({row['name'] for row in rows}),13)
        self.assertEqual(sum(row['owner'].endswith('-idle') for row in rows),4)
        self.assertIn({'name':'fleur-runtime-probe-123-memory','owner':'fleur-runtime-probe-123'},rows)
    def test_guardian_only_runs_the_fixed_original_guard_request(self):
        spawned=[]
        def spawn(args,**kwargs):spawned.append((args,kwargs));return 'process'
        guardian='a'*64;worker='b'*64
        launch=entry.guardian_launcher(guardian,'original guard',spawn)
        args=['/usr/bin/sudo','-n','/usr/bin/python3','-I','-c','original guard',worker,'123','12345.1']
        self.assertEqual(launch(args,stdin='pipe'),'process')
        self.assertEqual(spawned[0][0],['docker','exec','--interactive','--user','0:0',guardian,'/usr/bin/python3','-I','/controller/guardian_guard.py',worker,'123','12345.1'])
        for changed in (args[:-1],['/bin/sh',*args[1:]],args[:5]+['foreign program']+args[6:],args[:6]+['foreign',*args[7:]],args[:7]+['1',args[8]]):
            with self.assertRaises(RuntimeError):launch(changed)
        self.assertEqual(len(spawned),1)

if __name__=='__main__':unittest.main()

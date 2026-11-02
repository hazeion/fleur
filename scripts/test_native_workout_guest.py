import importlib.util
import copy
from pathlib import Path
import subprocess
import tempfile
import unittest
spec = importlib.util.spec_from_file_location('guest', Path(__file__).with_name('native-workout-guest.py'))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
class BrowserPlan(unittest.TestCase):
    def test_new_browser_libraries_are_frozen_by_name_and_version(self):
        plan = 'Inst libnss3 (2:3.110-1 Debian:13.1/stable [amd64])\nConf libnss3 (2:3.110-1 Debian:13.1/stable [amd64])\n'
        self.assertEqual(guest.browser_plan(plan, {'libc6':'2.41-12'}), ['libnss3=2:3.110-1'])
    def test_existing_distribution_packages_cannot_be_upgraded(self):
        with self.assertRaisesRegex(ValueError, 'existing'):
            guest.browser_plan('Inst libc6 [2.41-12] (2.41-13 Debian:13.1/stable [amd64])\n', {'libc6':'2.41-12'})
    def test_removals_or_noncanonical_package_names_are_refused(self):
        for plan in ['Remv libc6 [2.41-12]\n', 'Inst --option (1 Debian:13/stable [amd64])\n', 'Inst libnss3 (1 external/repo [arm64])\n']:
            with self.subTest(plan=plan), self.assertRaises(ValueError): guest.browser_plan(plan,{})
class Source(unittest.TestCase):
    def test_round_trip_preserves_the_original_commit_and_has_no_remotes(self):
        with tempfile.TemporaryDirectory() as scratch:
            root=Path(scratch); source=root/'source'; source.mkdir()
            def git(*args): return subprocess.check_output(['git','-C',str(source),*args],stderr=subprocess.DEVNULL)
            git('init','--template=','--quiet'); (source/'proof.txt').write_text('Owned source\n')
            git('add','.'); git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture')
            (source/'proof.txt').write_text('Owned source with history\n')
            git('add','.'); git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','second fixture')
            commit=git('rev-parse','HEAD').decode().strip()
            objects=git('rev-list','--objects','--no-object-names',commit+'^{tree}')+commit.encode()+b'\n'
            packed=subprocess.check_output(['git','-C',str(source),'pack-objects','--stdout'],input=objects)
            target=root/'restored'; guest.restore_source(packed,commit,target)
            self.assertEqual(subprocess.check_output(['git','-C',str(target),'rev-parse','HEAD']).decode().strip(),commit)
            self.assertEqual(subprocess.check_output(['git','-C',str(target),'status','--porcelain']),b'')
            self.assertEqual(subprocess.check_output(['git','-C',str(target),'remote']),b'')
            self.assertEqual((target/'proof.txt').read_text(),'Owned source with history\n')
            self.assertEqual(subprocess.check_output(['git','-C',str(target),'rev-list','--count','HEAD']).strip(),b'1')
class ProofSource(unittest.TestCase):
    commits = {'fleur': 'a'*40, 'workout': 'b'*40}
    def proof(self):
        return {'ok': True, 'source': {name: {'commit': commit, 'dirty': False, 'treeSha256': 'c'*64, 'files': 1} for name,commit in self.commits.items()}}
    def test_completed_packed_proof_binds_both_clean_sources(self):
        guest.verify_proof_source(self.proof(), self.commits)
    def test_each_wrong_commit_or_dirty_source_is_refused(self):
        for name in self.commits:
            for field,value in [('commit','d'*40),('dirty',True),('treeSha256','invalid'),('files',0)]:
                proof=self.proof(); proof['source'][name][field]=value
                with self.subTest(name=name,field=field), self.assertRaises(ValueError): guest.verify_proof_source(proof,self.commits)
    def test_missing_or_legacy_flat_source_is_refused(self):
        for source in [{}, {'commit':self.commits['workout']}, {'workout':self.proof()['source']['workout']}]:
            with self.subTest(source=source), self.assertRaises(ValueError): guest.verify_proof_source({'ok':True,'source':source},self.commits)
    def test_incomplete_proof_cannot_qualify(self):
        proof=copy.deepcopy(self.proof()); proof['ok']=False
        with self.assertRaises(ValueError): guest.verify_proof_source(proof,self.commits)
if __name__=='__main__': unittest.main()

import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('desktop_export_worker',Path(__file__).with_name('export_worker.py'))
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class ToolAndArtifactContracts(unittest.TestCase):
    def test_compiler_selects_its_actual_subprogram_location(self):
        with tempfile.TemporaryDirectory() as directory:
            actual=Path(directory)/'libexec'/'cc1';actual.parent.mkdir();actual.write_bytes(b'actual compiler stage')
            calls=[]
            def compiler(args,**kwargs):calls.append(args);return SimpleNamespace(returncode=0,stdout=str(actual)+'\n',stderr='')
            self.assertEqual(worker.compiler_subprogram('cc1',compiler),actual.resolve())
            self.assertEqual(calls,[['/usr/local/bin/gcc','-print-prog-name=cc1']])
            self.assertEqual(worker.compiler_subprogram('as',lambda *args,**kwargs:SimpleNamespace(returncode=0,stdout='as\n',stderr=''),lambda name:str(actual)),actual.resolve())
    def test_unknown_or_ambiguous_compiler_program_is_rejected(self):
        for output,status in (('relative\nextra\n',0),('',0),('cc1\n',1)):
            with self.assertRaises(RuntimeError):worker.compiler_subprogram('cc1',lambda *args,**kwargs:SimpleNamespace(returncode=status,stdout=output,stderr=''))
        with self.assertRaises(RuntimeError):worker.compiler_subprogram('foreign')
    def test_partial_root_exports_are_readable_to_artifact_uploader(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory);artifact=path/'runtime-image.tar';artifact.write_bytes(b'partial export');artifact.chmod(0o600)
            worker.publish_readable_outputs(path)
            self.assertEqual(artifact.stat().st_mode&0o777,0o644)
            self.assertEqual(path.stat().st_mode&0o777,0o700)
    def test_publication_never_follows_a_symlink_or_hardlink(self):
        for link in ('symlink','hardlink'):
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory);foreign=path/'foreign';foreign.write_bytes(b'foreign');foreign.chmod(0o600)
                artifact=path/'runtime-image.tar'
                if link=='symlink':artifact.symlink_to(foreign)
                else:os.link(foreign,artifact)
                with self.assertRaises(RuntimeError):worker.publish_readable_outputs(path)
                self.assertEqual(foreign.stat().st_mode&0o777,0o600)
if __name__=='__main__':unittest.main()

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('desktop_artifact_inputs',Path(__file__).with_name('artifact_inputs.py'))
module=importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name]=module;spec.loader.exec_module(module)

class ArtifactInputs(unittest.TestCase):
    def fixture(self,path):
        pins={}
        for name in module.FILES:
            body=(json.dumps({'formatVersion':1,'scope':'disposable-image-preparation-retirement','cleanup':[{'resource':'container','absent':True},{'resource':'image','absent':True}],'ok':True,'runtimeAdmission':False,'nativeQualification':False})+'\n').encode() if name=='preparation-cleanup.json' else b'fixed authentic bytes\n'
            (path/name).write_bytes(body);(path/name).chmod(0o600)
            pins[name]={'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}
        origin={'formatVersion':1,'scope':'desktop-qualification-image-preparation','runtimeAdmission':False,'nativeQualification':False,'sourceCommit':'a'*40,'controllerImageId':'sha256:'+'b'*64,'artifacts':pins,'cleanup':[{'resource':'container','absent':True},{'resource':'image','absent':True}],'ok':True}
        data=(json.dumps(origin)+'\n').encode();(path/'image-origin.json').write_bytes(data);(path/'image-origin.json').chmod(0o600)
        return {'formatVersion':1,'scope':'source-owned-desktop-preparation-inputs','runtimeAdmission':False,'producer':{'workflowRunId':123,'artifactId':456,'zipSha256':'c'*64,'imageOriginSha256':hashlib.sha256(data).hexdigest()},'origin':origin}
    def test_source_pinned_bytes_are_held_and_revalidated(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory);catalog=self.fixture(path)
            self.assertTrue(module.valid_catalog(catalog))
            with module.open_artifacts(path,catalog) as held:
                fd=held.verify('runtime-image.tar')
                self.assertEqual(os.read(fd,100),b'fixed authentic bytes\n')
                self.assertEqual(held.read_json('image-origin.json'),catalog['origin'])
    def test_byte_drift_and_descriptor_replacement_refuse(self):
        for replacement in ('bytes','symlink','hardlink','named-replacement'):
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory);catalog=self.fixture(path)
                with module.open_artifacts(path,catalog) as held:
                    target=path/'runtime-image.tar'
                    if replacement=='bytes':target.write_bytes(b'changed bytes')
                    elif replacement=='symlink':target.unlink();target.symlink_to(path/'controller-image.tar')
                    elif replacement=='hardlink':os.link(target,path/'foreign-link')
                    else:target.unlink();target.write_bytes(b'fixed authentic bytes\n');target.chmod(0o600)
                    with self.assertRaises(ValueError):held.verify('runtime-image.tar')
    def test_foreign_extra_missing_or_public_inputs_refuse(self):
        for changed in ('extra','missing','symlink','public'):
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory);catalog=self.fixture(path)
                if changed=='extra':(path/'foreign').write_text('foreign')
                elif changed=='missing':(path/'runtime-image.tar').unlink()
                elif changed=='symlink':(path/'runtime-image.tar').unlink();(path/'runtime-image.tar').symlink_to(path/'controller-image.tar')
                else:(path/'runtime-image.tar').chmod(0o644)
                with self.assertRaises((ValueError,OSError)):module.open_artifacts(path,catalog)
    def test_catalog_cannot_admit_runtime_or_coerce_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            catalog=self.fixture(Path(directory))
            for key,value in (('runtimeAdmission',True),('formatVersion',True),('extra',True)):
                self.assertFalse(module.valid_catalog(dict(catalog,**{key:value})))
            changed=json.loads(json.dumps(catalog));changed['producer']['artifactId']=True
            self.assertFalse(module.valid_catalog(changed))
            changed=json.loads(json.dumps(catalog));changed['origin']['artifacts']['runtime-image.tar']['bytes']=True
            self.assertFalse(module.valid_catalog(changed))
    def test_duplicate_json_keys_refuse(self):
        with self.assertRaises(ValueError):module.canonical_json('{"ok":false,"ok":true}')
if __name__=='__main__':unittest.main()

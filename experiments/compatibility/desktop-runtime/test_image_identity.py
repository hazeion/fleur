import ast
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

path=Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py'
spec=importlib.util.spec_from_file_location('image_identity_outer',path);outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)

class NativeManifestIdentity(unittest.TestCase):
    def test_complete_inventory_includes_untagged_native_manifests(self):
        tree=ast.parse(path.read_text());observe=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='observe');function=next(x for x in observe.body if isinstance(x,ast.FunctionDef) and x.name=='inventory')
        tagged='sha256:'+'a'*64;untagged='sha256:'+'b'*64
        def docker(args,*options):
            if args[:2]==['image','ls']:return '\n'.join([tagged,untagged] if '--all' in args else [tagged])+'\n'
            if args[0]=='ps':return ''
            return 'daemon'
        environment={'docker':docker,'inspect':lambda image,*args:{'Id':image,'RepoTags':['preserved:latest'] if image==tagged else []},'command':lambda *args:'original-context','json':json}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[])),'<actual-inventory>','exec'),environment)
        self.assertEqual(set(json.loads(environment['inventory']()['images'])),{tagged,untagged})
    def fixture(self):
        identity=SimpleNamespace(config_image_id='sha256:'+'a'*64,manifest_image_id='sha256:'+'b'*64,manifest_bytes=710,configuration={'config':{'User':'0:0','Labels':{'owned':'fixed'}},'rootfs':{'diff_ids':['sha256:'+'c'*64]}})
        value={'Id':identity.manifest_image_id,'Architecture':'amd64','Os':'linux','Config':identity.configuration['config'],'RootFS':{'Type':'layers','Layers':identity.configuration['rootfs']['diff_ids']},'Descriptor':{'digest':identity.manifest_image_id,'mediaType':'application/vnd.oci.image.manifest.v1+json','size':710}}
        return identity,value
    def test_native_object_requires_manifest_config_and_rootfs_chain(self):
        identity,value=self.fixture();self.assertTrue(outer.matches_image(value,identity))
        for key,new in [('Id',identity.config_image_id),('Architecture','arm64'),('Os','darwin'),('Config',{}),('RootFS',{}),('Descriptor',{'digest':identity.manifest_image_id,'size':710})]:
            changed=copy.deepcopy(value);changed[key]=new;self.assertFalse(outer.matches_image(changed,identity))

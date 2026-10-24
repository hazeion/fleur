"""Measured legacy Docker config projection, keeping all executable/security fields exact."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec=importlib.util.spec_from_file_location('review_native_config_outer',Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py')
outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)

class NativeConfigProjection(unittest.TestCase):
    def fixture(self):
        legacy={'OpenStdin':False,'AttachStdout':False,'Tty':False,'Volumes':None,'Image':'sha256:'+'d'*64,'OnBuild':None,'Domainname':'','Hostname':'','StdinOnce':False,'AttachStderr':False,'Cmd':None,'AttachStdin':False}
        visible={'User':'65534:65534','Env':['PATH=/usr/bin'],'Entrypoint':['bun','/probe/bootstrap.js'],'WorkingDir':'/probe','Labels':{'owned':'fixed'}}
        identity=SimpleNamespace(config_image_id='sha256:'+'a'*64,manifest_image_id='sha256:'+'b'*64,manifest_bytes=1763,configuration={'config':{**visible,**legacy},'rootfs':{'diff_ids':['sha256:'+'c'*64]}})
        value={'Id':identity.manifest_image_id,'Architecture':'amd64','Os':'linux','Config':visible,'RootFS':{'Type':'layers','Layers':identity.configuration['rootfs']['diff_ids']},'Descriptor':{'digest':identity.manifest_image_id,'mediaType':'application/vnd.oci.image.manifest.v1+json','size':1763}}
        return identity,value

    def test_authenticated_legacy_defaults_have_the_exact_measured_native_projection(self):
        identity,value=self.fixture();self.assertTrue(outer.matches_image(value,identity))

    def test_runtime_authority_and_unknown_native_fields_remain_exact(self):
        identity,value=self.fixture()
        for key,new in [('User','0:0'),('Env',['PATH=/foreign']),('Entrypoint',['foreign']),('WorkingDir','/foreign'),('Labels',{}),('UnknownAuthority',True)]:
            changed=copy.deepcopy(value);changed['Config'][key]=new
            self.assertFalse(outer.matches_image(changed,identity),key)

    def test_projection_cannot_hide_nondefault_legacy_runtime_behavior(self):
        identity,value=self.fixture()
        for key,new in [('OpenStdin',True),('Tty',True),('Hostname','foreign'),('Domainname','foreign'),('Volumes',{'/host':{}}),('OnBuild',['RUN foreign']),('Cmd',['foreign']),('Image','foreign')]:
            changed=copy.deepcopy(identity);changed.configuration['config'][key]=new
            self.assertFalse(outer.matches_image(value,changed),key)

if __name__=='__main__':unittest.main()

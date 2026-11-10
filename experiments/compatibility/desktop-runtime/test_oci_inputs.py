import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import time
import unittest

spec=importlib.util.spec_from_file_location('oci_inputs',Path(__file__).with_name('oci_inputs.py'))
oci=importlib.util.module_from_spec(spec);spec.loader.exec_module(oci)

class ImageArchiveTests(unittest.TestCase):
    def archive(self,change=None,architecture='arm64'):
        layer=b'native layer bytes';digest=lambda x:hashlib.sha256(x).hexdigest()
        config=json.dumps({'architecture':architecture,'os':'linux','config':{'Env':['PATH=/usr/bin'],'Volumes':None},'rootfs':{'type':'layers','diff_ids':['sha256:'+digest(layer)]}}).encode()
        cid=digest(config);cp='blobs/sha256/'+cid;lp='blobs/sha256/'+digest(layer)
        manifest={'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':'sha256:'+cid,'size':len(config)},'layers':[{'mediaType':'application/vnd.oci.image.layer.v1.tar','digest':'sha256:'+digest(layer),'size':len(layer)}]}
        raw=json.dumps(manifest).encode();mp='blobs/sha256/'+digest(raw)
        members={'manifest.json':json.dumps([{'Config':cp,'RepoTags':None,'Layers':[lp]}]).encode(),'index.json':json.dumps({'schemaVersion':2,'mediaType':'application/vnd.oci.image.index.v1+json','manifests':[{'mediaType':'application/vnd.oci.image.manifest.v1+json','digest':'sha256:'+digest(raw),'size':len(raw)}]}).encode(),'oci-layout':b'{"imageLayoutVersion":"1.0.0"}',cp:config,lp:layer,mp:raw}
        if change:change(members)
        output=io.BytesIO()
        with tarfile.open(fileobj=output,mode='w') as archive:
            for name,body in members.items():
                info=tarfile.TarInfo(name);info.size=len(body);archive.addfile(info,io.BytesIO(body))
        output.seek(0);return output,'sha256:'+cid
    def test_one_native_untagged_image_is_bound_to_config_and_layers_for_each_architecture(self):
        for architecture in ('arm64','amd64'):
            stream,cid=self.archive(architecture=architecture);self.assertEqual(oci.validate_archive(stream,cid,time.monotonic()+5,architecture).configuration['config']['Env'],['PATH=/usr/bin'],architecture)
    def test_an_archive_for_another_architecture_refuses_and_there_is_no_default(self):
        for architecture,other in (('arm64','amd64'),('amd64','arm64')):
            stream,cid=self.archive(architecture=architecture)
            with self.assertRaises(oci.ArchitectureMismatch):oci.validate_archive(stream,cid,time.monotonic()+5,other)
            stream.seek(0)
            # An expected architecture outside the two native names is a caller fault, not a prepared-image mismatch.
            with self.assertRaises(ValueError) as caught:oci.validate_archive(stream,cid,time.monotonic()+5,'aarch64' if architecture=='arm64' else 'x86_64')
            self.assertNotIsInstance(caught.exception,oci.ArchitectureMismatch)
        stream,cid=self.archive()
        with self.assertRaises(TypeError):oci.validate_archive(stream,cid,time.monotonic()+5)
    def test_manifest_execution_identity_is_bound_separately_from_config_digest(self):
        stream,cid=self.archive();identity=oci.validate_archive(stream,cid,time.monotonic()+5,'arm64')
        stream.seek(0)
        with tarfile.open(fileobj=stream) as archive:root=json.load(archive.extractfile('index.json'))['manifests'][0]['digest']
        self.assertEqual(identity.config_image_id,cid)
        self.assertEqual(identity.manifest_image_id,root)
        self.assertNotEqual(identity.config_image_id,identity.manifest_image_id)
    def test_tags_extra_images_corrupt_layers_and_traversal_refuse(self):
        def tagged(m):
            value=json.loads(m['manifest.json']);value[0]['RepoTags']=['foreign:latest'];m['manifest.json']=json.dumps(value).encode()
        def extra(m):m['manifest.json']=json.dumps(json.loads(m['manifest.json'])*2).encode()
        def corrupt(m):
            key=next(k for k,v in m.items() if v==b'native layer bytes');m[key]=b'corrupt layer bytes'
        for change in (tagged,extra,corrupt,lambda m:m.update({'../escape':b'x'})):
            stream,cid=self.archive(change)
            with self.assertRaises(ValueError):oci.validate_archive(stream,cid,time.monotonic()+5,'arm64')
    def test_wrong_expected_image_and_expired_budget_refuse(self):
        stream,cid=self.archive()
        with self.assertRaises(ValueError):oci.validate_archive(stream,'sha256:'+'0'*64,time.monotonic()+5,'arm64')
        stream.seek(0)
        with self.assertRaises(ValueError):oci.validate_archive(stream,cid,time.monotonic()-1,'arm64')

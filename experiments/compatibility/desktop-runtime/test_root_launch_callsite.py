"""Execute actual controller main with read-only host seams; no native commands."""
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('review_root_callsite_entry',Path(__file__).with_name('entry.py'))
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)

class RootLaunchCallsite(unittest.TestCase):
    def execute(self,fault=None,*,binding_override=None,server_override=None,mode="--capabilities"):
        cid='a'*64;guardian='d'*64;events=[];frames=[]
        binding={'candidate':'desktop-4.96.1-244132','nonce':'a1234567-1234-4234-8234-123456789abc','bootId':'b1234567-1234-4234-8234-123456789abc','daemonId':'actual-daemon','kernel':'7.0.14-linuxkit','sourceCommit':'b'*40,'sources':{'entry.py':hashlib.sha256(b'source').hexdigest()},'guardianId':guardian,'preparedImage':None}
        if binding_override is not None:binding=json.loads(json.dumps(binding_override))
        class FakePath:
            def __init__(self,value):self.value=str(value)
            def __truediv__(self,value):return FakePath(self.value+'/'+value)
            def is_symlink(self):return False
            def read_bytes(self):return b'changed' if fault=='source' else b'source'
            def read_text(self):
                if self.value.endswith('/boot_id'):return ('foreign' if fault=='boot' else binding['bootId'])+'\n'
                if self.value.endswith('/source-manifest.json'):return json.dumps({'sourceCommit':binding['sourceCommit'],'sources':binding['sources']})
                if self.value=='/proc/self/cgroup':return 'unbound\n' if fault=='cgroup' else '0::/docker/'+cid+'\n'
                raise AssertionError('unexpected read '+self.value)
        def bounded(args,**options):
            events.append(('command',args))
            if args[:2]==['docker','version']:
                body={'Platform':{'Name':'Docker Desktop 4.96.1 (244132)'},'Version':'29.9.2','GitCommit':'0367cbe','KernelVersion':binding['kernel'],'Arch':'amd64'}
                if server_override is not None:body=server_override
            elif args[:2]==['docker','info']:body='foreign' if fault=='daemon' else binding['daemonId']
            elif args[:3]==['docker','inspect',guardian]:
                body={'Id':guardian,'Image':'fixed-image','Mounts':[],'Config':{'Labels':{entry.OWNER:binding['nonce'],entry.ROLE:'foreign' if fault=='guardian' else 'guardian'}},'State':{'Running':True}}
            elif args[:3]==['docker','inspect',cid]:body={'Id':cid,'Image':'fixed-image'}
            else:raise AssertionError('unexpected command '+repr(args))
            return SimpleNamespace(returncode=0,stdout=json.dumps(body).encode(),stderr=b'')
        def root_launch(manager_id,runner):
            events.append(('root',manager_id));self.assertIs(runner,bounded)
            raise RuntimeError('ROOT_LAUNCH_UNCONFIRMED')
        fake_module=SimpleNamespace(bounded=bounded)
        fake_spec=SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module:None))
        with patch.object(entry,'Path',FakePath),patch.object(entry,'ROOT',FakePath('/controller')),patch.object(entry.platform,'system',return_value='Linux'),patch.object(entry.platform,'machine',return_value='x86_64'),patch.object(entry.platform,'release',return_value=binding['kernel']),patch.object(entry.os,'geteuid',return_value=0),patch.object(entry.os,'readlink',return_value='pid:[fixed]'),patch.dict(entry.os.environ,{'FLEUR_DESKTOP_BINDING':json.dumps(binding)}),patch.object(entry.sys,'argv',['entry.py',mode]),patch.object(entry.importlib.util,'spec_from_file_location',return_value=fake_spec),patch.object(entry.importlib.util,'module_from_spec',return_value=fake_module),patch.object(entry,'emit',side_effect=frames.append),patch.object(entry,'acknowledge',return_value=None),patch.object(entry,'root_launch',side_effect=root_launch),patch.object(entry.time,'sleep',side_effect=lambda seconds:events.append(('guardian-sleep',seconds))):
            code=entry.main()
        return code,events,frames

    def test_actual_identity_daemon_and_guardian_checks_precede_root_helper(self):
        code,events,frames=self.execute()
        self.assertEqual(code,4);self.assertEqual(events[-1],('root','a'*64))
        self.assertEqual([value[1][:2] for value in events[:-1]],[['docker','version'],['docker','info'],['docker','inspect'],['docker','inspect']])
        self.assertEqual(frames[-1]['error'],'ROOT_LAUNCH_UNCONFIRMED')
        self.assertFalse(frames[-1]['ok']);self.assertNotIn('rootLaunchVerified',frames[-1]);self.assertNotIn('rootLaunch',frames[-1])

    def test_source_vm_cgroup_daemon_or_guardian_refusal_never_reaches_root_helper(self):
        for fault in ('source','boot','cgroup','daemon','guardian'):
            with self.subTest(fault=fault):
                code,events,frames=self.execute(fault)
                self.assertEqual(code,4);self.assertFalse(any(event[0]=='root' for event in events))
                self.assertFalse(frames[-1]['ok']);self.assertNotIn('rootLaunchVerified',frames[-1])

if __name__=='__main__':unittest.main()

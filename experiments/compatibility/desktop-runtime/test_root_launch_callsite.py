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

DESKTOPS={'arm64':('aarch64',{'Platform':{'Name':'Docker Desktop 4.99.0 (245822)'},'Version':'29.9.3','GitCommit':'70efc0e','Arch':'arm64'}),'amd64':('x86_64',{'Platform':{'Name':'Docker Desktop 4.96.1 (244132)'},'Version':'29.9.2','GitCommit':'0367cbe','Arch':'amd64'})}

class RootLaunchCallsite(unittest.TestCase):
    def execute(self,fault=None,architecture='arm64'):
        machine,desktop=DESKTOPS[architecture];other=DESKTOPS['amd64' if architecture=='arm64' else 'arm64'][1]
        cid='a'*64;guardian='d'*64;events=[];frames=[]
        binding={'nonce':'a1234567-1234-4234-8234-123456789abc','bootId':'b1234567-1234-4234-8234-123456789abc','daemonId':'actual-daemon','kernel':'7.0.14-linuxkit','sourceCommit':'b'*40,'sources':{'entry.py':hashlib.sha256(b'source').hexdigest()},'guardianId':guardian,'preparedImage':None}
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
                body={**(other if fault=='tuple' else desktop),'KernelVersion':binding['kernel']}
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
        with patch.object(entry,'Path',FakePath),patch.object(entry,'ROOT',FakePath('/controller')),patch.object(entry.platform,'system',return_value='Linux'),patch.object(entry.platform,'machine',return_value=machine),patch.object(entry.platform,'release',return_value=binding['kernel']),patch.object(entry.os,'geteuid',return_value=0),patch.object(entry.os,'readlink',return_value='pid:[fixed]'),patch.dict(entry.os.environ,{'FLEUR_DESKTOP_BINDING':json.dumps(binding)}),patch.object(entry.sys,'argv',['entry.py','--capabilities']),patch.object(entry.importlib.util,'spec_from_file_location',return_value=fake_spec),patch.object(entry.importlib.util,'module_from_spec',return_value=fake_module),patch.object(entry,'emit',side_effect=frames.append),patch.object(entry,'acknowledge',return_value=None),patch.object(entry,'root_launch',side_effect=root_launch):
            code=entry.main()
        return code,events,frames

    def test_actual_identity_daemon_and_guardian_checks_precede_root_helper_on_each_architecture(self):
        for architecture in ('arm64','amd64'):
            with self.subTest(architecture=architecture):
                code,events,frames=self.execute(architecture=architecture)
                self.assertEqual(code,4);self.assertEqual(events[-1],('root','a'*64))
                self.assertEqual([value[1][:2] for value in events[:-1]],[['docker','version'],['docker','info'],['docker','inspect'],['docker','inspect']])
                self.assertEqual(frames[-1]['error'],'ROOT_LAUNCH_UNCONFIRMED')
                self.assertFalse(frames[-1]['ok']);self.assertNotIn('rootLaunchVerified',frames[-1]);self.assertNotIn('rootLaunch',frames[-1])

    def test_source_vm_cgroup_daemon_or_guardian_refusal_never_reaches_root_helper(self):
        for architecture in ('arm64','amd64'):
            for fault in ('source','boot','cgroup','daemon','guardian','tuple'):
                with self.subTest(architecture=architecture,fault=fault):
                    code,events,frames=self.execute(fault,architecture)
                    self.assertEqual(code,4);self.assertFalse(any(event[0]=='root' for event in events))
                    self.assertFalse(frames[-1]['ok']);self.assertNotIn('rootLaunchVerified',frames[-1])
                    if fault=='tuple':self.assertEqual(frames[-1]['error'],'DESKTOP_TUPLE_CHANGED')

    def test_the_other_architectures_desktop_tuple_is_a_tuple_change_not_an_identity_pass(self):
        for architecture in ('arm64','amd64'):
            code,events,frames=self.execute('tuple',architecture)
            self.assertEqual((code,frames[-1]['error']),(4,'DESKTOP_TUPLE_CHANGED'),architecture)
            self.assertEqual([value[1][:2] for value in events],[['docker','version']],architecture)

    def test_a_controller_on_an_unknown_machine_refuses_before_any_command(self):
        for machine in ('i686','riscv64','arm64','x64',''):
            with patch.dict(DESKTOPS,{'arm64':(machine,DESKTOPS['arm64'][1])}):
                code,events,frames=self.execute(architecture='arm64')
            self.assertEqual((code,events,frames[-1]['error']),(4,[],'NATIVE_LINUX_MANAGER_REQUIRED'),machine)

if __name__=='__main__':unittest.main()

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

outer_spec=importlib.util.spec_from_file_location('desktop_outer',Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py')
outer=importlib.util.module_from_spec(outer_spec);outer_spec.loader.exec_module(outer)

class ManagerProfileTests(unittest.TestCase):
    def good(self):
        nonce='a1234567-1234-4234-8234-123456789abc';cid='a'*64;image='sha256:'+'b'*64
        expected=dict(cid=cid,name='fleur-desktop-manager-'+nonce,image=image,nonce=nonce,binding='fixed-source-bound-input',mode='--capabilities')
        value={'Id':cid,'Name':'/'+expected['name'],'Image':image,'Mounts':[{'Type':'bind','Source':'/var/run/docker.sock','Destination':'/var/run/docker.sock','RW':True}],
               'State':{'Running':True,'Pid':123},'Config':{'Image':image,'OpenStdin':True,'Tty':False,'Labels':{outer.OWNER:nonce,outer.ROLE:'manager'},'User':'0:0','Entrypoint':['/usr/bin/python3'],'Cmd':['-I','-u','/controller/entry.py','--capabilities'],'Env':['FLEUR_DESKTOP_BINDING='+expected['binding']],'Volumes':None},
               'HostConfig':{'Privileged':False,'ReadonlyRootfs':True,'NetworkMode':'none','PidMode':'host','CgroupnsMode':'host','CapDrop':['ALL'],'CapAdd':['CAP_KILL','CAP_SETGID','CAP_SETUID','CAP_SYS_PTRACE'],
                             'SecurityOpt':['no-new-privileges:true','seccomp=unconfined','label=disable'],'Memory':2147483648,'MemorySwap':2147483648,'NanoCpus':2000000000,'PidsLimit':256,'Tmpfs':{'/tmp':'rw,nosuid,nodev,noexec,size=536870912,mode=1777'},'Binds':['/var/run/docker.sock:/var/run/docker.sock:rw']}}
        return value,expected
    def test_exact_trusted_controller_only(self):
        value,expected=self.good();self.assertTrue(outer.manager_profile(value,**expected))
    def test_malformed_expected_identity_refuses(self):
        value,expected=self.good()
        for change in ({'image':'unknown'},{'nonce':'unknown'},{'name':'foreign-name'},{'mode':'arbitrary'}):
            # Matching an invalid caller-supplied profile must not authorize cleanup.
            altered=dict(expected,**change);copy=__import__('copy').deepcopy(value)
            if 'image' in change:copy['Image']=change['image']
            if 'nonce' in change:copy['Config']['Labels'][outer.OWNER]=change['nonce']
            if 'name' in change:copy['Name']='/'+change['name']
            if 'mode' in change:copy['Config']['Cmd']=[change['mode']]
            self.assertFalse(outer.manager_profile(copy,**altered))
    def test_unknown_authority_and_foreign_custody_refuse(self):
        value,expected=self.good()
        changes=[('Id','c'*64),('Image','sha256:'+'c'*64),('Mounts',[])]
        for key,new in changes:self.assertFalse(outer.manager_profile(dict(value,**{key:new}),**expected))
        for key,new in [('Privileged',True),('ReadonlyRootfs',False),('NetworkMode','host'),('PidMode','private'),('CgroupnsMode','private'),('CapAdd',['ALL']),('SecurityOpt',['seccomp=unconfined']),('Tmpfs',{'/tmp':'rw'}),('Memory',0),('MemorySwap',-1),('PidsLimit',0),('Binds',['/:/host:rw']),('Devices',[{}])]:
            copy=__import__('copy').deepcopy(value);copy['HostConfig'][key]=new
            self.assertFalse(outer.manager_profile(copy,**expected))
        for key,new in [('Cmd',['--qualify']),('User','65534:65534'),('Env',['FLEUR_DESKTOP_BINDING=foreign']),('Labels',{})]:
            copy=__import__('copy').deepcopy(value);copy['Config'][key]=new
            self.assertFalse(outer.manager_profile(copy,**expected))


class ArchitectureSelection(unittest.TestCase):
    """Run the actual observer through operator-source and catalog selection with host seams; the preflight and Docker are never reached unless selection admits the host."""
    HOSTS={'arm64':('arm64','16777228\n','0\n'),'x64':('x86_64','7\n',None)}
    def entry(self,commit):
        pins={name:{'bytes':16,'sha256':hashlib.sha256(name.encode()).hexdigest()} for name in outer.artifacts.FILES}
        origin={'formatVersion':1,'scope':'desktop-qualification-image-preparation','runtimeAdmission':False,'nativeQualification':False,'sourceCommit':commit,'controllerImageId':'sha256:'+'b'*64,'artifacts':pins,'cleanup':[{'resource':'container','absent':True},{'resource':'image','absent':True}],'ok':True}
        return {'producer':{'workflowRunId':123,'artifactId':456,'zipSha256':'c'*64,'imageOriginSha256':'d'*64},'origin':origin}
    def observe(self,host,catalog,proof=None):
        machine,cpu,translated=self.HOSTS[host];calls=[]
        def bounded(args,**options):
            calls.append(args)
            if args[:2]==['/usr/sbin/sysctl','-n']:
                if args[2]=='hw.cputype':return SimpleNamespace(returncode=0,stdout=cpu.encode(),stderr=b'')
                if translated is None:return SimpleNamespace(returncode=1,stdout=b'',stderr=b"sysctl: unknown oid 'sysctl.proc_translated'\n")
                return SimpleNamespace(returncode=0,stdout=translated.encode(),stderr=b'')
            if args[:2]==['git','rev-parse']:return SimpleNamespace(returncode=0,stdout=('f'*40+'\n').encode(),stderr=b'')
            if args[:2]==['git','diff']:return SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
            if args[:2]==['git','show']:return SimpleNamespace(returncode=0,stdout=(outer.ROOT/args[2].split(':',1)[1]).read_bytes(),stderr=b'')
            if args[1:]==['scripts/observe-desktop-control.ts','--run']:return SimpleNamespace(returncode=0 if proof else 4,stdout=json.dumps(proof or {'ok':False}).encode(),stderr=b'')
            raise AssertionError('selection must precede '+repr(args))
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'image-origin.json').write_text(json.dumps(catalog))
            with patch.dict(outer.os.environ,{'FLEUR_DESKTOP_RUNTIME_QUALIFICATION':'yes'}),patch.object(outer.platform,'system',return_value='Darwin'),patch.object(outer.platform,'machine',return_value=machine),patch.object(outer.processes,'bounded',side_effect=bounded),patch.object(outer,'DIRECTORY',Path(directory)):
                report=outer.observe('--capabilities','/nonexistent/private/inputs')
        preflight=any(args[1:]==['scripts/observe-desktop-control.ts','--run'] for args in calls);docker=any(args[0]=='docker' for args in calls)
        return report,preflight,docker
    def catalog(self,**entries):return {'formatVersion':1,'scope':'source-owned-desktop-preparation-inputs','runtimeAdmission':False,**entries}
    def test_each_native_mac_selects_its_own_entry_and_only_then_runs_the_control_preflight(self):
        both=self.catalog(arm64=self.entry('a'*40),amd64=self.entry('e'*40))
        for host in ('arm64','x64'):
            report,preflight,docker=self.observe(host,both)
            self.assertTrue(preflight,host);self.assertFalse(docker,host)
            self.assertEqual((report['architecture'],report['error'],report['failurePhase']),(host,'FRESH_CONTROL_PREFLIGHT_REQUIRED','fresh-control-preflight'))
            self.assertEqual(report['catalogArchitectures'],['arm64','amd64'])
    def test_a_host_without_a_prepared_entry_refuses_before_any_container_naming_the_architecture(self):
        for host,catalog,present in (('arm64',self.catalog(amd64=self.entry('e'*40)),['amd64']),('x64',self.catalog(arm64=self.entry('a'*40)),['arm64'])):
            report,preflight,docker=self.observe(host,catalog)
            self.assertFalse(preflight,host);self.assertFalse(docker,host)
            self.assertEqual((report['architecture'],report['error'],report['failurePhase']),(host,'PREPARED_IMAGE_ARCHITECTURE_MISMATCH','prepared-image-selection'))
            self.assertEqual(report['catalogArchitectures'],present);self.assertIn('operatorSource',report);self.assertNotIn('controlPreflight',report)
    def test_a_legacy_single_record_catalog_refuses_before_any_container(self):
        report,preflight,docker=self.observe('arm64',self.catalog(**self.entry('a'*40)))
        self.assertFalse(preflight);self.assertFalse(docker)
        self.assertEqual((report['error'],report['failurePhase']),('DESKTOP_OBSERVATION_FAILED','prepared-image-selection'))
    def test_a_preflight_proof_for_another_architecture_is_not_a_fresh_control_preflight(self):
        both=self.catalog(arm64=self.entry('a'*40),amd64=self.entry('e'*40))
        for host,other in (('arm64','x64'),('x64','arm64')):
            proof={'ok':True,'controlCapabilityVerified':True,'originalPreserved':True,'transportUncertain':False,'architecture':other,'endpointSha256':'0'*64,'server':{},'probe':{'bootId':'b1234567-1234-4234-8234-123456789abc'}}
            report,preflight,docker=self.observe(host,both,proof)
            self.assertTrue(preflight,host);self.assertFalse(docker,host)
            self.assertEqual((report['error'],report['failurePhase']),('FRESH_CONTROL_PREFLIGHT_REQUIRED','fresh-control-preflight'),host)
            self.assertNotIn('controlPreflight',report)

if __name__=='__main__':unittest.main()

import importlib.util
from pathlib import Path
import unittest

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



if __name__=='__main__':unittest.main()

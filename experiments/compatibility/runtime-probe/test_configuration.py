"""Actual inspect metadata must satisfy the agreed worker authority profile."""
import copy
import json
import unittest
from configuration import audit_configuration, host_environment, OWNER_LABEL, CANARY_NAME

IMAGE = 'sha256:'+'a'*64

def metadata():
    return {'Id':'a'*64,'Name':'/worker','Image':IMAGE,
            'Config':{'Image':IMAGE,'User':'65534:65534','Labels':{OWNER_LABEL:'owner'},
                      'Env':['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin',
                             'BUN_RUNTIME_TRANSPILER_CACHE_PATH=0','BUN_INSTALL_BIN=/usr/local/bin','GLIBC_TUNABLES=glibc.pthread.rseq=0']},
            'HostConfig':{'ReadonlyRootfs':True,'Privileged':False,'CapDrop':['ALL'],'CapAdd':None,
                          'SecurityOpt':['no-new-privileges','seccomp=unconfined'],'NanoCpus':1000000000,
                          'Memory':536870912,'MemorySwap':536870912,'PidsLimit':64,'NetworkMode':'none',
                          'Binds':None,'Mounts':None,'VolumesFrom':None,'Devices':[],'DeviceRequests':None,
                          'PidMode':'','IpcMode':'private','RestartPolicy':{'Name':'no'}},
            'Mounts':[],'State':{'Running':True,'Pid':47},
            'NetworkSettings':{'Networks':{'none':{'IPAddress':'','Gateway':'','GlobalIPv6Address':'','IPv6Gateway':''}}}}

class ActualWorkerConfiguration(unittest.TestCase):
    def test_only_verified_safe_metadata_leaves_redacted_boundary(self):
        result = audit_configuration(metadata(),'owner','worker',IMAGE)
        self.assertTrue(result['owned'])
        self.assertEqual(result['memory_bytes'],536870912)
        self.assertEqual(result['environment_keys'],['BUN_INSTALL_BIN','BUN_RUNTIME_TRANSPILER_CACHE_PATH','GLIBC_TUNABLES','PATH'])
        self.assertTrue(result['host_canary_absent'])
        self.assertNotIn('Env',json.dumps(result))

    def test_unsafe_identity_authority_or_resource_metadata_is_refused(self):
        changes = [('Name','/another-worker'),('Image','sha256:'+'b'*64),
                   ('Config.User','0:0'),('HostConfig.Privileged',True),('HostConfig.ReadonlyRootfs',False),
                   ('HostConfig.CapAdd',['SYS_ADMIN']),('HostConfig.CapDrop',[]),
                   ('HostConfig.SecurityOpt',['seccomp=unconfined']),('HostConfig.NanoCpus',2000000000),
                   ('HostConfig.Memory',1073741824),('HostConfig.MemorySwap',1073741824),('HostConfig.PidsLimit',128),
                   ('HostConfig.NetworkMode','host'),('Mounts',[{'Source':'/var/run/docker.sock'}]),
                   ('HostConfig.Devices',[{}]),('HostConfig.PidMode','host'),('HostConfig.IpcMode','host'),
                   ('HostConfig.RestartPolicy',{'Name':'always'}),('State.Running',False)]
        for path,value in changes:
            changed = metadata()
            target = changed
            keys = path.split('.')
            for key in keys[:-1]: target = target[key]
            target[keys[-1]] = value
            with self.subTest(path=path), self.assertRaises(ValueError):
                audit_configuration(changed,'owner','worker',IMAGE)

    def test_unknown_environment_values_canary_credentials_and_duplicates_are_never_reported(self):
        host = host_environment()
        secret = host[CANARY_NAME]
        for entry in (CANARY_NAME+'='+secret,'DATABASE_URL='+secret,'DOCKER_HOST='+secret,
                      'PATH='+secret,'BUN_INSTALL_BIN=/usr/local/bin'):
            changed = metadata()
            changed['Config']['Env'][0] = entry
            with self.assertRaises(ValueError) as caught:
                audit_configuration(changed,'owner','worker',IMAGE)
            self.assertFalse(secret in str(caught.exception))
        self.assertFalse(secret in json.dumps(audit_configuration(metadata(),'owner','worker',IMAGE)))

    def test_exact_worker_rseq_configuration_is_required_without_extra_tunables(self):
        good = metadata()
        result = audit_configuration(good,'owner','worker',IMAGE)
        self.assertEqual(result['glibc_rseq_registration'],'disabled')
        for value in (None,'glibc.pthread.rseq=1','glibc.pthread.rseq=0:glibc.malloc.check=1'):
            changed = copy.deepcopy(good)
            changed['Config']['Env'] = [entry for entry in changed['Config']['Env'] if not entry.startswith('GLIBC_TUNABLES=')]
            if value is not None: changed['Config']['Env'].append('GLIBC_TUNABLES='+value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                audit_configuration(changed,'owner','worker',IMAGE)

    def test_only_full_immutable_running_container_identity_can_bind_waiter(self):
        good = metadata();good['Id'] = 'a'*64
        self.assertEqual(audit_configuration(good,'owner','worker',IMAGE)['container_id'],'a'*64)
        for value in (None,'a'*12,'g'*64,'sha256:'+'a'*64):
            changed = copy.deepcopy(good);changed['Id'] = value
            with self.subTest(value=value),self.assertRaises(ValueError):
                audit_configuration(changed,'owner','worker',IMAGE)

    def test_init_host_pid_is_measured_positive_integer_not_worker_supplied(self):
        good=metadata();good['State']['Pid']=47
        self.assertEqual(audit_configuration(good,'owner','worker',IMAGE)['host_init_pid'],47)
        for value in (None,0,-1,True,'47',2**32):
            changed=copy.deepcopy(good);changed['State']['Pid']=value
            with self.subTest(value=value),self.assertRaises(ValueError):
                audit_configuration(changed,'owner','worker',IMAGE)

    def test_containerd_control_requires_measured_docker_association_and_pinned_schema(self):
        from configuration import audit_containerd_control
        commit='ee2735368117d2eb259779949d5e75cdafec9761'
        server={'Version':'28.0.4','GitCommit':'6430e49','Components':[{'Name':'containerd','Version':'v2.3.6','Details':{'GitCommit':commit}}]}
        version='ctr github.com/containerd/containerd/v2 v2.3.6\n'
        detail=f'Client:\n Version: v2.3.6\n Revision: {commit}\nServer:\n Version: v2.3.6\n Revision: {commit}\n'
        result=audit_containerd_control(['dockerd','--containerd=/run/containerd/containerd.sock'],{},server,version,detail)
        self.assertEqual(result['address'],'/run/containerd/containerd.sock')
        self.assertEqual(result['namespace'],'moby')
        for args,config,changed,cli in [(['dockerd'],{},server,version),(['dockerd','--containerd=tcp://other'],{},server,version),(['dockerd','--containerd=/run/ctr.sock'],{'containerd-namespace':'other'},server,version),(['dockerd','--containerd=/run/ctr.sock'],{},dict(server,Version='29.0.0'),version),(['dockerd','--containerd=/run/ctr.sock'],{},server,version.replace('2.3.6','2.3.5'))]:
            with self.subTest(args=args,config=config),self.assertRaises(ValueError):
                audit_containerd_control(args,config,changed,cli,detail)

    def test_documented_ctr_banner_omits_revision_but_local_and_server_revisions_remain_required(self):
        from configuration import audit_containerd_control
        commit='ee2735368117d2eb259779949d5e75cdafec9761'
        server={'Version':'28.0.4','GitCommit':'6430e49','Components':[{'Name':'containerd','Version':'v2.3.6','Details':{'GitCommit':commit}}]}
        banner='ctr github.com/containerd/containerd/v2 v2.3.6\n'
        detail=f'Client:\n  Version:  v2.3.6\n  Revision: {commit}\n  Go version: go1.25.1\n\nServer:\n  Version:  v2.3.6\n  Revision: {commit}\n  UUID: public-id\n'
        result=audit_containerd_control(['dockerd','--containerd=/run/containerd/containerd.sock'],{},server,banner,detail)
        self.assertTrue(result['ctr_revision_verified'])
        for bad in (detail.replace(commit,'0'*40,1),detail.replace(commit,'0'*40),detail.replace('v2.3.6','v2.3.5',1),'Client:\n Version: v2.3.6\n'):
            with self.subTest(bad=bad),self.assertRaises(ValueError) as error:
                audit_containerd_control(['dockerd','--containerd=/run/containerd/containerd.sock'],{},server,banner,bad)
            self.assertIn(error.exception.category,('ctr-version-detail','ctr-client-version','ctr-client-revision','ctr-server-revision'))
            self.assertNotIn('public-id',str(error.exception.observations))

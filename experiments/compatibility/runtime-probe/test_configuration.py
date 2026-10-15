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
        commit='f2551031d7276a770f65f98c9b52e57e7dad07e8'
        server={'Version':'28.0.4','GitCommit':'6430e49','Components':[{'Name':'containerd','Version':'v2.4.1','Details':{'GitCommit':commit}},{'Name':'runc','Version':'1.5.2','Details':{'GitCommit':'v1.5.2-0-g29dd3dc2'}}]}
        detail=f'Client:\n Version: v2.4.1\n Revision: {commit}\nServer:\n Version: v2.4.1\n Revision: {commit}\n'
        result=audit_containerd_control(['dockerd','--containerd=/run/containerd/containerd.sock'],{},server,detail)
        self.assertEqual(result['address'],'/run/containerd/containerd.sock')
        self.assertEqual(result['namespace'],'moby')
        for args,config,changed,cli in [(['dockerd'],{},server,detail),(['dockerd','--containerd=tcp://other'],{},server,detail),(['dockerd','--containerd=/run/ctr.sock'],{'containerd-namespace':'other'},server,detail),(['dockerd','--containerd=/run/ctr.sock'],{},dict(server,Version='29.0.0'),detail),(['dockerd','--containerd=/run/ctr.sock'],{},server,detail.replace('2.4.1','2.3.5'))]:
            with self.subTest(args=args,config=config),self.assertRaises(ValueError):
                audit_containerd_control(args,config,changed,cli)

    def test_authoritative_client_server_query_requires_local_and_server_revisions(self):
        from configuration import audit_containerd_control
        commit='f2551031d7276a770f65f98c9b52e57e7dad07e8'
        server={'Version':'28.0.4','GitCommit':'6430e49','Components':[{'Name':'containerd','Version':'v2.4.1','Details':{'GitCommit':commit}},{'Name':'runc','Version':'1.5.2','Details':{'GitCommit':'v1.5.2-0-g29dd3dc2'}}]}
        detail=f'Client:\n  Version:  v2.4.1\n  Revision: {commit}\n  Go version: go1.25.1\n\nServer:\n  Version:  v2.4.1\n  Revision: {commit}\n  UUID: public-id\n'
        result=audit_containerd_control(['dockerd','--containerd=/run/containerd/containerd.sock'],{},server,detail)
        self.assertTrue(result['ctr_revision_verified'])
        for bad in (detail.replace(commit,'0'*40,1),detail.replace(commit,'0'*40),detail.replace('v2.4.1','v2.3.5',1),'Client:\n Version: v2.4.1\n'):
            with self.subTest(bad=bad),self.assertRaises(ValueError) as error:
                audit_containerd_control(['dockerd','--containerd=/run/containerd/containerd.sock'],{},server,bad)
            self.assertIn(error.exception.category,('ctr-version-detail','ctr-client-version','ctr-client-revision','ctr-server-revision'))
            self.assertNotIn('public-id',str(error.exception.observations))

    def test_single_authoritative_version_query_retains_both_exact_revisions(self):
        from configuration import audit_containerd_control
        commit='f2551031d7276a770f65f98c9b52e57e7dad07e8'
        server={'Version':'28.0.4','GitCommit':'6430e49','Components':[{'Name':'containerd','Version':'v2.4.1','Details':{'GitCommit':commit}},{'Name':'runc','Version':'1.5.2','Details':{'GitCommit':'v1.5.2-0-g29dd3dc2'}}]}
        detail=f'Client:\n Version: v2.4.1\n Revision: {commit}\nServer:\n Version: v2.4.1\n Revision: {commit}\n'
        result=audit_containerd_control(['dockerd','--containerd=/run/containerd/containerd.sock'],{},server,detail)
        self.assertTrue(result['ctr_revision_verified'])
        self.assertEqual(result['version_evidence'],'single-client-server-query')
        for wrong in (detail.replace(commit,'0'*40,1),detail.replace('v2.4.1','v2.3.5'),detail.split('Server:')[0]):
            with self.assertRaises(ValueError):
                audit_containerd_control(['dockerd','--containerd=/run/containerd/containerd.sock'],{},server,wrong)

    def test_host_inspection_invokes_one_pinned_version_query_without_banner_startup(self):
        from pathlib import Path
        import stat
        from types import SimpleNamespace
        from unittest.mock import patch
        from configuration import inspect_containerd_control
        commit='f2551031d7276a770f65f98c9b52e57e7dad07e8'
        server={'Version':'28.0.4','GitCommit':'6430e49','Components':[{'Name':'containerd','Version':'v2.4.1','Details':{'GitCommit':commit}},{'Name':'runc','Version':'1.5.2','Details':{'GitCommit':'v1.5.2-0-g29dd3dc2'}}]}
        detail=f'Client:\n Version: v2.4.1\n Revision: {commit}\nServer:\n Version: v2.4.1\n Revision: {commit}\n'
        import subprocess
        real_run=subprocess.run
        calls=[]
        def metadata(path,*args,**kwargs):
            kind=stat.S_IFSOCK if str(path).endswith('.sock') else stat.S_IFREG if str(path) in ('/usr/bin/ctr','/usr/bin/true','/var/run/docker.pid') else stat.S_IFDIR
            return SimpleNamespace(st_uid=0,st_mode=kind|0o755,st_size=0)
        def contents(path):
            if str(path)=='/usr/bin/ctr' and getattr(self,'host_phase_clock',None) is not None:self.host_phase_clock[0]+=2
            if str(path)=='/var/run/docker.pid':return b'47'
            if str(path)=='/proc/47/cmdline':return b'/usr/bin/dockerd\0--containerd=/run/containerd/containerd.sock\0'
            return b'owned-executable'
        def command(args,**kwargs):
            calls.append(args)
            if '--version' in args and not getattr(self,'probe_first_use',False):raise AssertionError('redundant cold banner must not run')
            if args[0]=='/usr/bin/sudo':
                if getattr(self,'check_optional_rpc_environment',False):
                    self.assertIn('CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS=true',args,
                                  'host CLI must avoid the redundant deprecation RPC after sudo resets environment')
                    self.assertLess(args.index('/usr/bin/sudo'),args.index('CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS=true'))
                if getattr(self,'host_phase_clock',None) is not None:self.host_phase_clock[0]+=getattr(self,'host_phase_step',3)
                if args[-1]=='--version' and getattr(self,'fail_optional_banner',False):
                    return SimpleNamespace(returncode=124,stdout=b'private-host-output',stderr=b'private-host-error')
                if getattr(self,'probe_first_use',False) and args[-1] in ('/usr/bin/true','--version'):
                    return SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
                delay=getattr(self,'ctr_startup_delay',0)
                if delay:
                    import subprocess,sys
                    inner=float(args[args.index('--kill-after=0.2s')+1][:-1])
                    prefix='import os,time;'
                    if getattr(self,'ctr_pidfile',None):prefix+='open('+repr(self.ctr_pidfile)+',"w").write(str(os.getpid()));'
                    actual=real_run([sys.executable,'-c',prefix+'time.sleep('+str(delay)+');print('+repr(detail)+')'],capture_output=True,timeout=min(inner,kwargs['timeout']))
                    output=actual.stdout.decode()
                else:output=detail
                if getattr(self,'host_test_clock',None) is not None:self.host_test_clock[0]=16
                if getattr(self,'probe_first_use',False):
                    self.assertLessEqual(kwargs['timeout'],15);self.assertGreater(kwargs['timeout'],0)
                else:self.assertEqual(kwargs['timeout'],15);self.assertIn('14s',args)
            elif 'version' in args:output=json.dumps(server)
            else:output='owned-server\n'
            return SimpleNamespace(returncode=0,stdout=output.encode(),stderr=b'')
        with patch('daemon_trace.eligible_host',return_value=True),patch.object(Path,'resolve',lambda self,**kwargs:self),patch.object(Path,'stat',metadata),patch.object(Path,'read_bytes',contents),patch.object(Path,'read_text',return_value='dockerd\n'),patch.object(Path,'exists',return_value=False),patch('configuration.subprocess.run',side_effect=command):
            result=inspect_containerd_control(probe_first_use=getattr(self,'probe_first_use',False))
        self.last_host_control=result
        self.assertTrue(result['ctr_revision_verified'])
        self.assertEqual(sum(args[0]=='/usr/bin/sudo' for args in calls),3 if getattr(self,'probe_first_use',False) else 1)
        self.assertEqual(result['host_startup_budget_seconds'],15)

    def test_measured_cold_cli_startup_above_old_four_second_bound_can_complete(self):
        self.ctr_startup_delay=4.5
        self.test_host_inspection_invokes_one_pinned_version_query_without_banner_startup()

    def test_late_host_cli_is_rejected_and_real_child_is_reaped(self):
        import os,tempfile
        from pathlib import Path
        from configuration import ContainerdControlUnverified
        with tempfile.TemporaryDirectory() as directory:
            self.ctr_pidfile=str(Path(directory)/'pid')
            self.ctr_startup_delay=15.5
            with self.assertRaises(ContainerdControlUnverified) as caught:
                self.test_host_inspection_invokes_one_pinned_version_query_without_banner_startup()
            self.assertEqual(caught.exception.category,'ctr-version-command')
            self.assertTrue(caught.exception.observations['timed_out'])
            pid=int(Path(self.ctr_pidfile).read_text())
            with self.assertRaises(ProcessLookupError):os.kill(pid,0)

    def test_host_prerequisite_final_observation_cannot_escape_fifteen_second_fence(self):
        from unittest.mock import patch
        from configuration import ContainerdControlUnverified
        self.host_test_clock=[0]
        with patch('time.monotonic',side_effect=lambda:self.host_test_clock[0]),self.assertRaises(ContainerdControlUnverified) as caught:
            self.test_host_inspection_invokes_one_pinned_version_query_without_banner_startup()
        self.assertEqual(caught.exception.category,'ctr-startup-deadline')
        self.assertEqual(caught.exception.observations['host_startup_budget_seconds'],15)

    def test_authoritative_query_avoids_optional_deprecation_rpc_without_weakening_identity(self):
        self.check_optional_rpc_environment=True
        self.test_host_inspection_invokes_one_pinned_version_query_without_banner_startup()

    def test_report_binds_observed_runc_and_rejects_previous_or_unknown_runtime_builds(self):
        from configuration import audit_containerd_control
        commit='f2551031d7276a770f65f98c9b52e57e7dad07e8'
        server={'Version':'28.0.4','GitCommit':'6430e49','Components':[
            {'Name':'containerd','Version':'v2.4.1','Details':{'GitCommit':commit}},
            {'Name':'runc','Version':'1.5.2','Details':{'GitCommit':'v1.5.2-0-g29dd3dc2'}}]}
        detail=f'Client:\n Version: v2.4.1\n Revision: {commit}\nServer:\n Version: v2.4.1\n Revision: {commit}\n'
        arguments=['dockerd','--containerd=/run/containerd/containerd.sock']
        result=audit_containerd_control(arguments,{},server,detail)
        self.assertEqual(result['runc_version'],'1.5.2')
        self.assertEqual(result['runc_commit'],'v1.5.2-0-g29dd3dc2')
        for version,revision in [('v2.3.6','ee2735368117d2eb259779949d5e75cdafec9761'),
                                 ('v2.4.1','0'*40),('v2.4.2',commit)]:
            changed=copy.deepcopy(server);changed['Components'][0].update(Version=version,Details={'GitCommit':revision})
            with self.subTest(version=version),self.assertRaises(ValueError):
                audit_containerd_control(arguments,{},changed,detail)
        for value in ('1.5.1','unknown-runtime-secret'):
            changed=copy.deepcopy(server);changed['Components'][1]['Version']=value
            with self.assertRaises(ValueError) as caught:
                audit_containerd_control(arguments,{},changed,detail)
            self.assertNotIn(value,str(caught.exception))

    def test_cli_duration_excludes_identity_audit_and_binary_hash_cost(self):
        from unittest.mock import patch
        self.host_phase_clock=[0]
        with patch('time.monotonic',side_effect=lambda:self.host_phase_clock[0]):
            self.test_host_inspection_invokes_one_pinned_version_query_without_banner_startup()
        result=self.last_host_control
        self.assertEqual(result['host_version_duration_ms'],3000)
        self.assertEqual(result['host_startup_duration_ms'],5000)
        self.assertEqual(result['host_startup_phases_ms']['binary_sha256'],2000)
        self.assertEqual(result['host_startup_phases_ms']['authoritative_version'],3000)

    def test_first_use_probes_separate_privilege_binary_and_rpc_cost_within_original_budget(self):
        from unittest.mock import patch
        self.host_phase_clock=[0]
        self.probe_first_use=True
        with patch('time.monotonic',side_effect=lambda:self.host_phase_clock[0]):
            self.test_host_inspection_invokes_one_pinned_version_query_without_banner_startup()
        result=self.last_host_control
        self.assertEqual(result['host_startup_duration_ms'],11000)
        self.assertEqual(result['host_startup_phases_ms']['privileged_noop'],3000)
        self.assertEqual(result['host_startup_phases_ms']['ctr_banner'],3000)
        self.assertEqual(result['host_startup_phases_ms']['authoritative_version'],3000)
        self.assertTrue(result['first_version_preceded_by_startup_probes'])

    def test_first_use_probes_cannot_extend_the_fifteen_second_total_fence(self):
        from unittest.mock import patch
        from configuration import ContainerdControlUnverified
        self.host_phase_clock=[0]
        self.host_phase_step=6
        self.probe_first_use=True
        with patch('time.monotonic',side_effect=lambda:self.host_phase_clock[0]),self.assertRaises(ContainerdControlUnverified) as caught:
            self.test_host_inspection_invokes_one_pinned_version_query_without_banner_startup()
        self.assertEqual(caught.exception.category,'ctr-startup-deadline')
        self.assertEqual(caught.exception.observations['host_startup_budget_seconds'],15)

    def test_optional_banner_failure_preserves_evidence_and_allows_required_version_proof(self):
        from unittest.mock import patch
        self.host_phase_clock=[0]
        self.probe_first_use=True
        self.fail_optional_banner=True
        with patch('time.monotonic',side_effect=lambda:self.host_phase_clock[0]):
            self.test_host_inspection_invokes_one_pinned_version_query_without_banner_startup()
        result=self.last_host_control
        self.assertTrue(result['ctr_revision_verified'])
        self.assertEqual(result['host_startup_duration_ms'],11000)
        sample=result['host_startup_probes']['ctr_banner']
        self.assertFalse(sample['passed'])
        self.assertTrue(sample['timed_out'])
        self.assertEqual(sample['cli_returncode'],124)
        self.assertEqual(sample['duration_ms'],3000)
        self.assertNotIn('private-host',json.dumps(result))

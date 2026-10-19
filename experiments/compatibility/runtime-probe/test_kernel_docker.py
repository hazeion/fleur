"""The experimental create boundary admits only the fixed isolated profile."""
import unittest
from kernel_docker import worker_request

class KernelDockerTests(unittest.TestCase):
    def test_create_is_private_without_libnetwork_and_preserves_limits(self):
        request=worker_request('owner-worker','owner','sha256:'+'a'*64,'busy')
        self.assertIs(request['NetworkDisabled'],True)
        self.assertEqual(request['HostConfig']['NetworkMode'],'none')
        self.assertEqual(request['HostConfig']['Memory'],536870912)
        self.assertEqual(request['HostConfig']['MemorySwap'],536870912)
        self.assertEqual(request['HostConfig']['PidsLimit'],64)
        self.assertEqual(request['HostConfig']['NanoCpus'],1000000000)
        self.assertEqual(request['User'],'65534:65534')
        self.assertTrue(request['OpenStdin'])
        self.assertEqual(request['Cmd'],['busy'])
    def test_arbitrary_commands_images_and_names_are_refused(self):
        for mode in ('sh','/bin/sh','render;evil',None):
            with self.subTest(mode=mode),self.assertRaises(ValueError):
                worker_request('owner-worker','owner','sha256:'+'a'*64,mode)
        for image in ('tag','sha256:'+'g'*64):
            with self.assertRaises(ValueError):worker_request('worker','owner',image,'render')

class EngineBoundaryTests(unittest.TestCase):
    """Real Unix HTTP transport; only root socket UID is a platform fixture."""
    def engine(self, *, bad_owner=False, trickle=False, slow_body=False):
        import json,os,pathlib,socket,tempfile,threading,time
        from types import SimpleNamespace
        from unittest.mock import patch
        from kernel_docker import KernelPrivateDocker
        temporary=tempfile.TemporaryDirectory(dir='/tmp');self.addCleanup(temporary.cleanup)
        root=pathlib.Path(temporary.name);root.chmod(0o700)
        owner='fleur-vfs-'+'b'*32;(root/'owner').write_text(owner)
        listener=socket.socket(socket.AF_UNIX);listener.bind(str(root/'docker.sock'));listener.listen(5)
        listener.settimeout(2);self.addCleanup(listener.close)
        requests=[];faults=[]
        responses=[{'Version':'28.0.4','GitCommit':'6430e49','Components':[{'Name':'runc','Version':'1.5.2','Details':{'GitCommit':'v1.5.2-0-g29dd3dc2'}}]},
            {'Driver':'vfs','DockerRootDir':str(root/'data'),'Labels':['fleur.compatibility.vfs-owner='+('wrong' if bad_owner else owner)]},
            {'Id':'c'*64},
            {'Id':'c'*64,'Name':'/worker','Image':'sha256:'+'a'*64,
             'Config':{'Labels':{'fleur.compatibility.runtime-owner':'owner'}},
             'State':{'Status':'created','Running':False,'Pid':0}}]
        def serve():
            try:
                for index,response in enumerate(responses):
                    connection,_=listener.accept()
                    with connection:
                        stream=connection.makefile('rb')
                        first=stream.readline().decode();headers={}
                        while True:
                            line=stream.readline()
                            if line==b'\r\n':break
                            key,_,value=line.decode().partition(':');headers[key.lower()]=value.strip()
                        body=stream.read(int(headers.get('content-length','0')))
                        requests.append((first,json.loads(body) if body else None))
                        raw=json.dumps(response).encode();status=201 if index==2 else 200
                        header=('HTTP/1.1 '+str(status)+' OK\r\nContent-Length: '+str(len(raw))+'\r\nConnection: close\r\n\r\n').encode()
                        if trickle and index==2:
                            for byte in header+raw:
                                connection.sendall(bytes([byte]));time.sleep(.03)
                        elif slow_body and index==2:
                            connection.sendall(header)
                            for byte in raw:
                                connection.sendall(bytes([byte]));time.sleep(.03)
                        else:connection.sendall(header+raw)
            except (OSError,ValueError):pass
            except BaseException as exc:faults.append(exc)
        thread=threading.Thread(target=serve,daemon=True);thread.start()
        actual_stat=os.stat
        def rooted_socket(path,*args,**kwargs):
            value=actual_stat(path,*args,**kwargs)
            import stat
            if stat.S_ISSOCK(value.st_mode):
                return SimpleNamespace(st_mode=value.st_mode,st_uid=0,st_gid=os.getgid(),
                    st_dev=value.st_dev,st_ino=value.st_ino)
            return value
        fixture=patch('kernel_docker.os.stat',side_effect=rooted_socket);fixture.start();self.addCleanup(fixture.stop)
        return KernelPrivateDocker,{'DOCKER_HOST':'unix://'+str(root/'docker.sock')},requests,thread,faults

    def test_stopped_create_uses_exact_owned_engine_and_fixed_profile(self):
        constructor,environment,requests,thread,faults=self.engine()
        creator=constructor(environment);self.addCleanup(creator.close)
        self.assertEqual(creator.create_worker('worker','owner','sha256:'+'a'*64,'render'),'c'*64)
        thread.join(2);self.assertFalse(thread.is_alive());self.assertEqual(faults,[])
        self.assertTrue(requests[2][1]['NetworkDisabled'])
        self.assertEqual(requests[2][0],'POST /v1.48/containers/create?name=worker HTTP/1.1\r\n')
        self.assertEqual(requests[3][0],'GET /v1.48/containers/'+'c'*64+'/json HTTP/1.1\r\n')

    def test_daemon_with_another_owner_is_refused(self):
        constructor,environment,requests,thread,faults=self.engine(bad_owner=True)
        with self.assertRaisesRegex(ValueError,'owned VFS engine rejected'):constructor(environment)
        self.assertEqual(len(requests),2)

    def test_trickled_response_cannot_extend_total_creation_budget(self):
        import time
        constructor,environment,requests,thread,faults=self.engine(trickle=True)
        creator=constructor(environment);self.addCleanup(creator.close)
        began=time.monotonic()
        with self.assertRaises((OSError,ValueError,RuntimeError,TimeoutError)):
            creator.create_worker('worker','owner','sha256:'+'a'*64,'render',timeout=.15)
        self.assertLess(time.monotonic()-began,.5)

    def test_connection_close_body_trickle_cannot_extend_budget(self):
        import time
        constructor,environment,requests,thread,faults=self.engine(slow_body=True)
        creator=constructor(environment);self.addCleanup(creator.close)
        began=time.monotonic()
        with self.assertRaises((OSError,ValueError,RuntimeError,TimeoutError)):
            creator.create_worker('worker','owner','sha256:'+'a'*64,'render',timeout=.15)
        self.assertLess(time.monotonic()-began,.5)

    def test_deadline_error_retains_safe_create_phase_without_response_contents(self):
        constructor,environment,requests,thread,faults=self.engine(slow_body=True)
        creator=constructor(environment);self.addCleanup(creator.close)
        with self.assertRaises(RuntimeError) as caught:
            creator.create_worker('worker','owner','sha256:'+'a'*64,'render',timeout=.15)
        self.assertEqual(caught.exception.category,'vfs-engine-create-deadline')
        facts=caught.exception.observations
        self.assertEqual(facts['phase'],'create');self.assertTrue(facts['timed_out'])
        self.assertEqual(facts['budget_ms'],150)
        self.assertEqual(facts['http_status'],201)
        self.assertNotIn('worker',str(facts));self.assertNotIn('sha256',str(facts))

    def test_socket_replacement_is_refused_before_create(self):
        import os,socket
        constructor,environment,requests,thread,faults=self.engine()
        creator=constructor(environment);self.addCleanup(creator.close)
        old=socket.socket(socket.AF_UNIX);self.addCleanup(old.close)
        os.unlink(creator.path);old.bind(str(creator.path))
        with self.assertRaisesRegex(ValueError,'endpoint changed'):
            creator.create_worker('worker','owner','sha256:'+'a'*64,'render')
        self.assertEqual(len(requests),2)

class ResourceAuditGateTests(unittest.TestCase):
    def test_resource_stress_waits_for_host_proof_and_preserves_output(self):
        import os,subprocess,sys
        from unittest.mock import patch
        from kernel_docker import run_resource
        class Creator:
            def create_worker(self,*args):return 'a'*64
        real_popen=subprocess.Popen;observations=[]
        def launch(args,**kwargs):
            self.assertEqual(args,['docker','start','--attach','--interactive','a'*64])
            return real_popen([sys.executable,'-I','-S','-u','-c',
                "import sys;print('[compat-resource] ready',flush=True);assert sys.stdin.readline()=='[compat-resource] approved\\n';print('{\"throttled_periods\":2,\"throttled_usec\":3}')"],**kwargs)
        def audit(*args,**kwargs):
            observations.append((args,kwargs));return {'kernel_network_isolated':True}
        with patch('subprocess.Popen',side_effect=launch),patch('configuration.inspect_worker_configuration',side_effect=audit):
            result=run_resource(Creator(),'worker','owner','sha256:'+'b'*64,'cpu',dict(os.environ),3)
        self.assertEqual(result.returncode,0)
        self.assertEqual(result.stdout,'{"throttled_periods":2,"throttled_usec":3}\n')
        self.assertEqual(len(observations),1)
        self.assertTrue(observations[0][1]['kernel_private'])
        self.assertGreater(observations[0][1]['timeout'],0)
        self.assertLessEqual(observations[0][1]['timeout'],3)

    def test_rejected_audit_never_acknowledges_resource_stress(self):
        import os,subprocess,sys
        from unittest.mock import patch
        from kernel_docker import run_resource
        class Creator:
            def create_worker(self,*args):return 'a'*64
        real_popen=subprocess.Popen;children=[]
        def launch(args,**kwargs):
            child=real_popen([sys.executable,'-I','-S','-u','-c',
                "import sys;print('[compat-resource] ready',flush=True);sys.stdin.readline();print('UNEXPECTED-STRESS',flush=True)"],**kwargs)
            children.append(child);return child
        with patch('subprocess.Popen',side_effect=launch),patch('configuration.inspect_worker_configuration',side_effect=ValueError('rejected')):
            with self.assertRaisesRegex(ValueError,'rejected'):
                run_resource(Creator(),'worker','owner','sha256:'+'b'*64,'cpu',dict(os.environ),3)
        self.assertIsNotNone(children[0].poll())
        self.assertTrue(children[0].stdout.closed)

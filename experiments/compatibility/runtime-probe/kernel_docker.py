"""Fixed-profile Engine API creation for the owned VFS experiment only.

NetworkDisabled retains runc's empty-path NEWNET while avoiding libnetwork's
shared-parent nsfs staging. Metadata alone never proves kernel isolation.
"""
import http.client
import json
import math
import os
from pathlib import Path
import re
import socket
import stat
import time
import threading
from configuration import SAFE_ENVIRONMENT, OWNER_LABEL

VFS_LABEL='fleur.compatibility.vfs-owner'

def worker_request(name, owner, image_id, mode):
    if (type(name) is not str or re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',name) is None
            or type(owner) is not str or re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',owner) is None
            or type(image_id) is not str or re.fullmatch(r'sha256:[0-9a-f]{64}',image_id) is None
            or mode not in ('render','busy','event-replacement','cpu','memory','pids','manager')):
        raise ValueError('fixed VFS worker request rejected')
    request={'Image':image_id,'User':'65534:65534','NetworkDisabled':True,
        'Env':[key+'='+value for key,value in SAFE_ENVIRONMENT.items()],
        'Labels':{OWNER_LABEL:owner},'OpenStdin':True,'StdinOnce':True,
        'AttachStdin':True,'AttachStdout':True,'AttachStderr':True,'Tty':False,
        'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,
          'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges','seccomp=unconfined'],
          'NanoCpus':1000000000,'Memory':536870912,'MemorySwap':536870912,'PidsLimit':64,
          'Ulimits':[{'Name':'core','Soft':0,'Hard':0}], 'RestartPolicy':{'Name':'no'},
          'IpcMode':'private'}}
    if mode in ('cpu','memory','pids'):
        request.update(Entrypoint=['/probe/abuse'],Cmd=[mode,'--host-audit'])
    elif mode=='manager':
        request.update(Entrypoint=['/busy'],Cmd=[],Labels={VFS_LABEL:owner})
    elif mode!='render':request['Cmd']=[mode]
    return request

class EngineRequestUnverified(RuntimeError):
    def __init__(self,phase,reason,observations):
        self.category='vfs-engine-'+phase+'-'+reason
        self.observations=dict(observations)
        super().__init__(self.category)

class _UnixConnection(http.client.HTTPConnection):
    def __init__(self,path,timeout):
        super().__init__('localhost',timeout=timeout);self.path=path;self.deadline_socket=None
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout);self.sock.connect(self.path)
        self.deadline_socket=self.sock.dup()

class KernelPrivateDocker:
    """Bounded typed constructor; never exposes an arbitrary API/command proxy."""
    def __init__(self,environment):
        host=environment.get('DOCKER_HOST','')
        if not host.startswith('unix:///'):
            raise ValueError('owned VFS socket required')
        self.path=Path(host[7:]);self.root=self.path.parent
        self.fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            self.root_identity=self._identity(os.fstat(self.fd))
            if os.fstat(self.fd).st_uid!=os.getuid() or os.fstat(self.fd).st_mode&0o077:
                self.close();raise ValueError('owned VFS root rejected')
            info=os.stat(self.path.name,dir_fd=self.fd,follow_symlinks=False)
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=0 or info.st_gid!=os.getgid():
                self.close();raise ValueError('owned VFS socket rejected')
            self.socket_identity=self._identity(info)
            owner_fd=os.open('owner',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=self.fd)
            try:
                owner_info=os.fstat(owner_fd);owner=os.read(owner_fd,129).decode('ascii')
                if owner_info.st_uid!=os.getuid() or not stat.S_ISREG(owner_info.st_mode) or re.fullmatch(r'fleur-vfs-[0-9a-f]{32}',owner) is None:
                    raise ValueError('owned VFS owner rejected')
            finally:os.close(owner_fd)
            self.owner=owner
            self._verify_identity()
            version=self._request('GET','/version',None,5)
            components=version.get('Components')
            if type(components) is not list or any(type(row) is not dict for row in components):
                raise ValueError('owned VFS pinned engine rejected')
            runtimes=[row for row in components if row.get('Name')=='runc']
            if (version.get('Version')!='28.0.4' or version.get('GitCommit')!='6430e49'
                    or len(runtimes)!=1 or runtimes[0].get('Version')!='1.5.2'
                    or type(runtimes[0].get('Details')) is not dict
                    or runtimes[0].get('Details',{}).get('GitCommit')!='v1.5.2-0-g29dd3dc2'):
                self.close();raise ValueError('owned VFS pinned engine rejected')
            info=self._request('GET','/v1.48/info',None,5)
            labels=info.get('Labels',[])
            if (info.get('Driver')!='vfs' or info.get('DockerRootDir')!=str(self.root/'data')
                    or type(labels) is not list or [v for v in labels if type(v) is str and v.startswith(VFS_LABEL+'=')]!=[VFS_LABEL+'='+self.owner]):
                self.close();raise ValueError('owned VFS engine rejected')
            self._verify_identity()
        except BaseException:
            self.close();raise
    @staticmethod
    def _identity(info):return info.st_dev,info.st_ino,info.st_uid
    def close(self):
        if self.fd is not None:os.close(self.fd);self.fd=None
    def _verify_identity(self):
        if (self.fd is None or self._identity(os.stat(self.root,follow_symlinks=False))!=self.root_identity
                or self._identity(os.stat(self.path.name,dir_fd=self.fd,follow_symlinks=False))!=self.socket_identity):
            raise ValueError('owned VFS endpoint changed')
    def _request(self,method,path,payload,timeout):
        self._verify_identity()
        phase=('create' if method=='POST' else 'inspect' if '/containers/' in path else 'version' if path=='/version' else 'info')
        connection=_UnixConnection(str(self.path),timeout)
        started=time.monotonic();deadline=started+timeout
        expired=threading.Event();raw=b'';status=None
        def failure(reason):
            timed_out=expired.is_set() or time.monotonic()>=deadline
            return EngineRequestUnverified(phase,'deadline' if timed_out else reason,
                {'phase':phase,'timed_out':timed_out,'budget_ms':round(timeout*1000),
                 'duration_ms':round((time.monotonic()-started)*1000),
                 'response_bytes':len(raw),'http_status':status})
        def expire():
            expired.set()
            sock=connection.deadline_socket or connection.sock
            if sock is not None:
                try:sock.shutdown(socket.SHUT_RDWR)
                except OSError:pass
        fence=threading.Timer(timeout,expire);fence.daemon=True;fence.start()
        try:
            connection.request(method,path,body=None if payload is None else json.dumps(payload).encode(),
                               headers={'Content-Type':'application/json'})
            response=connection.getresponse();status=response.status;raw=response.read(65537)
            if len(raw)>65536:raise failure('output-bound')
            if response.status not in (200,201):raise failure('http-status')
            result=json.loads(raw)
            if type(result) is not dict:raise failure('response-shape')
            if expired.is_set() or time.monotonic()>=deadline:raise failure('deadline')
            self._verify_identity();return result
        except (OSError,http.client.HTTPException,UnicodeError,json.JSONDecodeError) as error:
            if isinstance(error,http.client.IncompleteRead) and type(error.partial) is bytes:raw=error.partial[:65537]
            raise failure('transport') from None
        finally:
            fence.cancel();fence.join();connection.close()
            if connection.deadline_socket is not None:connection.deadline_socket.close()
    def create_worker(self,name,owner,image_id,mode,timeout=5):
        if type(timeout) not in (int,float) or not math.isfinite(timeout) or not 0<timeout<=30:
            raise ValueError('fixed VFS create budget rejected')
        request=worker_request(name,owner,image_id,mode)
        deadline=time.monotonic()+timeout
        result=self._request('POST','/v1.48/containers/create?name='+name,request,timeout)
        cid=result.get('Id')
        if type(cid) is not str or re.fullmatch(r'[0-9a-f]{64}',cid) is None:
            raise ValueError('fixed VFS container identity rejected')
        remaining=deadline-time.monotonic()
        if remaining<=0:raise TimeoutError('fixed VFS create deadline')
        metadata=self._request('GET','/v1.48/containers/'+cid+'/json',None,remaining)
        label=VFS_LABEL if mode=='manager' else OWNER_LABEL
        if (type(metadata.get('Config')) is not dict or type(metadata['Config'].get('Labels')) is not dict
                or type(metadata.get('State')) is not dict):
            raise ValueError('fixed VFS stopped identity rejected')
        if (metadata.get('Id')!=cid or metadata.get('Name')!='/'+name or metadata.get('Image')!=image_id
                or metadata.get('Config',{}).get('Labels',{}).get(label)!=owner
                or metadata.get('State',{}).get('Status')!='created'
                or metadata.get('State',{}).get('Running') is not False
                or type(metadata.get('State',{}).get('Pid')) is not int or metadata['State']['Pid']!=0):
            raise ValueError('fixed VFS stopped identity rejected')
        return cid


def run_resource(creator,name,owner,image_id,mode,environment,timeout=15):
    """Audit the stopped-at-gate trusted resource fixture before its original loop."""
    import selectors
    import signal
    import subprocess
    from configuration import inspect_worker_configuration
    deadline=time.monotonic()+timeout
    cid=creator.create_worker(name,owner,image_id,mode,min(5,timeout))
    process=subprocess.Popen(['docker','start','--attach','--interactive',cid],env=environment,
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    output=bytearray();errors=bytearray();approved=False
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout,selectors.EVENT_READ,output)
            selector.register(process.stderr,selectors.EVENT_READ,errors)
            while selector.get_map():
                remaining=deadline-time.monotonic()
                if remaining<=0:raise TimeoutError('VFS resource deadline')
                for key,_ in selector.select(min(remaining,.05)):
                    chunk=os.read(key.fileobj.fileno(),4096)
                    if not chunk:selector.unregister(key.fileobj)
                    else:key.data.extend(chunk)
                    if len(output)>8192 or len(errors)>4096:raise ValueError('VFS resource output bound')
                if not approved and b'\n' in output:
                    line,_,rest=bytes(output).partition(b'\n')
                    if line!=b'[compat-resource] ready' or rest:raise ValueError('VFS resource gate rejected')
                    inspect_worker_configuration(name,owner,image_id,kernel_private=True,timeout=min(5,deadline-time.monotonic()))
                    if time.monotonic()>=deadline:raise TimeoutError('VFS resource audit deadline')
                    process.stdin.write(b'[compat-resource] approved\n');process.stdin.flush();process.stdin.close()
                    output.clear();approved=True
            process.wait(timeout=max(.001,deadline-time.monotonic()))
        if not approved or time.monotonic()>=deadline:raise ValueError('VFS resource gate incomplete')
        return subprocess.CompletedProcess(process.args,process.returncode,output.decode('ascii'),errors.decode('ascii'))
    finally:
        if process.poll() is None:
            os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
        for pipe in (process.stdin,process.stdout,process.stderr):pipe.close()

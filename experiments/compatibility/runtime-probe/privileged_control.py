"""Host-only retained fixture/daemon association; never worker or release authority."""
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import time
from dataclasses import dataclass
from host_control import authorize_host_control
from configuration import read_default_docker_control, ContainerdControlUnverified


def hash_control_file(path, *, deadline, maximum=32*1024**2):
    """Complete advisory provenance hash, bounded by bytes and caller's clock."""
    def budget():
        if type(deadline) not in (int,float) or not math.isfinite(deadline) or time.monotonic()>=deadline:raise ValueError('host control hash deadline expired')
    def identity(value):
        return (value.st_dev,value.st_ino,value.st_uid,value.st_gid,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
    budget();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0<before.st_size<=maximum:raise ValueError('host control binary size bound')
        checksum=hashlib.sha256();count=0
        while True:
            budget();chunk=os.read(fd,min(1024*1024,maximum-count+1))
            if not chunk:break
            count+=len(chunk)
            if count>maximum or count>before.st_size:raise ValueError('host control binary grew')
            checksum.update(chunk)
        budget()
        if count!=before.st_size or identity(os.fstat(fd))!=identity(before) or identity(os.stat(path,follow_symlinks=False))!=identity(before):raise ValueError('host control binary custody changed')
        budget();return checksum.hexdigest()
    finally:os.close(fd)


def daemon_identity(address, ctr, *, deadline):
    """Bounded fixed-host metadata, shared verbatim with isolated root helpers."""
    def budget():
        if time.monotonic()>=deadline:raise ValueError('host daemon identity deadline expired')
    budget()
    def trusted(path, kind, socket=False):
        budget()
        path=Path(path).resolve(strict=True);value=path.stat()
        if value.st_uid!=0 or value.st_mode&(0o002 if socket else 0o022) or not kind(value.st_mode):raise ValueError('host control ownership changed')
        for parent in path.parents:
            budget();info=parent.stat()
            if info.st_uid!=0 or info.st_mode&0o022:raise ValueError('host control ancestor changed')
        return path,value
    def row(value):return [value.st_dev,value.st_ino,value.st_uid,value.st_gid,value.st_mode]
    def bounded(path,limit):
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            data=bytearray()
            while len(data)<=limit:
                budget();chunk=os.read(fd,min(65536,limit-len(data)+1))
                if not chunk:break
                data.extend(chunk)
        finally:os.close(fd)
        if len(data)>limit:raise ValueError('host control metadata bound')
        budget();return bytes(data)
    pidfile,pidinfo=trusted('/var/run/docker.pid',stat.S_ISREG)
    raw=bounded(pidfile,16).strip()
    if not raw.isdigit() or not 1<int(raw)<=2**31-1:raise ValueError('host daemon PID invalid')
    pid=int(raw);proc=Path('/proc')/str(pid)
    if proc.stat().st_uid!=0 or bounded(proc/'comm',32)!=b'dockerd\n':raise ValueError('host daemon identity changed')
    fields=bounded(proc/'stat',4096).rsplit(b') ',1)
    if len(fields)!=2 or len(fields[1].split())<20:raise ValueError('host daemon start identity invalid')
    start=fields[1].split()[19]
    if not start.isdigit():raise ValueError('host daemon start identity invalid')
    command=bounded(proc/'cmdline',65536)
    if type(address) is not str or not address.startswith('/') or ctr!='/usr/bin/ctr':raise ValueError('host endpoint identity invalid')
    arguments=[part.decode('utf-8') for part in command.split(b'\0') if part]
    def option(name):
        values=[]
        for index,arg in enumerate(arguments):
            if arg==name:
                if index+1>=len(arguments):raise ValueError('daemon option missing')
                values.append(arguments[index+1])
            elif arg.startswith(name+'='):values.append(arg[len(name)+1:])
        if len(values)>1:raise ValueError('daemon option duplicated')
        return values[0] if values else None
    config_path=option('--config-file') or '/etc/docker/daemon.json'
    config={};config_identity={'exists':False}
    if Path(config_path).exists():
        config_file,config_info=trusted(config_path,stat.S_ISREG)
        config_bytes=bounded(config_file,65536);config=json.loads(config_bytes)
        if type(config) is not dict:raise ValueError('daemon configuration invalid')
        config_identity={'exists':True,'path':str(config_file),'identity':row(config_info),'sha256':hashlib.sha256(config_bytes).hexdigest()}
    configured=option('--containerd') or config.get('containerd')
    namespace=option('--containerd-namespace') or config.get('containerd-namespace','moby')
    if type(configured) is not str or not configured.startswith('/') or namespace!='moby' or Path(configured).resolve(strict=True)!=Path(address).resolve(strict=True):raise ValueError('daemon configured endpoint changed')
    default,defaultinfo=trusted('/var/run/docker.sock',stat.S_ISSOCK,True)
    endpoint,endpointinfo=trusted(address,stat.S_ISSOCK,True)
    executable,ctrinfo=trusted(ctr,stat.S_ISREG)
    return {'pid':pid,'startTime':start.decode(),'procIdentity':row(proc.stat()),'pidfileIdentity':row(pidinfo),'pidfileSha256':hashlib.sha256(raw).hexdigest(),'commandSha256':hashlib.sha256(command).hexdigest(),'defaultSocket':str(default),'defaultSocketIdentity':row(defaultinfo),'defaultParentIdentity':row(default.parent.stat()),'address':str(endpoint),'endpointIdentity':row(endpointinfo),'endpointParentIdentity':row(endpoint.parent.stat()),'ctr':ctr,'ctrResolved':str(executable),'ctrIdentity':row(ctrinfo),'ctrSize':ctrinfo.st_size,'ctrCtimeNs':ctrinfo.st_ctime_ns,'ctrSha256':hash_control_file(executable,deadline=deadline),'configuration':config_identity}


def verify_root_binding(payload, binding, deadline, ctr=None, address=None, namespace=None):
    """Executed from embedded source, never imports a user-writable module."""
    if ctr is not None and (ctr!=binding['ctr'] or namespace!='moby' or Path(address).resolve(strict=True)!=Path(binding['address']).resolve(strict=True)):raise ValueError('root operation differs from retained daemon')
    remaining=min(10,deadline-time.monotonic())
    millis=math.floor(remaining*1000)
    if millis<=0:raise ValueError('root control deadline expired')
    clipped=json.loads(payload);clipped['deadlineMonotonic']=min(clipped['deadlineMonotonic'],deadline)
    payload=json.dumps(clipped,sort_keys=True,separators=(',',':'),allow_nan=False)
    process=subprocess.run(['/usr/bin/python3','-I','/usr/local/lib/fleur-owned-guest.py','--verify-control',payload,'--budget-seconds',format(millis/1000,'.3f')],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=millis/1000,env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},check=False)
    if process.returncode or len(process.stdout)>4096 or len(process.stderr)>1024:raise ValueError('root fixture custody refused')
    def unique(pairs):
        value={}
        for key,item in pairs:
            if key in value:raise ValueError('duplicate root validation field')
            value[key]=item
        return value
    expected=json.loads(payload);value=json.loads(process.stdout,object_pairs_hook=unique)
    required={**expected,'scope':'owned-guest-root-control-validation','ok':True,'fixtureCustodyValidated':True,'rootValidation':True,'runtimeSupport':'unverified','runtimeAdmission':False,'humanConsentProof':False,'nativeCpuPerformanceProof':False}
    if (type(value) is not dict or value!=required or type(value.get('formatVersion')) is not int or type(value.get('uid')) is not int or any(type(value.get(key)) is not bool for key in ('ok','fixtureCustodyValidated','rootValidation','runtimeAdmission','humanConsentProof','nativeCpuPerformanceProof'))):raise ValueError('root fixture validation invalid')
    if time.monotonic()>=deadline or daemon_identity(binding['address'],binding['ctr'],deadline=deadline)!=binding['identity']:raise ValueError('root daemon binding changed')
    # Reuse the deadline-fenced fixed Engine API transport, including trickle protection.
    left=deadline-time.monotonic()
    if left<=0:raise ValueError('root control deadline expired')
    info,_,_=read_default_docker_control(binding['identity']['defaultSocket'],timeout=min(15,left))
    if info.get('ID')!=binding['engineId']:raise ValueError('root daemon association changed')
    if time.monotonic()>=deadline:raise ValueError('root control deadline expired')


def exec_root_version(arguments, deadline):
    remaining=math.floor((deadline-time.monotonic())*1000)/1000
    if remaining<=1:raise ValueError('root version budget expired')
    environment={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS':'true'}
    os.execve('/usr/bin/timeout',['/usr/bin/timeout','--signal=TERM','--kill-after=0.2s',str(remaining-1)+'s',*arguments],environment)


ROOT_BINDING_SOURCE=('import hashlib,json,math,os,stat,subprocess,time\nfrom pathlib import Path\n'+inspect.getsource(ContainerdControlUnverified)+'\n'+inspect.getsource(read_default_docker_control)+'\n'+inspect.getsource(hash_control_file)+'\n'+inspect.getsource(daemon_identity)+'\n'+inspect.getsource(verify_root_binding)+'\n'+inspect.getsource(exec_root_version)+'\n')


@dataclass(frozen=True,init=False)
class HostDaemonBinding:
    context: object
    _identity_json: str
    engine_id: str

    def __init__(self, context, identity, engine_id):
        if type(identity) is not dict or type(engine_id) is not str or not 0<len(engine_id)<=256:raise ValueError('retained daemon binding invalid')
        object.__setattr__(self,'context',context)
        object.__setattr__(self,'_identity_json',json.dumps(identity,sort_keys=True,separators=(',',':'),allow_nan=False))
        object.__setattr__(self,'engine_id',engine_id)

    @property
    def identity(self):
        return json.loads(self._identity_json)

    def verify(self, remaining):
        if type(remaining) not in (int,float) or not math.isfinite(remaining) or remaining<=0:raise ValueError('host control remaining budget required')
        deadline=time.monotonic()+remaining
        authorize_host_control(self.context,remaining=remaining)
        if daemon_identity(self.identity['address'],self.identity['ctr'],deadline=deadline)!=self.identity:raise ValueError('host daemon binding changed')
        from configuration import read_default_docker_control
        left=deadline-time.monotonic()
        if left<=0:raise ValueError('host control deadline expired')
        info,_,_=read_default_docker_control(self.identity['defaultSocket'],timeout=min(15,left))
        if info.get('ID')!=self.engine_id:raise ValueError('default daemon association changed')
        left=deadline-time.monotonic()
        if left<=0:raise ValueError('host control deadline expired')
        active=subprocess.run(['docker','info','--format','{{.ID}}'],stdin=subprocess.DEVNULL,capture_output=True,timeout=left,check=False)
        if active.returncode or len(active.stdout)>4096 or len(active.stderr)>4096 or active.stdout!=(self.engine_id+'\n').encode():raise ValueError('ambient daemon association changed')
        if time.monotonic()>=deadline or daemon_identity(self.identity['address'],self.identity['ctr'],deadline=deadline)!=self.identity:raise ValueError('host control changed during validation')

    def verify_operation(self, ctr, address, namespace, remaining):
        started=time.monotonic()
        authorize_host_control(self.context,remaining=remaining)
        remaining-=time.monotonic()-started
        if remaining<=0:raise ValueError('host control deadline expired')
        if (ctr!=self.identity['ctr'] or namespace!='moby' or Path(address).resolve(strict=True)!=Path(self.identity['address']).resolve(strict=True)):
            raise ValueError('operation differs from retained daemon binding')
        self.verify(remaining)

    def root_arguments(self, deadline):
        return [self.context.root_payload(deadline=deadline),json.dumps({'address':self.identity['address'],'ctr':self.identity['ctr'],'identity':self.identity,'engineId':self.engine_id},sort_keys=True,separators=(',',':'))]

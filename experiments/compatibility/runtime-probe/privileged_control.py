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


def daemon_identity(address, ctr):
    """Bounded fixed-host metadata, shared verbatim with isolated root helpers."""
    def trusted(path, kind, socket=False):
        path=Path(path).resolve(strict=True);value=path.stat()
        if value.st_uid!=0 or value.st_mode&(0o002 if socket else 0o022) or not kind(value.st_mode):raise ValueError('host control ownership changed')
        for parent in path.parents:
            info=parent.stat()
            if info.st_uid!=0 or info.st_mode&0o022:raise ValueError('host control ancestor changed')
        return path,value
    def row(value):return [value.st_dev,value.st_ino,value.st_uid,value.st_gid,value.st_mode]
    def bounded(path,limit):
        with open(path,'rb') as stream:data=stream.read(limit+1)
        if len(data)>limit:raise ValueError('host control metadata bound')
        return data
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
    default,defaultinfo=trusted('/var/run/docker.sock',stat.S_ISSOCK,True)
    endpoint,endpointinfo=trusted(address,stat.S_ISSOCK,True)
    executable,ctrinfo=trusted(ctr,stat.S_ISREG)
    return {'pid':pid,'startTime':start.decode(),'procIdentity':row(proc.stat()),'pidfileIdentity':row(pidinfo),'pidfileSha256':hashlib.sha256(raw).hexdigest(),'commandSha256':hashlib.sha256(command).hexdigest(),'defaultSocket':str(default),'defaultSocketIdentity':row(defaultinfo),'defaultParentIdentity':row(default.parent.stat()),'address':str(endpoint),'endpointIdentity':row(endpointinfo),'endpointParentIdentity':row(endpoint.parent.stat()),'ctr':ctr,'ctrResolved':str(executable),'ctrIdentity':row(ctrinfo)}


def verify_root_binding(payload, binding, deadline):
    """Executed from embedded source, never imports a user-writable module."""
    remaining=min(10,deadline-time.monotonic())
    millis=math.floor(remaining*1000)
    if millis<=0:raise ValueError('root control deadline expired')
    process=subprocess.run(['/usr/bin/python3','-I','/usr/local/lib/fleur-owned-guest.py','--verify-control',payload,'--budget-seconds',format(millis/1000,'.3f')],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=millis/1000,env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},check=False)
    if process.returncode or len(process.stdout)>4096 or len(process.stderr)>1024:raise ValueError('root fixture custody refused')
    expected=json.loads(payload);value=json.loads(process.stdout)
    if type(value) is not dict or value.get('rootValidation') is not True or value.get('scope')!='owned-guest-root-control-validation' or value.get('nonce')!=expected['nonce'] or value.get('bootId')!=expected['bootId'] or value.get('uid')!=expected['uid']:raise ValueError('root fixture validation invalid')
    if time.monotonic()>=deadline or daemon_identity(binding['address'],binding['ctr'])!=binding['identity']:raise ValueError('root daemon binding changed')
    # Reuse the deadline-fenced fixed Engine API transport, including trickle protection.
    left=deadline-time.monotonic()
    if left<=0:raise ValueError('root control deadline expired')
    info,_,_=read_default_docker_control(binding['identity']['defaultSocket'],timeout=min(15,left))
    if info.get('ID')!=binding['engineId']:raise ValueError('root daemon association changed')
    if time.monotonic()>=deadline:raise ValueError('root control deadline expired')


ROOT_BINDING_SOURCE=('import hashlib,json,math,os,stat,subprocess,time\nfrom pathlib import Path\n'+inspect.getsource(ContainerdControlUnverified)+'\n'+inspect.getsource(read_default_docker_control)+'\n'+inspect.getsource(daemon_identity)+'\n'+inspect.getsource(verify_root_binding)+'\n')


@dataclass(frozen=True)
class HostDaemonBinding:
    context: object
    identity: dict
    engine_id: str

    def verify(self, remaining):
        if type(remaining) not in (int,float) or not math.isfinite(remaining) or remaining<=0:raise ValueError('host control remaining budget required')
        deadline=time.monotonic()+remaining
        authorize_host_control(self.context,remaining=remaining)
        if daemon_identity(self.identity['address'],self.identity['ctr'])!=self.identity:raise ValueError('host daemon binding changed')
        from configuration import read_default_docker_control
        left=deadline-time.monotonic()
        if left<=0:raise ValueError('host control deadline expired')
        info,_,_=read_default_docker_control(self.identity['defaultSocket'],timeout=left)
        if info.get('ID')!=self.engine_id:raise ValueError('default daemon association changed')
        left=deadline-time.monotonic()
        if left<=0:raise ValueError('host control deadline expired')
        active=subprocess.run(['docker','info','--format','{{.ID}}'],stdin=subprocess.DEVNULL,capture_output=True,timeout=left,check=False)
        if active.returncode or len(active.stdout)>4096 or len(active.stderr)>4096 or active.stdout!=(self.engine_id+'\n').encode():raise ValueError('ambient daemon association changed')
        if time.monotonic()>=deadline or daemon_identity(self.identity['address'],self.identity['ctr'])!=self.identity:raise ValueError('host control changed during validation')

    def root_arguments(self):
        return [self.context.root_payload(),json.dumps({'address':self.identity['address'],'ctr':self.identity['ctr'],'identity':self.identity,'engineId':self.engine_id},sort_keys=True,separators=(',',':'))]

#!/usr/bin/env python3
"""Native Intel Desktop candidate evidence, with independent guardian custody."""
import argparse
import copy
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import uuid

ROOT=Path(__file__).resolve().parent.parent
DIRECTORY=ROOT/'experiments/compatibility/desktop-runtime'
SOCKET='/var/run/docker.sock'
OWNER='dev.fleur.desktop-runtime-owner'
ROLE='dev.fleur.desktop-runtime-role'
SHA=r'[a-f0-9]{64}'
UUID=r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'


def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec)
    sys.modules[name]=value;spec.loader.exec_module(value);return value

processes=module('desktop_outer_processes',DIRECTORY/'processes.py')
entry=module('desktop_outer_entry',DIRECTORY/'entry.py')
artifacts=module('desktop_outer_artifacts',DIRECTORY/'artifact_inputs.py')
sys.path.insert(0,str(ROOT/'experiments/compatibility/runtime-probe'))


def native_intel_identity(system,machine,cpu):return system=='Darwin' and machine=='x86_64' and cpu=='7\n'


def sha(value):return hashlib.sha256(value.encode() if type(value) is str else value).hexdigest()


def error_category(error):
    known={'inventory deadline':'HOST_INVENTORY_DEADLINE','inventory exit':'HOST_INVENTORY_EXIT','inventory size':'HOST_INVENTORY_OUTPUT_BOUND','inventory schema':'HOST_INVENTORY_SCHEMA','inventory identity':'HOST_INVENTORY_IDENTITY','inventory owned state':'HOST_INVENTORY_OWNED_STATE','leader absent':'HOST_RETAINED_LEADER_ABSENT','leader group':'HOST_RETAINED_LEADER_GROUP','waitid child differs':'HOST_WAITID_CHILD_CHANGED','waitid ABI response':'HOST_WAITID_ABI_RESPONSE'}
    message=str(error)
    if type(error) is RuntimeError and message in known:return known[message]
    return message if type(error) is RuntimeError and re.fullmatch('[A-Z_]{1,80}',message) else 'DESKTOP_OBSERVATION_FAILED'


def matches_image(value,identity):
    try:
        return (value['Id']==identity.manifest_image_id and value['Architecture']=='amd64' and value['Os']=='linux'
            and value['Config']==identity.configuration['config'] and value['RootFS']=={'Type':'layers','Layers':identity.configuration['rootfs']['diff_ids']}
            and value['Descriptor']=={'digest':identity.manifest_image_id,'mediaType':'application/vnd.oci.image.manifest.v1+json','size':identity.manifest_bytes})
    except (KeyError,TypeError,AttributeError):return False


def role_profile(value, *, cid,name,image,nonce,binding,mode,program=None,control_environment=(),base_environment=()):
    try:
        guardian=mode=='--guardian';role='guardian' if guardian else 'loss-manager' if program is not None else 'manager'
        if type(nonce) is not str or not re.fullmatch(UUID,nonce) or name!='fleur-desktop-'+role+'-'+nonce or not re.fullmatch(SHA,cid) or not re.fullmatch('sha256:'+SHA,image):return False
        if mode not in ('--guardian','--capabilities','--qualify','--guardian-loss'):return False
        config=value['Config'];host=value['HostConfig'];state=value['State']
        capabilities=lambda key:sorted(x.removeprefix('CAP_') for x in host[key])
        security=sorted('no-new-privileges' if x=='no-new-privileges:true' else x for x in host['SecurityOpt'])
        caps=['KILL','SYS_PTRACE'] if guardian else ['KILL','SETGID','SETUID','SYS_PTRACE']
        memory=268435456 if guardian else 2147483648
        tmpfs={'/tmp':'rw,nosuid,nodev,noexec,size='+('16777216' if guardian else '536870912')+',mode=1777'}
        mounts=value['Mounts'];binds=host.get('Binds')
        if guardian:
            if mounts!=[] or binds not in (None,[]):return False
        elif len(mounts)!=1 or mounts[0].get('Type')!='bind' or mounts[0].get('Source')!=SOCKET or mounts[0].get('Destination')!=SOCKET or mounts[0].get('RW') is not True or binds!=[SOCKET+':'+SOCKET+':rw']:return False
        command=['-I','-u','-c',program] if program is not None else ['-I','-u','/controller/entry.py',mode]
        return (value['Id']==cid and value['Name']=='/'+name and value['Image']==image and config['Image']==image
            and config['Labels'].get(OWNER)==nonce and config['Labels'].get(ROLE)==role and config['User']=='0:0'
            and config['Entrypoint']==['/usr/bin/python3'] and config['Cmd']==command and config.get('Volumes') in (None,{}) and config.get('OpenStdin') is True and config.get('Tty') is False
            and sorted(config['Env'])==sorted([*base_environment,'FLEUR_DESKTOP_BINDING='+binding,*control_environment])
            and host['Privileged'] is False and host['ReadonlyRootfs'] is True and host['NetworkMode']=='none'
            and host['PidMode']=='host' and host['CgroupnsMode']=='host' and capabilities('CapDrop')==['ALL'] and capabilities('CapAdd')==caps
            and security in (['no-new-privileges','seccomp=unconfined'],['label=disable','no-new-privileges','seccomp=unconfined'])
            and host['Memory']==memory and host['MemorySwap']==memory and host['NanoCpus']==(1000000000 if guardian else 2000000000) and host['PidsLimit']==(64 if guardian else 256)
            and host['Tmpfs']==tmpfs and all(host.get(key) in (None,[]) for key in ('Mounts','Devices','DeviceRequests','VolumesFrom'))
            and type(state['Running']) is bool and type(state['Pid']) is int and 0<=state['Pid']<2**31)
    except (KeyError,TypeError,AttributeError):return False


# Compatibility name for the initial policy fixtures, never a separate policy.
manager_profile=role_profile


class Channel:
    """Keep CLI leader identity until all bounded streams and its PGID retire."""
    def __init__(self,args, *, environment=None,input_fd=None):
        self.child=subprocess.Popen(args,stdin=subprocess.PIPE if input_fd is None else input_fd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env=environment,cwd=ROOT)
        self.selector=selectors.DefaultSelector();self.pending=bytearray();self.errors=bytearray();self.total=0;self.input_fd=input_fd
        self.selector.register(self.child.stdout,selectors.EVENT_READ,'out');self.selector.register(self.child.stderr,selectors.EVENT_READ,'err')
    def pump(self,until):
        if time.monotonic()>=until:raise RuntimeError('CHANNEL_DEADLINE_EXPIRED')
        for key,_ in self.selector.select(min(.05,max(0,until-time.monotonic()))):
            block=os.read(key.fd,8192)
            if not block:self.selector.unregister(key.fileobj)
            else:
                self.total+=len(block)
                if self.total>2097152:raise RuntimeError('CHANNEL_OUTPUT_BOUND')
                (self.pending if key.data=='out' else self.errors).extend(block)
                if len(self.errors)>65536:raise RuntimeError('CHANNEL_ERROR_BOUND')
    def frame(self,until):
        if time.monotonic()>=until:raise RuntimeError('CHANNEL_DEADLINE_EXPIRED')
        while b'\n' not in self.pending:
            self.pump(until)
            if not self.selector.get_map():raise RuntimeError('CHANNEL_EOF_WITHOUT_FRAME')
        line,_,rest=self.pending.partition(b'\n');self.pending=bytearray(rest)
        if len(line)>1048576 or self.errors:raise RuntimeError('CHANNEL_FRAME_UNCONFIRMED')
        parsed=artifacts.canonical_json(line)
        if time.monotonic()>=until:raise RuntimeError('CHANNEL_DEADLINE_EXPIRED')
        return parsed
    def acknowledge(self,nonce,phase):
        data=(json.dumps({'kind':'ack','phase':phase,'nonce':nonce},separators=(',',':'))+'\n').encode()
        self.child.stdin.write(data);self.child.stdin.flush()
    def drain(self,until):
        while self.selector.get_map():self.pump(until)
        while processes.exited(self.child) is None:
            if time.monotonic()>=until:raise RuntimeError('CHANNEL_EXIT_UNCONFIRMED')
            time.sleep(.01)
        if time.monotonic()>=until:raise RuntimeError('CHANNEL_DEADLINE_EXPIRED')
        return bytes(self.pending),bytes(self.errors)
    def close(self,until=None):
        end=min(time.monotonic()+5,until) if until is not None else time.monotonic()+5
        try:
            if self.input_fd is None and self.child.stdin is not None and not self.child.stdin.closed:self.child.stdin.close()
            if processes.exited(self.child) is None or processes.inventory(self.child.pid)>0:
                try:os.killpg(self.child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
            while processes.exited(self.child) is None or processes.inventory(self.child.pid)>0:
                if time.monotonic()>=end:raise RuntimeError('CHANNEL_RETIREMENT_UNCONFIRMED')
                time.sleep(.01)
            self.child.wait(timeout=max(.01,end-time.monotonic()))
            if time.monotonic()>=end:raise RuntimeError('CHANNEL_RETIREMENT_DEADLINE_EXPIRED')
        finally:self.selector.close();self.child.stdout.close();self.child.stderr.close()


def journal_program():
    return '''import json,os,re,stat
def unique(rows):
 value=dict(rows)
 if len(value)!=len(rows):raise ValueError('duplicate journal field')
 return value
result={}
for name in os.listdir('/tmp'):
 if not re.fullmatch(r'guard-[a-f0-9]{64}\\.jsonl',name):raise ValueError('foreign journal')
 fd=os.open('/tmp/'+name,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_nlink!=1 or before.st_mode&0o7777!=0o600 or before.st_size>8192:raise ValueError('journal custody')
  data=os.read(fd,8193)
  identity=lambda x:(x.st_dev,x.st_ino,x.st_mode,x.st_uid,x.st_nlink,x.st_size,x.st_mtime_ns,x.st_ctime_ns)
  if len(data)!=before.st_size or not data.endswith(b'\\n') or identity(os.fstat(fd))!=identity(before):raise ValueError('journal drift')
  result[name[6:-6]]=[json.loads(line,object_pairs_hook=unique) for line in data.splitlines()]
 finally:os.close(fd)
 if len(result)>8:raise ValueError('journal count')
print(json.dumps(result,separators=(',',':')))
'''


LOSS_PROGRAM='''import hashlib,json,os,re,sys,time
from pathlib import Path
sys.path.insert(0,'/controller');sys.path.insert(0,'/controller/runtime-probe')
import entry
from worker_deadline import HostDeadlineGuard,ROOT_GUARD
raw=os.environ['FLEUR_DESKTOP_BINDING'];binding=json.loads(raw)
assert entry.valid_binding(binding) and binding['bootId']==Path('/proc/sys/kernel/random/boot_id').read_text().strip()
match=re.fullmatch(r'0::/(?:docker/([a-f0-9]{64})|system.slice/docker-([a-f0-9]{64})\\.scope)\\n',Path('/proc/self/cgroup').read_text());assert match
cid=match[1] or match[2]
entry.emit({'kind':'ready','role':'loss-manager','nonce':binding['nonce'],'bootId':binding['bootId'],'managerId':cid,'managerPid':os.getpid(),'vmMonotonicNs':str(time.monotonic_ns()),'sourceCommit':binding['sourceCommit'],'sources':binding['sources'],'bindingSha256':hashlib.sha256(raw.encode()).hexdigest()})
entry.acknowledge(binding,'ready')
worker=os.environ['FLEUR_CONTROL_WORKER'];pid=int(os.environ['FLEUR_CONTROL_PID']);end=time.monotonic()+30
control=HostDeadlineGuard(worker,pid,end,launcher=entry.guardian_launcher(binding['guardianId'],ROOT_GUARD))
entry.emit({'kind':'loss-armed','nonce':binding['nonce'],'workerId':worker,'workerPid':pid,'deadlineVmMonotonic':end})
time.sleep(60)
'''


def valid_journals(journals,nonce,boot_id,expected_results=None,control_cid=None,expected_bindings=None):
    from worker_deadline import ROOT_GUARD
    try:
        if type(journals) is not dict or len(journals)!=(1 if control_cid else 4):return False
        results=[]
        for cid,rows in journals.items():
            if not re.fullmatch(SHA,cid) or (control_cid is not None and cid!=control_cid) or type(rows) is not list or len(rows)!=4:return False
            binding,armed,result,retired=rows
            if set(binding)!={'kind','nonce','bootId','containerId','pid','deadlineVmMonotonic','rootGuardSha256'} or binding['kind']!='binding' or binding['nonce']!=nonce or binding['bootId']!=boot_id or binding['containerId']!=cid or type(binding['pid']) is not int or not 1<binding['pid']<2**31 or binding['rootGuardSha256']!=sha(ROOT_GUARD) or type(binding['deadlineVmMonotonic']) not in (int,float) or not math.isfinite(binding['deadlineVmMonotonic']) or binding['deadlineVmMonotonic']<=0:return False
            if armed!={'kind':'record','record':{'kind':'armed'}} or set(result)!={'kind','record'} or result['kind']!='record' or retired!={'kind':'retired','exitCode':0,'records':2} or type(retired['exitCode']) is not int or type(retired['records']) is not int:return False
            proof=result['record']
            if set(proof)!={'kind','outcome','physical_exit_confirmed','kill_lateness_ms','physical_exit_lateness_ms'} or proof['kind']!='result' or proof['outcome'] not in (('cancelled','deadline') if control_cid else ('deadline',)) or proof['physical_exit_confirmed'] is not True or any(type(proof[key]) is not int or not 0<=proof[key]<=250 for key in ('kill_lateness_ms','physical_exit_lateness_ms')):return False
            results.append(json.dumps(proof,sort_keys=True))
        if expected_bindings is not None:
            if set(journals)!=set(expected_bindings):return False
            for cid,rows in journals.items():
                bound=expected_bindings[cid]
                if any(rows[0][key]!=bound[key] or type(rows[0][key]) is not type(bound[key]) for key in ('containerId','pid','deadlineVmMonotonic')):return False
        return expected_results is None or sorted(results)==sorted(json.dumps(value,sort_keys=True) for value in expected_results)
    except (KeyError,TypeError,AttributeError):return False


CONTROL_PROGRAM='setTimeout(()=>{},60000);'

def control_worker_profile(value,row,image):
    try:
        if value['Config']['Entrypoint']!=['bun'] or value['Config']['Cmd']!=['-e',CONTROL_PROGRAM]:return False
        normalized=copy.deepcopy(value);normalized['Config']['Entrypoint']=['bun','/probe/bootstrap.js'];normalized['Config']['Cmd']=[]
        return entry.worker_profile(normalized,row['name'],image,row['owner'])
    except (KeyError,TypeError):return False

def ready_frame(value,binding,raw,cid,pid,role):
    expected={'kind','role','nonce','bootId','managerId','managerPid','vmMonotonicNs','sourceCommit','sources','bindingSha256'}
    return (type(value) is dict and set(value)==expected and value['kind']=='ready' and value['role']==role
        and value['nonce']==binding['nonce'] and value['bootId']==binding['bootId'] and value['managerId']==cid
        and type(value['managerPid']) is int and value['managerPid']==pid and pid>1
        and type(value['vmMonotonicNs']) is str and re.fullmatch('[1-9][0-9]{0,23}',value['vmMonotonicNs']) is not None
        and value['sourceCommit']==binding['sourceCommit'] and value['sources']==binding['sources'] and value['bindingSha256']==sha(raw))


def observe(mode,images_directory):
    report={'formatVersion':1,'scope':'native-intel-desktop-runtime-qualification','mode':mode,'ok':False,'runtimeAdmission':False,'nativeQualification':False,'installationVerified':False,'cleanup':[]}
    end=time.monotonic()+600;work_end=end-90;endpoint=None;original=None;owned=[];workers=[];imported=[];channels=[];held=None;guardian=None;ledger_dir=None;phase='native-identity'
    environment={key:value for key,value in os.environ.items() if key not in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_API_VERSION')}
    def raw(args,cleanup=False,timeout=6,extra_environment=None):
        budget=min(timeout,(end if cleanup else work_end)-time.monotonic())
        if budget<=1:raise RuntimeError('ORIGINAL_DEADLINE_EXPIRED')
        return processes.bounded(args,timeout=budget,env={**environment,**(extra_environment or {})},cwd=ROOT)
    def command(args,cleanup=False,timeout=6):
        result=raw(args,cleanup,timeout)
        if result.returncode or result.stderr:raise RuntimeError('FIXED_COMMAND_FAILED')
        return result.stdout.decode()
    def docker(args,cleanup=False,timeout=6):return command(['docker','--host',endpoint,*args],cleanup,timeout)
    def inspect(target,kind='container',cleanup=False):
        result=raw(['docker','--host',endpoint,'inspect','--type',kind,target,'--format','{{json .}}'],cleanup)
        if not result.returncode and not result.stderr:
            value=artifacts.canonical_json(result.stdout)
            if type(value) is not dict:raise RuntimeError('INSPECTION_SHAPE_UNKNOWN')
            return value
        if result.returncode==1 and result.stdout in (b'',b'\n') and result.stderr in tuple(x.encode() for x in ('Error: No such object: '+target+'\n','error: no such object: '+target+'\n','Error response from daemon: No such '+kind+': '+target+'\n')):return None
        raise RuntimeError('INSPECTION_OUTCOME_UNKNOWN')
    def inventory(cleanup=False):
        container_ids=sorted(docker(['ps','--all','--quiet','--no-trunc'],cleanup).splitlines());image_ids=sorted(set(docker(['image','ls','--all','--quiet','--no-trunc'],cleanup).splitlines()))
        containers={};images={}
        for cid in container_ids:
            value=inspect(cid,cleanup=cleanup)
            if value is None:raise RuntimeError('ORIGINAL_CONTAINER_INVENTORY_CHANGED')
            state=value['State']
            containers[cid]={'Id':value['Id'],'Name':value['Name'],'Image':value['Image'],'Config':value['Config'],'HostConfig':value['HostConfig'],'Mounts':value['Mounts'],'RestartCount':value['RestartCount'],'State':{key:state[key] for key in ('Running','Paused','Restarting','OOMKilled','Dead','Pid','ExitCode','StartedAt','FinishedAt')}}
        for image in image_ids:
            value=inspect(image,'image',cleanup)
            if value is None:raise RuntimeError('ORIGINAL_IMAGE_INVENTORY_CHANGED')
            images[image]={key:value.get(key) for key in ('Id','RepoTags','RepoDigests','Config','Architecture','Os','RootFS')}
        return {'context':command(['docker','context','show'],cleanup),'daemon':docker(['info','--format','{{json .ID}}|{{json .ServerVersion}}|{{json .KernelVersion}}|{{json .Architecture}}|{{json .CgroupDriver}}|{{json .CgroupVersion}}'],cleanup),
            'containers':json.dumps(containers,sort_keys=True,separators=(',',':')),'images':json.dumps(images,sort_keys=True,separators=(',',':'))}
    def persist(label,value):
        nonlocal ledger_dir
        if ledger_dir is None:ledger_dir=tempfile.TemporaryDirectory(prefix='fleur-desktop-custody-')
        path=Path(ledger_dir.name)/label;fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            data=(json.dumps(value,sort_keys=True)+'\n').encode()
            if os.write(fd,data)!=len(data):raise RuntimeError('LEDGER_WRITE_FAILED')
            os.fsync(fd)
        finally:os.close(fd)
        parent=os.open(ledger_dir.name,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(parent)
        finally:os.close(parent)
        report.setdefault('custodyLedgerSha256',{})[label]=sha(data)
    def start_role(role,binding,image,base_env,program=None,controls=()):
        guardian_role=role=='guardian';name='fleur-desktop-'+role+'-'+binding['nonce'];raw_binding=json.dumps(binding,separators=(',',':'))
        if inspect(name) is not None:raise RuntimeError('FRESH_NAME_UNAVAILABLE')
        selected='--guardian' if guardian_role else mode if program is None else '--guardian-loss'
        expected={'cid':None,'name':name,'image':image,'nonce':binding['nonce'],'binding':raw_binding,'mode':selected,'program':program,'control_environment':controls,'base_environment':base_env}
        owned.append(expected);persist(role+'-planned.json',{'name':name,'image':image,'binding':binding,'role':role})
        memory='268435456' if guardian_role else '2147483648';tmp_size='16777216' if guardian_role else '536870912'
        args=['create','--interactive','--name',name,'--label',OWNER+'='+binding['nonce'],'--label',ROLE+'='+role,'--pull','never','--platform','linux/amd64','--entrypoint','/usr/bin/python3','--init=false','--user','0:0','--network','none','--read-only','--pid','host','--cgroupns','host','--cap-drop','ALL','--cap-add','KILL','--cap-add','SYS_PTRACE']
        if not guardian_role:args+=['--cap-add','SETUID','--cap-add','SETGID','--volume',SOCKET+':'+SOCKET+':rw']
        args+=['--security-opt','no-new-privileges:true','--security-opt','seccomp=unconfined','--memory',memory,'--memory-swap',memory,'--cpus','1' if guardian_role else '2','--pids-limit','64' if guardian_role else '256','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size='+tmp_size+',mode=1777','--env','FLEUR_DESKTOP_BINDING='+raw_binding]
        for item in controls:args+=['--env',item]
        args+=[image,'-I','-u']+(['-c',program] if program is not None else ['/controller/entry.py',selected])
        cid=docker(args).strip()
        if not re.fullmatch(SHA,cid):raise RuntimeError('CREATION_IDENTITY_UNKNOWN')
        expected['cid']=cid;value=inspect(cid)
        if not role_profile(value,**expected) or value['State']['Running'] is not False:raise RuntimeError('CREATED_ROLE_PROFILE_CHANGED')
        channel=Channel(['docker','--host',endpoint,'start','--attach','--interactive',cid],environment=environment);channels.append(channel)
        frame=channel.frame(min(work_end,time.monotonic()+15));value=inspect(cid)
        if not role_profile(value,**expected) or value['State']['Running'] is not True or not ready_frame(frame,binding,raw_binding,cid,value['State']['Pid'],role):raise RuntimeError('ROLE_READY_BINDING_UNPROVEN')
        persist(role+'-ready.json',frame);channel.acknowledge(binding['nonce'],'ready')
        return expected,channel,frame
    def retire_role(expected):
        value=inspect(expected['cid'] or expected['name'],cleanup=True)
        if value is not None:
            adopted={**expected,'cid':expected['cid'] or value['Id']}
            if not role_profile(value,**adopted):raise RuntimeError('ROLE_CLEANUP_OWNERSHIP_UNPROVEN')
            docker(['rm','--force',adopted['cid']],True)
            if inspect(adopted['cid'],cleanup=True) is not None:raise RuntimeError('ROLE_REMOVAL_UNCONFIRMED')
    try:
        if os.environ.get('FLEUR_DESKTOP_RUNTIME_QUALIFICATION')!='yes' or not native_intel_identity(platform.system(),platform.machine(),command(['/usr/sbin/sysctl','-n','hw.cputype'])):raise RuntimeError('EXPLICIT_NATIVE_INTEL_MAC_REQUIRED')
        commit=command(['git','rev-parse','HEAD']).strip()
        if not re.fullmatch('[a-f0-9]{40}',commit) or command(['git','diff','--exit-code','HEAD']):raise RuntimeError('CLEAN_COMMITTED_SOURCE_REQUIRED')
        phase='operator-source'
        operator_files=['scripts/observe-desktop-runtime.py',*['experiments/compatibility/desktop-runtime/'+name for name in ('artifact_inputs.py','oci_inputs.py','entry.py','processes.py','image-origin.json')]]
        operator_hashes={}
        for relative in operator_files:
            body=(ROOT/relative).read_bytes()
            if sha(command(['git','show',commit+':'+relative],timeout=8))!=sha(body):raise RuntimeError('OPERATOR_SOURCE_BYTES_CHANGED')
            operator_hashes[relative]=sha(body)
        report['operatorSource']={'commit':commit,'files':operator_hashes}
        phase='fresh-control-preflight'
        preflight=raw([str(Path.home()/'.bun/bin/bun'),'scripts/observe-desktop-control.ts','--run'],timeout=95,extra_environment={'FLEUR_DESKTOP_CONTROL_PREFLIGHT':'yes'})
        # Explicitly pass the preflight flag only to this fixed command.
        if preflight.returncode:raise RuntimeError('FRESH_CONTROL_PREFLIGHT_REQUIRED')
        proof=artifacts.canonical_json(preflight.stdout)
        if proof.get('ok') is not True or proof.get('controlCapabilityVerified') is not True or proof.get('originalPreserved') is not True or proof.get('transportUncertain') is not False:raise RuntimeError('FRESH_CONTROL_PREFLIGHT_REQUIRED')
        report['controlPreflight']=proof
        context=command(['docker','context','show']).strip();resolved=artifacts.canonical_json(command(['docker','context','inspect',context,'--format','{{json .Endpoints.docker}}']))
        endpoint=os.environ.get('DOCKER_HOST') if os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT') else resolved['Host']
        if not re.fullmatch(r'unix:///[A-Za-z0-9/_.-]{1,4000}',endpoint) or sha(endpoint)!=proof['endpointSha256']:raise RuntimeError('LOCAL_ENDPOINT_CHANGED')
        phase='original-inventory'
        original=inventory();report['original']={key:sha(value) for key,value in original.items()}
        version=artifacts.canonical_json(docker(['version','--format','{{json .Server}}']))
        if version!=proof['server']:raise RuntimeError('EXACT_DESKTOP_TUPLE_CHANGED')
        daemon=artifacts.canonical_json(docker(['info','--format','{{json .ID}}']));boot=proof['probe']['bootId'];nonce=str(uuid.uuid4())
        catalog=artifacts.canonical_json((DIRECTORY/'image-origin.json').read_bytes())
        phase='source-artifact-custody'
        held=artifacts.open_artifacts(images_directory,catalog,absolute_deadline=work_end)
        source=held.read_json('source-manifest.json');prep=held.read_json('runtime-preparation.json')
        origin=catalog['origin']
        if source.get('sourceCommit')!=origin['sourceCommit'] or prep.get('sourceCommit')!=origin['sourceCommit'] or prep.get('scope')!='prepared-native-runtime-image' or prep.get('runtimeAdmission') is not False or prep.get('nativeQualification') is not False or prep.get('preparationReport',{}).get('cleanup_complete') is not True:raise RuntimeError('PREPARATION_PROVENANCE_CHANGED')
        phase='payload-source-closure'
        for name,digest in source['sources'].items():
            relative='experiments/compatibility/'+(name if name.startswith(('runtime-probe/','rendering/')) else 'desktop-runtime/'+name)
            if sha(command(['git','show',origin['sourceCommit']+':'+relative],timeout=8))!=digest or sha((ROOT/relative).read_bytes())!=digest:raise RuntimeError('PAYLOAD_SOURCE_BYTES_CHANGED')
        report['preparation']={'producer':catalog['producer'],'sourceCommit':origin['sourceCommit'],'sources':source['sources']}
        phase='archive-validation'
        oci=module('desktop_outer_oci',DIRECTORY/'oci_inputs.py');configs={};image_identities={}
        for name,config_image in (('controller-image.tar',origin['controllerImageId']),('runtime-image.tar',prep['imageId'])):
            phase='archive-validation'
            fd=held.verify(name)
            with os.fdopen(os.dup(fd),'rb') as stream:identity=oci.validate_archive(stream,config_image,work_end)
            configs[name]=identity.configuration;image_identities[name]=identity
            image=identity.manifest_image_id
            held.verify(name)
            report.setdefault('imageIdentityMappings',{})[name]={'producerConfigImageId':identity.config_image_id,'nativeManifestImageId':identity.manifest_image_id,'archiveSha256':held.pins[name]['sha256']}
            if inspect(config_image,'image') is not None:raise RuntimeError('UNEXPECTED_CONFIG_IMAGE_ALIAS')
            existing=inspect(image,'image')
            if existing is None:
                imported.append(image);persist(name+'.planned.json',{'imageId':image,'configImageId':config_image,'archiveSha256':held.pins[name]['sha256']})
                phase='image-load'
                load=Channel(['docker','--host',endpoint,'image','load'],environment=environment,input_fd=fd);channels.append(load)
                stdout,stderr=load.drain(min(work_end,time.monotonic()+120));load.close(work_end);channels.remove(load)
                held.verify(name)
                report.setdefault('imageLoadReceipts',[]).append({'imageId':image,'exitCode':load.child.returncode,'stdout':stdout.decode('utf-8',errors='replace'),'stderr':stderr.decode('utf-8',errors='replace')})
                if load.child.returncode or stderr or stdout.decode()!='Loaded image ID: '+image+'\n':raise RuntimeError('IMAGE_LOAD_UNCONFIRMED')
            actual=inspect(image,'image')
            if not matches_image(actual,identity):raise RuntimeError('LOADED_IMAGE_CONFIG_CHANGED')
        image=image_identities['controller-image.tar'].manifest_image_id;runtime_image=image_identities['runtime-image.tar'].manifest_image_id;base_env=configs['controller-image.tar']['config']['Env']
        binding={'nonce':nonce,'bootId':boot,'daemonId':daemon,'kernel':version['KernelVersion'],'sourceCommit':origin['sourceCommit'],'sources':source['sources'],'guardianId':None,'preparedImage':None}
        if not entry.valid_binding(binding):raise RuntimeError('SOURCE_BINDING_INVALID')
        phase='guardian-start'
        guardian,guardian_channel,guardian_ready=start_role('guardian',binding,image,base_env)
        binding={**binding,'guardianId':guardian['cid'],'preparedImage':{'imageId':runtime_image,**{key:prep[key] for key in ('architecture','baseImage','helperSha256','abuseSha256','runtimeSources')}}}
        report['nonce']=nonce;report['bootId']=boot
        if mode=='--guardian-loss':
            from configuration import SAFE_ENVIRONMENT
            tag='fleur-runtime-probe-'+str(time.time_ns());row={'name':tag+'-run','owner':tag,'control':True}
            if inspect(row['name']) is not None:raise RuntimeError('FRESH_CONTROL_NAME_UNAVAILABLE')
            workers.append(row);persist('control-worker-planned.json',{'worker':row,'imageId':runtime_image,'nonce':nonce})
            args=['create','--name',row['name'],'--label','fleur.compatibility.runtime-owner='+tag,'--pull','never','--platform','linux/amd64','--entrypoint','bun','--user','65534:65534','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--security-opt','seccomp=unconfined','--cpus','1','--memory','536870912','--memory-swap','536870912','--pids-limit','64','--ulimit','core=0']
            for key,value in SAFE_ENVIRONMENT.items():args+=['--env',key+'='+value]
            cid=docker(args+[runtime_image,'-e',CONTROL_PROGRAM]).strip()
            current=inspect(cid)
            if not control_worker_profile(current,row,runtime_image):raise RuntimeError('CONTROL_WORKER_PROFILE_CHANGED')
            docker(['start',cid]);current=inspect(cid)
            if not control_worker_profile(current,row,runtime_image) or current['State']['Running'] is not True or current['State']['Pid']<=1:raise RuntimeError('LIVE_CONTROL_WORKER_UNPROVEN')
            pid=current['State']['Pid'];controls=('FLEUR_CONTROL_WORKER='+cid,'FLEUR_CONTROL_PID='+str(pid))
            manager,manager_channel,manager_ready=start_role('loss-manager',binding,image,base_env,program=LOSS_PROGRAM,controls=controls)
            armed=manager_channel.frame(min(work_end,time.monotonic()+10))
            if type(armed) is not dict or set(armed)!={'kind','nonce','workerId','workerPid','deadlineVmMonotonic'} or armed['kind']!='loss-armed' or armed['nonce']!=nonce or armed['workerId']!=cid or type(armed['workerPid']) is not int or armed['workerPid']!=pid or type(armed['deadlineVmMonotonic']) not in (float,int) or not math.isfinite(armed['deadlineVmMonotonic']):raise RuntimeError('LOSS_CONTROL_NOT_ARMED')
            current=inspect(manager['cid'])
            if not role_profile(current,**manager) or current['State']['Running'] is not True:raise RuntimeError('LOSS_MANAGER_CUSTODY_CHANGED')
            persist('loss-armed.json',armed);docker(['kill','--signal','KILL',manager['cid']]);manager_channel.drain(min(work_end,time.monotonic()+10));manager_channel.close(work_end);channels.remove(manager_channel)
            stopped=inspect(manager['cid'])
            if not role_profile(stopped,**manager) or stopped['State']['Running'] is not False or stopped['State']['Pid']!=0:raise RuntimeError('LOSS_MANAGER_EXIT_UNCONFIRMED')
            until=min(work_end,time.monotonic()+32);journals={}
            while time.monotonic()<until:
                guard=inspect(guardian['cid']);current=inspect(cid)
                if not role_profile(guard,**guardian) or guard['State']['Running'] is not True:raise RuntimeError('GUARDIAN_LOST_WITH_MANAGER')
                if not control_worker_profile(current,row,runtime_image):raise RuntimeError('CONTROL_WORKER_CUSTODY_CHANGED')
                if current['State']['Running'] is False and current['State']['Pid']==0:
                    journals=artifacts.canonical_json(docker(['exec',guardian['cid'],'/usr/bin/python3','-I','-c',journal_program()]))
                    if journals.get(cid) and journals[cid][-1].get('kind')=='retired':break
                time.sleep(.05)
            bound={cid:{'containerId':cid,'pid':pid,'deadlineVmMonotonic':armed['deadlineVmMonotonic']}}
            if not valid_journals(journals,nonce,boot,control_cid=cid,expected_bindings=bound):raise RuntimeError('MANAGER_LOSS_GUARDIAN_PROOF_FAILED')
            report.update(ok=True,managerLossVerified=True,guardianJournals=journals,controlBinding=bound)
            return report
        phase='manager-start'
        manager,manager_channel,manager_ready=start_role('manager',binding,image,base_env)
        frame=manager_channel.frame(work_end);report.setdefault('controllerFrames',[]).append(frame)
        if mode=='--qualify':
            if type(frame) is not dict or set(frame)!={'kind','nonce','bootId','daemonId','imageId','workers'} or frame['kind']!='ownership' or frame['nonce']!=nonce or frame['bootId']!=boot or frame['daemonId']!=daemon or frame['imageId']!=runtime_image or type(frame['workers']) is not list or len(frame['workers'])!=13:raise RuntimeError('OWNERSHIP_FRAME_INVALID')
            rows=frame['workers'];tag=rows[0].get('owner')
            if rows!=entry.worker_ledger(tag,runtime_image):raise RuntimeError('OWNERSHIP_LEDGER_CHANGED')
            for row in rows:
                if inspect(row['name']) is not None:raise RuntimeError('FRESH_WORKER_NAME_UNAVAILABLE')
            workers.extend(rows);persist('workers.json',frame);manager_channel.acknowledge(nonce,'ownership')
            guard_bindings={}
            frame=manager_channel.frame(work_end);report['controllerFrames'].append(frame)
            while frame.get('kind')=='guard-binding':
                if len(guard_bindings)>=4 or set(frame)!={'kind','nonce','containerId','pid','deadlineVmMonotonic'} or frame['nonce']!=nonce or type(frame['containerId']) is not str or not re.fullmatch(SHA,frame['containerId']) or frame['containerId'] in guard_bindings or type(frame['pid']) is not int or not 1<frame['pid']<2**31 or type(frame['deadlineVmMonotonic']) not in (int,float) or not math.isfinite(frame['deadlineVmMonotonic']):raise RuntimeError('GUARD_BINDING_INVALID')
                current=inspect(frame['containerId'])
                row=next((row for row in workers if current is not None and current['Name']=='/'+row['name']),None)
                if row is None or not re.search('-busy-[01]$',row['name']) or not entry.worker_profile(current,row['name'],runtime_image,row['owner']) or current['State']['Running'] is not True or current['State']['Pid']!=frame['pid']:raise RuntimeError('LIVE_GUARD_WORKER_UNPROVEN')
                guard_bindings[frame['containerId']]=frame;persist('guard-'+frame['containerId']+'.json',frame);manager_channel.acknowledge(nonce,'guard-'+frame['containerId'])
                frame=manager_channel.frame(work_end);report['controllerFrames'].append(frame)
        report['controller']=frame
        extra,errors=manager_channel.drain(work_end);manager_channel.close(work_end);channels.remove(manager_channel)
        if extra or errors or manager_channel.child.returncode or frame.get('kind')!='result' or frame.get('ok') is not True or frame.get('nonce')!=nonce or frame.get('bootId')!=boot or frame.get('sourceCommit')!=origin['sourceCommit'] or frame.get('sources')!=source['sources'] or frame.get('managerId')!=manager['cid'] or frame.get('managerPid')!=manager_ready['managerPid']:raise RuntimeError('CONTROLLER_RESULT_UNPROVEN')
        if mode=='--qualify':
            runtime=frame['runtime']
            if not entry.complete_result(0,runtime):raise RuntimeError('ORIGINAL_RUNTIME_ORACLES_FAILED')
            journals=artifacts.canonical_json(docker(['exec',guardian['cid'],'/usr/bin/python3','-I','-c',journal_program()]))
            expected=[]
            for lane in ('restricted_worker_lifecycle','restricted_worker_idle_lifecycle'):
                for repeat in runtime[lane]['repeats']:
                    termination=repeat['termination'];expected.append({key:value for key,value in termination.items() if key not in ('source','guard_reaped')})
            report['guardianJournals']=journals
            if not valid_journals(journals,nonce,boot,expected,expected_bindings=guard_bindings):raise RuntimeError('INDEPENDENT_GUARD_JOURNALS_UNPROVEN')
        report['ok']=True
    except Exception as error:
        report['ok']=False;report['error']=error_category(error);report['failurePhase']=phase
        report['failureType']=type(error).__name__
    finally:
        # Stop the sole creation authority before independently sweeping workers.
        authority_retired=True
        for expected in owned:
            if expected is guardian:continue
            try:
                current=inspect(expected['cid'] or expected['name'],cleanup=True)
                if current is not None:
                    adopted={**expected,'cid':expected['cid'] or current['Id']}
                    if not role_profile(current,**adopted):raise RuntimeError('MANAGER_RETIREMENT_CUSTODY_UNPROVEN')
                    if current['State']['Running']:
                        docker(['kill','--signal','KILL',adopted['cid']],True)
                    stopped=inspect(adopted['cid'],cleanup=True)
                    if stopped is None or not role_profile(stopped,**adopted) or stopped['State']['Running'] is not False or stopped['State']['Pid']!=0:raise RuntimeError('MANAGER_RETIREMENT_UNCONFIRMED')
            except Exception:authority_retired=False;report['ok']=False
        for channel in list(channels):
            if guardian is not None and channel is guardian_channel:continue
            try:channel.close(end);channels.remove(channel)
            except Exception:authority_retired=False;report['ok']=False
        workers_retired=authority_retired
        for row in workers:
            receipt={'resource':'worker','name':row['name'],'absent':False};report['cleanup'].append(receipt)
            try:
                value=inspect(row['name'],cleanup=True)
                if value is not None:
                    if not (control_worker_profile(value,row,runtime_image) if row.get('control') else entry.worker_profile(value,row['name'],runtime_image,row['owner'])):raise RuntimeError('WORKER_CLEANUP_OWNERSHIP_UNPROVEN')
                    docker(['rm','--force',value['Id']],True)
                    if inspect(value['Id'],cleanup=True) is not None:raise RuntimeError('WORKER_REMOVAL_UNCONFIRMED')
                receipt['absent']=True
            except Exception:workers_retired=False;report['ok']=False
        for expected in reversed(owned):
            receipt={'resource':'guardian' if expected is guardian else 'manager','absent':False};report['cleanup'].append(receipt)
            try:
                if expected is guardian and not workers_retired:raise RuntimeError('GUARDIAN_MUST_RETAIN_SUPERVISION')
                retire_role(expected);receipt['absent']=True
            except Exception:report['ok']=False
        for channel in reversed(channels):
            try:channel.close(end)
            except Exception:report['ok']=False;report['clientRetirementUnconfirmed']=True
        for image in reversed(imported):
            receipt={'resource':'imported-image','imageId':image,'absent':False};report['cleanup'].append(receipt)
            try:
                actual=inspect(image,'image',True)
                if actual is not None:
                    mapped=next(value for value in image_identities.values() if value.manifest_image_id==image)
                    if not matches_image(actual,mapped) or actual.get('RepoTags') not in (None,[]) or actual.get('RepoDigests') not in (None,[]):raise RuntimeError('IMPORTED_IMAGE_CUSTODY_CHANGED')
                    docker(['image','rm',image],True,timeout=15)
                    if inspect(image,'image',True) is not None:raise RuntimeError('IMPORTED_IMAGE_REMOVAL_UNCONFIRMED')
                receipt['absent']=True
            except Exception:report['ok']=False
        if held is not None:
            try:held.close()
            except Exception:report['ok']=False;report['artifactDescriptorRetirementUnconfirmed']=True
        if original is not None:
            try:report['originalPreserved']=inventory(True)==original
            except Exception as error:report['originalPreserved']=False;report['preservationObservationError']=error_category(error)
            if report['originalPreserved'] is not True:report['ok']=False
        if ledger_dir is not None:
            try:ledger_dir.cleanup()
            except Exception:report['ok']=False;report['custodyLedgerDisposalUnconfirmed']=True
        report['elapsedMs']=round((time.monotonic()-(end-600))*1000)
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--mode',required=True,choices=['--capabilities','--guardian-loss','--qualify']);parser.add_argument('--images-directory',required=True)
    args=parser.parse_args()
    if args.mode=='--qualify':
        control=observe('--guardian-loss',args.images_directory)
        result=observe(args.mode,args.images_directory) if control['ok'] is True else {'ok':False,'scope':'native-intel-desktop-runtime-qualification','runtimeAdmission':False,'nativeQualification':False,'error':'FRESH_MANAGER_LOSS_CONTROL_REQUIRED'}
        result['managerLossControl']=control
    else:result=observe(args.mode,args.images_directory)
    print(json.dumps(result,separators=(',',':')));raise SystemExit(0 if result['ok'] else 4)

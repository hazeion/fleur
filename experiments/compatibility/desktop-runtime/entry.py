"""Trusted Desktop Linux-VM controller/guardian. Never application admission."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import select
import subprocess
import sys
import time
from contextlib import redirect_stdout

ROOT=Path('/controller')
UUID=r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
OWNER='dev.fleur.desktop-runtime-owner'
ROLE='dev.fleur.desktop-runtime-role'
# Measured Desktop tuples (Platform.Name, Version, GitCommit, Arch) and executed compiler pins, Apple Silicon first.
DESKTOPS={'arm64':('Docker Desktop 4.99.0 (245822)','29.9.3','70efc0e','arm64'),'amd64':('Docker Desktop 4.96.1 (244132)','29.9.2','0367cbe','amd64')}
COMPILERS={'arm64':'a20520ee21543f243d40636a9181a142c45ecd989de31ab86b99a8ea5ada870d','amd64':'1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26'}
MACHINES={'aarch64':'arm64','x86_64':'amd64'}

def valid_binding(value):
    if type(value) is not dict or set(value)!={'nonce','bootId','daemonId','kernel','sourceCommit','sources','guardianId','preparedImage'}:return False
    if any(type(value[key]) is not str for key in ('nonce','bootId','daemonId','kernel','sourceCommit')):return False
    if not re.fullmatch(UUID,value['nonce']) or not re.fullmatch(UUID,value['bootId']):return False
    if value['kernel']!='7.0.14-linuxkit' or not re.fullmatch(r'[a-f0-9]{40}',value['sourceCommit']):return False
    if not re.fullmatch(r'[A-Za-z0-9:_-]{1,128}',value['daemonId']):return False
    if value['guardianId'] is not None and (type(value['guardianId']) is not str or not re.fullmatch('[a-f0-9]{64}',value['guardianId'])):return False
    prepared=value['preparedImage']
    if prepared is not None and (type(prepared) is not dict or set(prepared)!={'imageId','architecture','baseImage','helperSha256','abuseSha256','runtimeSources'}):return False
    sources=value['sources']
    return type(sources) is dict and bool(sources) and all(type(key) is str and (key in ('Dockerfile','runtime-probe/.gitignore') or re.fullmatch(r'(?:runtime-probe/|rendering/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z0-9]+',key)) and '..' not in key and type(digest) is str and re.fullmatch(r'[a-f0-9]{64}',digest) for key,digest in sources.items())

def complete_result(code, report):
    if type(code) is not int or code!=0 or type(report) is not dict:return False
    if report.get('bounded_probe_passed') is not True or report.get('cleanup_complete') is not True:return False
    if report.get('idle_runtime_stress') is not True or report.get('daemon_build_may_be_pending') is not False:return False
    for key in ('restricted_worker_lifecycle','restricted_worker_idle_lifecycle'):
        proof=report.get(key)
        if type(proof) is not dict or proof.get('passed') is not True or type(proof.get('repeats')) is not list or len(proof['repeats'])!=2:return False
    return True  # run.main applies every original complete report/resource oracle.

def worker_ledger(tag,image):
    if type(tag) is not str or not re.fullmatch('fleur-runtime-probe-[0-9]{1,24}',tag) or type(image) is not str or not re.fullmatch('sha256:[a-f0-9]{64}',image):raise RuntimeError('OWNERSHIP_LEDGER_INVALID')
    rows=[{'name':tag+suffix,'owner':tag} for suffix in ('-run','-cpu','-memory','-pids','-event-replacement')]
    for owner in (tag,tag+'-idle'):
        rows.extend({'name':owner+'-'+role+'-'+str(repeat),'owner':owner} for repeat in range(2) for role in ('busy','healthy'))
    return rows

def worker_profile(value,name,image,owner):
    """Cleanup-only profile, including stopped workers. No runtime admission."""
    try:
        if type(name) is not str or type(owner) is not str or not re.fullmatch('fleur-runtime-probe-[0-9]{1,24}(?:-idle)?',owner):return False
        tag=owner.removesuffix('-idle')
        if {'name':name,'owner':owner} not in worker_ledger(tag,image):return False
        config=value['Config'];host=value['HostConfig'];state=value['State']
        if name.endswith(('-cpu','-memory','-pids')):
            mode=name.rsplit('-',1)[1];entry=['/probe/abuse'];args=[mode]
        else:
            entry=['bun','/probe/bootstrap.js'];args=['busy'] if re.search('-busy-[01]$',name) else ['event-replacement'] if name.endswith('-event-replacement') else []
        from configuration import SAFE_ENVIRONMENT
        env=config['Env']
        admitted=dict(item.split('=',1) for item in env)
        return (type(value['Id']) is str and re.fullmatch('[a-f0-9]{64}',value['Id']) is not None
            and value['Name']=='/'+name and value['Image']==image and value['Mounts']==[]
            and config['Image']==image and config['User']=='65534:65534' and config['Labels'].get('fleur.compatibility.runtime-owner')==owner
            and config['Entrypoint']==entry and (config['Cmd']==args or (not args and config['Cmd'] is None))
            and config.get('Volumes') in (None,{}) and len(env)==len(SAFE_ENVIRONMENT) and admitted==SAFE_ENVIRONMENT
            and host['Privileged'] is False and host['ReadonlyRootfs'] is True and host['NetworkMode']=='none'
            and host['CapDrop']==['ALL'] and host.get('CapAdd') in (None,[]) and sorted(host['SecurityOpt'])==['no-new-privileges','seccomp=unconfined']
            and host['Memory']==536870912 and host['MemorySwap']==536870912 and host['NanoCpus']==1000000000 and host['PidsLimit']==64
            and host.get('PidMode') in ('','private') and host.get('IpcMode') in ('private','none')
            and host.get('Tmpfs') in (None,{}) and all(host.get(key) in (None,[]) for key in ('Binds','Mounts','Devices','DeviceRequests','VolumesFrom'))
            and type(state['Running']) is bool and type(state['Pid']) is int and 0<=state['Pid']<2**31)
    except (KeyError,TypeError,AttributeError,ValueError,ImportError):return False

def guardian_launcher(guardian_id, root_guard, spawn=subprocess.Popen):
    if type(guardian_id) is not str or not re.fullmatch('[a-f0-9]{64}',guardian_id):raise RuntimeError('GUARDIAN_ID_REQUIRED')
    def launch(args,**kwargs):
        if (type(args) is not list or len(args)!=9 or args[:5]!=['/usr/bin/sudo','-n','/usr/bin/python3','-I','-c'] or args[5]!=root_guard
                or not re.fullmatch('[a-f0-9]{64}',args[6]) or not re.fullmatch('[1-9][0-9]{0,9}',args[7])
                or not 1<int(args[7])<2**31):raise RuntimeError('FIXED_GUARD_COMMAND_REQUIRED')
        return spawn(['docker','exec','--interactive','--user','0:0',guardian_id,'/usr/bin/python3','-I','/controller/guardian_guard.py',*args[6:]],**kwargs)
    return launch

def emit(value):
    data=(json.dumps(value,separators=(',',':'))+'\n').encode()
    if len(data)>1048576 or os.write(1,data)!=len(data):raise RuntimeError('FRAME_OUTPUT_FAILED')

def root_launch(manager_id,bounded):
    """Prove root execution; retain only the two measured isolation warnings."""
    if type(manager_id) is not str or not re.fullmatch('[a-f0-9]{64}',manager_id):raise RuntimeError('ROOT_LAUNCH_IDENTITY_REQUIRED')
    result=bounded(['/usr/bin/sudo','-n','/usr/bin/python3','-I','-c','import os;assert os.geteuid()==0;print("root-launch-confirmed")'],timeout=5)
    warnings=('sudo: unable to resolve host '+manager_id[:12]+': Temporary failure in name resolution\n'
              'sudo: unable to send audit message: Operation not permitted\n').encode()
    if (type(result.returncode) is not int or result.returncode!=0 or result.stdout!=b'root-launch-confirmed\n'
            or result.stderr not in (b'',warnings)):raise RuntimeError('ROOT_LAUNCH_UNCONFIRMED')
    return {'verified':True,'stderr':result.stderr.decode()}

def acknowledge(binding,phase,absolute_deadline=None):
    end=min(time.monotonic()+20,absolute_deadline) if absolute_deadline is not None else time.monotonic()+20;data=bytearray()
    while b'\n' not in data:
        if not select.select([0],[],[],max(0,end-time.monotonic()))[0]:raise RuntimeError('ACK_DEADLINE_EXPIRED')
        block=os.read(0,1024)
        if not block or len(data)+len(block)>1024:raise RuntimeError('ACK_BOUND_OR_EOF')
        data.extend(block)
    if time.monotonic()>=end:raise RuntimeError('ACK_DEADLINE_EXPIRED')
    expected={'kind':'ack','phase':phase,'nonce':binding['nonce']}
    if bytes(data)!=(json.dumps(expected,separators=(',',':'))+'\n').encode():raise RuntimeError('ACK_BINDING_CHANGED')

def main():
    outcome={'formatVersion':1,'scope':'native-desktop-linux-runtime-controller','ok':False,'runtimeAdmission':False,'nativeQualification':False}
    try:
        if sys.argv[1:] not in (['--guardian'],['--capabilities'],['--qualify']):raise RuntimeError('FIXED_MODE_REQUIRED')
        mode=sys.argv[1];raw=os.environ.get('FLEUR_DESKTOP_BINDING','')
        if len(raw.encode())>65536:raise RuntimeError('BINDING_BOUND')
        binding=json.loads(raw)
        if not valid_binding(binding):raise RuntimeError('BINDING_INVALID')
        guardian=mode=='--guardian'
        if guardian!=(binding['guardianId'] is None) or (guardian and binding['preparedImage'] is not None):raise RuntimeError('ROLE_BINDING_INVALID')
        architecture=MACHINES.get(platform.machine())
        if platform.system()!='Linux' or architecture is None or os.geteuid()!=0 or platform.release()!=binding['kernel']:raise RuntimeError('NATIVE_LINUX_MANAGER_REQUIRED')
        def boot():return Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        if boot()!=binding['bootId'] or os.readlink('/proc/self/ns/pid')!=os.readlink('/proc/1/ns/pid'):raise RuntimeError('VM_IDENTITY_CHANGED')
        manifest=json.loads((ROOT/'source-manifest.json').read_text())
        if manifest!={'sourceCommit':binding['sourceCommit'],'sources':binding['sources']}:raise RuntimeError('SOURCE_MANIFEST_CHANGED')
        for name,digest in binding['sources'].items():
            path=ROOT/name
            if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise RuntimeError('SOURCE_BYTES_CHANGED')
        spec=importlib.util.spec_from_file_location('desktop_processes',ROOT/'processes.py');processes=importlib.util.module_from_spec(spec);spec.loader.exec_module(processes)
        def command(args,timeout=5):
            result=processes.bounded(args,timeout=timeout)
            if result.returncode or result.stderr:raise RuntimeError('FIXED_COMMAND_FAILED')
            return result.stdout.decode()
        cgroup=Path('/proc/self/cgroup').read_text()
        match=re.fullmatch(r'0::/(?:docker/([a-f0-9]{64})|system.slice/docker-([a-f0-9]{64})\.scope)\n',cgroup)
        if not match:raise RuntimeError('MANAGER_CGROUP_UNBOUND')
        manager_id=match[1] or match[2]
        ready={'kind':'ready','role':'guardian' if guardian else 'manager','nonce':binding['nonce'],'bootId':boot(),'managerId':manager_id,'managerPid':os.getpid(),'vmMonotonicNs':str(time.monotonic_ns()),'sourceCommit':binding['sourceCommit'],'sources':binding['sources'],'bindingSha256':hashlib.sha256(raw.encode()).hexdigest()}
        emit(ready);acknowledge(binding,'ready')
        if guardian:
            # Client/manager EOF cannot retire independent already-armed guards.
            time.sleep(900)
            return 0
        server=json.loads(command(['docker','version','--format','{{json .Server}}']))
        if (server.get('Platform',{}).get('Name'),server.get('Version'),server.get('GitCommit'),server.get('Arch'))!=DESKTOPS[architecture] or server.get('KernelVersion')!=binding['kernel']:raise RuntimeError('DESKTOP_TUPLE_CHANGED')
        if json.loads(command(['docker','info','--format','{{json .ID}}']))!=binding['daemonId']:raise RuntimeError('DAEMON_IDENTITY_CHANGED')
        guard=json.loads(command(['docker','inspect',binding['guardianId'],'--format','{{json .}}']))
        own=json.loads(command(['docker','inspect',manager_id,'--format','{{json .}}']))
        if (guard.get('Id')!=binding['guardianId'] or guard.get('Image')!=own.get('Image') or guard.get('Mounts')!=[] or guard.get('Config',{}).get('Labels',{}).get(OWNER)!=binding['nonce'] or guard.get('Config',{}).get('Labels',{}).get(ROLE)!='guardian' or guard.get('State',{}).get('Running') is not True):raise RuntimeError('GUARDIAN_BINDING_CHANGED')
        root_proof=root_launch(manager_id,processes.bounded)
        compiler=Path('/usr/local/bin/gcc')
        if hashlib.sha256(compiler.read_bytes()).hexdigest()!=COMPILERS[architecture]:raise RuntimeError('COMPILER_PIN_CHANGED')
        outcome.update({key:ready[key] for key in ('nonce','bootId','managerId','managerPid','vmMonotonicNs','sourceCommit','sources')})
        outcome.update(controllerUserspace=Path('/etc/os-release').read_text(),packages=Path('/controller-packages.tsv').read_text(),rootLaunchVerified=True,rootLaunch=root_proof)
        if mode=='--capabilities':outcome['ok']=True
        else:
            sys.path.insert(0,str(ROOT/'runtime-probe'))
            import run
            from worker_deadline import HostDeadlineGuard,ROOT_GUARD
            prepared=binding['preparedImage']
            if prepared is None:raise RuntimeError('PREPARED_IMAGE_REQUIRED')
            if prepared['architecture']!=architecture:raise RuntimeError('PREPARED_IMAGE_ARCHITECTURE_MISMATCH')
            image=run.PreparedRuntimeImage(prepared['imageId'],prepared['architecture'],prepared['baseImage'],prepared['helperSha256'],prepared['abuseSha256'],tuple(sorted(prepared['runtimeSources'].items())))
            def register(tag,image_id):
                ledger={'kind':'ownership','nonce':binding['nonce'],'bootId':binding['bootId'],'daemonId':binding['daemonId'],'imageId':image_id,'workers':worker_ledger(tag,image_id)}
                emit(ledger);acknowledge(binding,'ownership')
            launch=guardian_launcher(binding['guardianId'],ROOT_GUARD)
            def deadline(cid,pid,end):
                guard=HostDeadlineGuard(cid,pid,end,launcher=launch)
                try:
                    emit({'kind':'guard-binding','nonce':binding['nonce'],'containerId':cid,'pid':pid,'deadlineVmMonotonic':end})
                    acknowledge(binding,'guard-'+cid,absolute_deadline=end)
                    return guard
                except BaseException:
                    guard.close();raise
            def cleanup(name,image_id,owner):
                result=processes.bounded(['docker','inspect',name,'--format','{{json .}}'])
                if result.returncode==1 and result.stdout==b'\n' and result.stderr==('error: no such object: '+name+'\n').encode():return 'absent'
                if result.returncode or result.stderr:raise RuntimeError('WORKER_INSPECTION_UNCONFIRMED')
                value=json.loads(result.stdout)
                if not worker_profile(value,name,image_id,owner):raise RuntimeError('WORKER_CLEANUP_OWNERSHIP_UNPROVEN')
                command(['docker','rm','--force',value['Id']])
                absent=processes.bounded(['docker','inspect',value['Id'],'--format','{{json .}}'])
                if absent.returncode!=1 or absent.stdout!=b'\n' or absent.stderr!=('error: no such object: '+value['Id']+'\n').encode():raise RuntimeError('WORKER_REMOVAL_UNCONFIRMED')
                return 'removed'
            output=io.StringIO()
            with redirect_stdout(output):code=run.main(architecture,idle_runtime_stress=True,prepared_image=image,owner_registration=register,deadline_factory=deadline,owned_cleanup=cleanup)
            outcome['runtime']=run.REPORT;outcome['ok']=complete_result(code,run.REPORT)
            if not outcome['ok']:outcome['error']='ORIGINAL_RUNTIME_PROOF_FAILED'
        if boot()!=binding['bootId']:raise RuntimeError('VM_BOOT_CHANGED')
    except Exception as error:
        outcome['ok']=False;outcome['error']=str(error) if type(error) is RuntimeError and re.fullmatch(r'[A-Z_]{1,64}',str(error)) else 'CONTROLLER_FAILED'
    emit({'kind':'result',**outcome})
    return 0 if outcome['ok'] else 4

if __name__=='__main__':raise SystemExit(main())

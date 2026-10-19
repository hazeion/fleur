"""Read-only host evidence for the experimental VFS worker profile.

/proc/PID/net exposes that process's network namespace; no setns is needed.
See proc_pid_net(5), proc_pid_mountinfo(5), and kernel cgroup-v2 documentation.
"""
import json
import math
import os
import re
import selectors
import subprocess
import time

PROOF = {
    'kernel_network_isolated': True, 'loopback_only': True, 'external_routes': 0,
    'profile_verified': True, 'read_only_root': True, 'unprivileged': True,
    'cgroup_verified': True, 'process_identity_verified': True,
    'memory_max': 536870912, 'memory_swap_max': 0, 'pids_max': 64, 'cpu_count': 1,
}

# Only fixed kernel paths plus a validated PID and cgroup components are opened.
# This source is passed as an argument, never loaded from an elevated file path.
HELPER = r'''
import ipaddress,json,math,os,re,select,signal,sys,time
stage='request'
fds=[]
def require(condition):
    if not condition: raise ValueError('unverified')
def opened(path, directory=False, parent=None):
    flags=os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW
    if directory: flags|=os.O_DIRECTORY
    fd=os.open(path,flags,dir_fd=parent);fds.append(fd)
    return fd
def read(parent,name,limit=65536):
    fd=os.open(name,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=parent)
    try:
        data=b''
        while len(data)<=limit:
            part=os.read(fd,min(8192,limit+1-len(data)))
            if not part: break
            data+=part
        require(len(data)<=limit)
        return data.decode('ascii')
    finally: os.close(fd)
def identity(proc,expected=None):
    raw=read(proc,'stat',4096)
    prefix,sep,tail=raw.rpartition(') ')
    require(sep and prefix.startswith(str(pid if expected is None else expected)+' ('))
    fields=tail.split()
    require(len(fields)>=20 and fields[0] not in ('Z','X','x') and fields[19].isdigit())
    return fields[19]
def cgroup(proc,expected=None):
    rows=read(proc,'cgroup',4096).splitlines()
    require(len(rows)==1 and rows[0].startswith('0::/'))
    parts=rows[0][4:].split('/')
    require(all(part and part not in ('.','..') and re.fullmatch(r'[A-Za-z0-9_.:-]+',part) for part in parts))
    expected=cid if expected is None else expected
    require(expected in parts or 'docker-'+expected+'.scope' in parts)
    return parts
def status(proc):
    values={}
    for row in read(proc,'status').splitlines():
        key,sep,value=row.partition(':')
        require(sep and key not in values)
        values[key]=value.split()
    for key in ('Uid','Gid'): require(values.get(key)==['65534']*4)
    for key in ('CapEff','CapPrm','CapBnd'):
        value=values.get(key,[])
        require(len(value)==1 and re.fullmatch(r'[0-9a-fA-F]{16}',value[0]) and int(value[0],16)==0)
    require(values.get('NoNewPrivs')==['1'])
def mount_rows(raw):
    rows=[]
    for row in raw.splitlines():
        before,sep,after=row.partition(' - ');left=before.split();right=after.split()
        require(sep and len(left)>=6 and len(right)==3)
        rows.append((left,right))
    require(rows)
    return rows
def root_readonly(proc):
    roots=[left for left,right in mount_rows(read(proc,'mountinfo',262144)) if left[4]=='/']
    require(len(roots)==1 and 'ro' in roots[0][5].split(',') and 'rw' not in roots[0][5].split(','))
def limits(cg):
    for name,expected in [('memory.max','536870912'),('memory.swap.max','0'),('pids.max','64')]:
        require(read(cg,name,128).strip()==expected)
    cpu=read(cg,'cpu.max',128).split()
    require(len(cpu)==2 and all(value.isdigit() for value in cpu) and int(cpu[0])==int(cpu[1]) and int(cpu[0])>0)
def net_identity(proc):
    value=os.stat('ns/net',dir_fd=proc)
    return value.st_dev,value.st_ino

def network(proc):
    rows=read(proc,'net/dev').splitlines()
    require(len(rows)>=3 and 'Inter-' in rows[0] and 'face' in rows[1])
    interfaces=[]
    for row in rows[2:]:
        name,sep,counters=row.partition(':');values=counters.split()
        require(sep and len(values)==16 and all(value.isdigit() for value in values))
        interfaces.append(name.strip())
    require(interfaces==['lo'])
    rows=read(proc,'net/route').splitlines()
    require(rows and rows[0].split()==['Iface','Destination','Gateway','Flags','RefCnt','Use','Metric','Mask','MTU','Window','IRTT'])
    for row in rows[1:]:
        cols=row.split();require(len(cols)==11 and cols[0]=='lo')
        require(all(re.fullmatch(r'[0-9A-Fa-f]{8}',cols[index]) for index in (1,2,7)))
        require(re.fullmatch(r'[0-9A-Fa-f]{4}',cols[3]))
        flags=int(cols[3],16)
        # RTF_REJECT is an unreachable sink, not authority to reach a network.
        if flags & 0x200: continue
        destination=ipaddress.IPv4Address(bytes.fromhex(cols[1])[::-1])
        gateway=ipaddress.IPv4Address(bytes.fromhex(cols[2])[::-1])
        mask=ipaddress.IPv4Address(bytes.fromhex(cols[7])[::-1])
        network=ipaddress.IPv4Network(str(destination)+'/'+str(mask),strict=False)
        require(network.subnet_of(ipaddress.IPv4Network('127.0.0.0/8')) and (int(gateway)==0 or gateway.is_loopback))
    for row in read(proc,'net/ipv6_route').splitlines():
        cols=row.split();require(len(cols)==10 and cols[9]=='lo')
        require(all(re.fullmatch(r'[0-9a-fA-F]{32}',cols[index]) for index in (0,2,4)))
        require(all(re.fullmatch(r'[0-9a-fA-F]{2}',cols[index]) and int(cols[index],16)<=128 for index in (1,3)))
        require(all(re.fullmatch(r'[0-9a-fA-F]{8}',cols[index]) for index in (5,6,7,8)))
        if int(cols[8],16) & 0x200: continue
        destination=ipaddress.IPv6Address(int(cols[0],16));gateway=ipaddress.IPv6Address(int(cols[4],16))
        require(destination==ipaddress.IPv6Address('::1') and int(cols[1],16)==128 and (int(gateway)==0 or gateway.is_loopback))

try:
    require(os.geteuid()==0)
    request=json.loads(sys.stdin.buffer.read(513));require(type(request) is dict and set(request) in ({'container_id','pid','deadline'},{'container_id','pid','deadline','peer'}))
    cid=request['container_id'];pid=request['pid'];deadline=request['deadline']
    require(type(cid) is str and re.fullmatch(r'[0-9a-f]{64}',cid) and type(pid) is int and 1<pid<2**31)
    require(type(deadline) in (int,float) and math.isfinite(deadline) and 0<deadline-time.monotonic()<=30)
    signal.setitimer(signal.ITIMER_REAL,deadline-time.monotonic())
    stage='identity'
    pidfd=os.pidfd_open(pid,0);fds.append(pidfd)
    require(not select.select([pidfd],[],[],0)[0])
    proc=opened('/proc/'+str(pid),True)
    # Bind the caller's exact CID before reading other process/profile data.
    parts=cgroup(proc)
    started=identity(proc)
    stage='cgroup'
    own=opened('/proc/'+str(os.getpid()),True)
    matches=[(left,right) for left,right in mount_rows(read(own,'mountinfo',262144)) if left[4]=='/sys/fs/cgroup']
    require(len(matches)==1 and matches[0][0][3]=='/' and matches[0][1][0]=='cgroup2')
    cg=opened('/sys/fs/cgroup',True)
    for part in parts: cg=opened(part,True,cg)
    limits(cg)
    stage='authority';status(proc);root_readonly(proc)
    stage='network'
    host_net=net_identity(own);worker_net=net_identity(proc)
    require(worker_net!=host_net);network(proc)
    peer=request.get('peer')
    if peer is not None:
        stage='peer-identity'
        require(type(peer) is dict and set(peer)=={'container_id','pid'})
        peer_id=peer['container_id'];peer_pid=peer['pid']
        require(type(peer_id) is str and re.fullmatch(r'[0-9a-f]{64}',peer_id) and peer_id!=cid
                and type(peer_pid) is int and 1<peer_pid<2**31 and peer_pid!=pid)
        peerfd=os.pidfd_open(peer_pid,0);fds.append(peerfd)
        require(not select.select([peerfd],[],[],0)[0])
        peerproc=opened('/proc/'+str(peer_pid),True)
        peer_group=cgroup(peerproc,peer_id)
        peer_started=identity(peerproc,peer_pid)
        peer_net=net_identity(peerproc)
        require(peer_net!=worker_net and peer_net!=host_net)
        require(cgroup(peerproc,peer_id)==peer_group and identity(peerproc,peer_pid)==peer_started
                and net_identity(peerproc)==peer_net and not select.select([peerfd],[],[],0)[0])
    stage='identity-fence'
    require(cgroup(proc)==parts and identity(proc)==started and net_identity(proc)==worker_net and net_identity(own)==host_net)
    status(proc);root_readonly(proc);limits(cg);network(proc)
    require(not select.select([pidfd],[],[],0)[0] and time.monotonic()<deadline)
    print(json.dumps({'kernel_network_isolated':True,'loopback_only':True,'external_routes':0,
        'profile_verified':True,'read_only_root':True,'unprivileged':True,'cgroup_verified':True,
        'process_identity_verified':True,'memory_max':536870912,'memory_swap_max':0,'pids_max':64,'cpu_count':1}),flush=True)
except Exception:
    print(json.dumps({'error':stage}),flush=True)
    sys.exit(1)
finally:
    for fd in reversed(fds):
        try: os.close(fd)
        except OSError: pass
'''


class KernelProfileUnverified(RuntimeError):
    """A safe failure category, without captured host paths or identifiers."""


def valid_kernel_profile(proof):
    """Accept only the complete, typed evidence returned by the host helper."""
    return type(proof) is dict and set(proof)==set(PROOF) and all(
        type(proof[key]) is type(value) and proof[key]==value for key,value in PROOF.items())


def inspect_kernel_profile(container_id: str, pid: int, timeout: float = 5, *, peer=None) -> dict:
    if type(container_id) is not str or not re.fullmatch(r'[0-9a-f]{64}', container_id) or type(pid) is not int or not 1 < pid < 2**31:
        raise KernelProfileUnverified('kernel-profile-identity')
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0.5 <= timeout <= 30:
        raise KernelProfileUnverified('kernel-profile-budget')
    if peer is not None and (type(peer) is not dict or set(peer)!={'container_id','pid'}
            or type(peer.get('container_id')) is not str or re.fullmatch(r'[0-9a-f]{64}',peer['container_id']) is None
            or peer['container_id']==container_id or type(peer.get('pid')) is not int
            or not 1<peer['pid']<2**31 or peer['pid']==pid):
        raise KernelProfileUnverified('kernel-profile-peer')
    deadline=time.monotonic()+timeout
    # Root timeout owns termination and reaping. Its escalation finishes before
    # the parent deadline, including when the caller cannot signal root itself.
    command=['/usr/bin/sudo','-n','/usr/bin/env','-i','PATH=/usr/bin:/bin',
             '/usr/bin/timeout','--signal=TERM','--kill-after=0.2s',str(timeout-0.4)+'s',
             '/usr/bin/python3','-I','-u','-c',HELPER]
    request={'container_id':container_id,'pid':pid,'deadline':deadline-0.3}
    if peer is not None:request['peer']=peer
    payload=json.dumps(request).encode('ascii')
    output=bytearray();error=bytearray()
    process=None
    try:
        with selectors.DefaultSelector() as selector:
            process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                     env={'PATH':'/usr/bin:/bin'},start_new_session=True)
            process.stdin.write(payload);process.stdin.close()
            for pipe,target,limit in [(process.stdout,output,2048),(process.stderr,error,1024)]:
                os.set_blocking(pipe.fileno(),False);selector.register(pipe,selectors.EVENT_READ,(target,limit))
            while selector.get_map():
                remaining=deadline-time.monotonic()
                if remaining<=0: raise KernelProfileUnverified('kernel-profile-timeout')
                for key,_ in selector.select(min(remaining,0.05)):
                    target,limit=key.data;chunk=os.read(key.fileobj.fileno(),min(4096,limit+1-len(target)))
                    if not chunk: selector.unregister(key.fileobj)
                    else:
                        target.extend(chunk)
                        if len(target)>limit: raise KernelProfileUnverified('kernel-profile-output-bound')
            process.wait(timeout=max(0.001,deadline-time.monotonic()))
        if time.monotonic()>=deadline: raise KernelProfileUnverified('kernel-profile-timeout')
        if process.returncode or error: raise KernelProfileUnverified('kernel-profile-helper')
        proof=json.loads(output.decode('ascii'))
        if not valid_kernel_profile(proof):
            raise KernelProfileUnverified('kernel-profile-result')
        return proof
    except KernelProfileUnverified:
        raise
    except (OSError,ValueError,subprocess.TimeoutExpired):
        raise KernelProfileUnverified('kernel-profile-transport') from None
    finally:
        if process is not None:
            for pipe in (process.stdin,process.stdout,process.stderr):
                if pipe is not None: pipe.close()
            try: process.wait(timeout=max(0.001,deadline-time.monotonic()))
            except subprocess.TimeoutExpired:
                # The trusted root timeout remains responsible for its helper.
                process.kill();process.wait()

"""Fixed ordinary-account Arch observations. No installation or runtime admission."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

PACKAGES=('docker','docker-compose','containerd','runc')


def inventory(text):
    result={}
    if type(text) is not str or not text or not text.endswith('\n'):
        raise ValueError('Complete package inventory required')
    for line in text.splitlines():
        match=re.fullmatch(r'([a-z0-9@][a-z0-9@+_.-]*) ([^\s\x00-\x1f\x7f]+)',line)
        if not match or match[1] in result:
            raise ValueError('Unique package inventory rows required')
        result[match[1]]=match[2]
    return result


def known_packages(code,out,error):
    if type(code) is not int or code not in (0,1):
        raise ValueError('Package query did not establish presence or absence')
    installed=inventory(out) if out else {}
    if set(installed)-set(PACKAGES):
        raise ValueError('Unexpected package row')
    missing=[name for name in PACKAGES if name not in installed]
    expected=''.join("error: package '"+name+"' was not found\n" for name in missing)
    if code!=(1 if missing else 0) or error!=expected:
        raise ValueError('Complete exact missing-package rows required')
    return {'installed':installed,'absent':missing}


def backend_version(code,out,error):
    if code != 0 or error:
        raise ValueError('Backend version query failed')
    matches = re.findall(r'^ \.--\. +Pacman v([0-9]+\.[0-9]+\.[0-9]+) - libalpm v([0-9]+\.[0-9]+\.[0-9]+) *$',out,re.MULTILINE)
    if len(matches) != 1:
        raise ValueError('Exact pacman/libalpm version line required')
    return {'pacman':matches[0][0],'libalpm':matches[0][1]}


def service_fields(code,out,error):
    if code not in (0,1) or error:
        raise ValueError('Passive service query failed')
    expected = {'LoadState','ActiveState','SubState','UnitFileState','FragmentPath','DropInPaths','Transient','MainPID'}
    values = {}
    for line in out.splitlines():
        name,sep,value = line.partition('=')
        if not sep or name not in expected or name in values:
            raise ValueError('Closed service properties required')
        if name in ('FragmentPath','DropInPaths'):
            if value and re.fullmatch(r'/usr/lib/systemd/system/(?:docker.service|docker.socket|containerd.service|nftables.service)',value) is None:
                values[name]={'unexpectedSha256':hashlib.sha256(value.encode()).hexdigest()}
            else:
                values[name]=value
        elif re.fullmatch(r'[a-z0-9-]{0,64}',value) is None:
            raise ValueError('Safe service property required')
        else:
            values[name]=value
    if set(values)!=expected or not out.endswith('\n'):
        raise ValueError('Complete service properties required')
    return values


def package_owner(path,code,out,error):
    if code!=0 or error:
        raise ValueError('Package ownership query incomplete')
    match=re.fullmatch(re.escape(path)+r' is owned by ([a-z0-9@][a-z0-9@+_.-]*) ([^\s\x00-\x1f\x7f]+)\n',out)
    if not match:
        raise ValueError('Exact safe ownership row required')
    return {'package':match[1],'version':match[2]}


def run(args,deadline):
    if time.monotonic()>=deadline:
        raise TimeoutError('Original observation deadline expired')
    child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        start_new_session=True,env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','SYSTEMD_PAGER':'cat'})
    output={child.stdout:bytearray(),child.stderr:bytearray()}
    selector=selectors.DefaultSelector()
    primary=None
    def partial():
        return {'stdoutBytes':len(output[child.stdout]),'stderrBytes':len(output[child.stderr]),
                'stdoutSha256':hashlib.sha256(output[child.stdout]).hexdigest(),
                'stderrSha256':hashlib.sha256(output[child.stderr]).hexdigest(),'completed':False}
    try:
        for stream in output:
            selector.register(stream,selectors.EVENT_READ)
        end=min(deadline,time.monotonic()+10)
        while selector.get_map():
            if time.monotonic()>=end:
                raise TimeoutError('Fixed read-only query timed out')
            for key,_ in selector.select(.05):
                part=os.read(key.fileobj.fileno(),8192)
                if not part:
                    selector.unregister(key.fileobj)
                else:
                    output[key.fileobj].extend(part)
                    if sum(map(len,output.values()))>2*1024*1024:
                        raise ValueError('Fixed read-only query exceeded output bound')
        while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
            if time.monotonic()>=end:
                raise TimeoutError('Fixed read-only query timed out')
            time.sleep(.02)
        if time.monotonic()>=end:
            raise TimeoutError('Fixed read-only query deadline expired')
    except BaseException as error:
        primary=error
        error.observation=partial()
        raise
    finally:
        # Keep the leader unreaped until the original group has been signalled.
        try:
            os.killpg(child.pid,signal.SIGKILL)
        except (ProcessLookupError,PermissionError):
            pass
        try:
            child.wait(timeout=5)
            end=time.monotonic()+5
            while True:
                try:
                    os.killpg(child.pid,0)
                except ProcessLookupError:
                    break
                if time.monotonic()>=end:
                    raise RuntimeError('Read-only query process group disposal unconfirmed')
                time.sleep(.02)
        except BaseException as cleanup_error:
            cleanup_error.observation={**partial(),'processGroupRetired':False,'retirementError':type(cleanup_error).__name__,
                                       'queryFailure':type(primary).__name__ if primary else None}
            raise
        finally:
            selector.close();child.stdout.close();child.stderr.close()
    return child.returncode,bytes(output[child.stdout]).decode(),bytes(output[child.stderr]).decode()


def main():
    report={'formatVersion':1,'scope':'fixed-arch-read-only-boot-observation','ok':False,
            'installationVerified':False,'nativeQualification':False,'runtimeAdmission':False,
            'humanConsentProof':False,'nativeCpuPerformanceProof':False,'commands':[]}
    try:
        if len(sys.argv)!=6 or sys.argv[1]!='--observe' or not re.fullmatch('[a-f0-9]{64}',sys.argv[3]):
            raise ValueError('Fixed observation nonce, source and binding required')
        nonce,source,boot,manifest=sys.argv[2:]
        deadline=time.monotonic()+120
        spec=importlib.util.spec_from_file_location('fleur_owned_guest','/usr/local/lib/fleur-owned-guest.py')
        owned=importlib.util.module_from_spec(spec);sys.modules[spec.name]=owned;spec.loader.exec_module(owned)
        context=owned.validate(nonce,deadline=deadline)
        if context.boot_id!=boot or context.manifest_sha256!=manifest or context.os_release[0:2]!=('arch',None) or context.os_release[3]!='rolling':
            raise ValueError('Original Arch binding differs')
        raw,_=owned.protected_read('/usr/local/lib/fleur-arch-boot-observation.py',32768,0o444,deadline=deadline)
        if hashlib.sha256(raw).hexdigest()!=source:
            raise ValueError('Fixed observation source differs')
        report.update(binding=context.report(),sourceSha256=source,uid=os.getuid(),groups=os.getgroups(),kernel=os.uname().release)
        def observe(name,args,parse=None,expected=None):
            entry={'name':name,'command':args,'completed':False,'processGroupRetired':False}
            report['commands'].append(entry)
            try:
                context.verify(absolute_deadline=deadline)
                code,out,error=run(args,deadline)
                entry.update(exitCode=code,stdoutBytes=len(out.encode()),stderrBytes=len(error.encode()),
                    stdoutSha256=hashlib.sha256(out.encode()).hexdigest(),stderrSha256=hashlib.sha256(error.encode()).hexdigest(),
                    processGroupRetired=True,completed=True)
                context.verify(absolute_deadline=deadline)
            except BaseException as failure:
                entry.update(getattr(failure,'observation',{}))
                entry['errorType']=type(failure).__name__
                raise
            if expected is not None:
                entry['matchesExpected']=code==0 and not error and out in expected
                if entry['matchesExpected']:
                    entry['value']=out
            elif parse is not None:
                try:
                    entry['data']=parse(code,out,error)
                except (ValueError,TypeError,json.JSONDecodeError):
                    entry['parseComplete']=False
                else:
                    entry['parseComplete']=True
            return entry
        observe('package-inventory',['/usr/bin/pacman','--query'],lambda code,out,err:inventory(out) if code==0 and not err else (_ for _ in ()).throw(ValueError()))
        observe('pacman-version',['/usr/bin/pacman','--version'],backend_version)
        observe('runtime-packages',['/usr/bin/pacman','--query','--',*PACKAGES],known_packages)
        observe('database-check',['/usr/bin/pacman','--database','--check','--quiet'])
        for key,expected in [('RootDir',('/\n',)),('DBPath',('/var/lib/pacman/\n',)),('GPGDir',('/etc/pacman.d/gnupg/\n',)),
                             ('HookDir',('/etc/pacman.d/hooks/\n',)),('LocalFileSigLevel',('Optional\n','Optional TrustedOnly\n'))]:
            observe('pacman-conf-'+key,['/usr/bin/pacman-conf',key],expected=expected)
        def storage(code,out,error):
            if code!=0 or error:
                raise ValueError('Storage query failed')
            value=json.loads(out)
            if type(value) is not dict:
                raise ValueError('Storage query shape differs')
            return value
        observe('mounts',['/usr/bin/findmnt','--json','--bytes','--output','TARGET,SOURCE,FSTYPE,SIZE,AVAIL'],storage)
        observe('disks',['/usr/bin/lsblk','--json','--bytes','--output','NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS'],storage)
        for unit in ('docker.service','docker.socket','containerd.service','nftables.service'):
            observe('unit-'+unit,['/usr/bin/systemctl','show',unit,'--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,DropInPaths,Transient,MainPID'],service_fields)
        report['files']=[]
        for path in ('/etc/pacman.conf','/etc/nftables.conf','/usr/lib/systemd/system/nftables.service','/usr/bin/nft'):
            context.verify(absolute_deadline=deadline)
            entry={'path':path}
            try:
                data,identities=owned.protected_read(path,8*1024*1024,deadline=deadline)
                entry.update(state='protected-readable-file',sha256=hashlib.sha256(data).hexdigest(),bytes=len(data),identities=identities)
            except FileNotFoundError:
                entry['state']='not-found'
            except (OSError,ValueError):
                entry['state']='unknown'
            report['files'].append(entry)
            observe('owner-'+path,['/usr/bin/pacman','--query','--owns','--',path],lambda code,out,error,p=path:package_owner(p,code,out,error))
            context.verify(absolute_deadline=deadline)
        context.verify(absolute_deadline=deadline)
        report['custodyPreserved']=True;report['ok']=True
    except (OSError,ValueError,RuntimeError,TimeoutError,ImportError) as error:
        report['error']={'type':type(error).__name__,'message':str(error)}
    print(json.dumps(report,separators=(',',':')))
    return 0 if report['ok'] else 4


if __name__=='__main__':
    raise SystemExit(main())

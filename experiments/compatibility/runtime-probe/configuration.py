"""Inspect actual owned-worker configuration without disclosing unknown values."""
import json
import os
import secrets
import subprocess

OWNER_LABEL = 'fleur.compatibility.runtime-owner'
NATIVE_DATABASE_OWNER_LABEL = 'fleur.compatibility.native-database-owner'
CANARY_NAME = 'FLEUR_HOST_ONLY_CANARY'
SAFE_ENVIRONMENT = {
    'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin',
    'BUN_RUNTIME_TRANSPILER_CACHE_PATH':'0',
    'BUN_INSTALL_BIN':'/usr/local/bin',
    'GLIBC_TUNABLES':'glibc.pthread.rseq=0',
    'BUN_JSC_useConcurrentJIT':'0',
    'BUN_JSC_useConcurrentGC':'0',
    'BUN_JSC_numberOfGCMarkers':'1',
    'BUN_JSC_useWarmUpMarkedBlocks':'0',
}


def host_environment():
    # Host-only secret. It never becomes a Docker --env argument or report field.
    environment = dict(os.environ)
    environment[CANARY_NAME] = secrets.token_hex(32)
    return environment


def audit_configuration(metadata, owner, container, image_id, owner_label=OWNER_LABEL, *, kernel_private=False, kernel_proof=None):
    def require(condition, label):
        if not condition: raise ValueError('owned worker configuration rejected: '+label)
    require(owner_label in (OWNER_LABEL,NATIVE_DATABASE_OWNER_LABEL,'fleur.compatibility.vfs-owner'), 'owner-binding')
    require(type(image_id) is str and len(image_id) == 71 and image_id.startswith('sha256:') and
            all(character in '0123456789abcdef' for character in image_id[7:]), 'immutable-image')
    require(type(metadata) is dict, 'object')
    require(metadata.get('Name') == '/'+container and metadata.get('Image') == image_id, 'name-image-identity')
    container_id = metadata.get('Id')
    require(type(container_id) is str and len(container_id) == 64 and
            all(character in '0123456789abcdef' for character in container_id), 'immutable-container')
    config, host, state, network = (metadata.get(key) for key in ('Config','HostConfig','State','NetworkSettings'))
    require(all(type(item) is dict for item in (config,host,state,network)), 'required-fields')
    require(type(config.get('Labels')) is dict and config['Labels'].get(owner_label) == owner, 'ownership')
    require(config.get('Image') == image_id, 'configured-image-identity')
    require(config.get('User') == '65534:65534', 'unprivileged-user')
    require(host.get('ReadonlyRootfs') is True and host.get('Privileged') is False, 'readonly-unprivileged')
    require(host.get('CapDrop') == ['ALL'] and host.get('CapAdd') in (None,[]), 'capabilities')
    require(type(host.get('SecurityOpt')) is list and all(type(item) is str for item in host['SecurityOpt']) and sorted(host['SecurityOpt']) == ['no-new-privileges','seccomp=unconfined'], 'security-options')
    require(type(host.get('NanoCpus')) is int and host['NanoCpus'] == 1000000000, 'cpu-profile')
    require(type(host.get('Memory')) is int and host['Memory'] == 536870912 and
            type(host.get('MemorySwap')) is int and host['MemorySwap'] == 536870912 and
            type(host.get('PidsLimit')) is int and host['PidsLimit'] == 64, 'memory-pid-profile')
    require(host.get('NetworkMode') == 'none', 'network-mode')
    networks = network.get('Networks')
    if kernel_private:
        from kernel_network import valid_kernel_profile
        require(kernel_private is True and valid_kernel_profile(kernel_proof), 'kernel-network-proof')
        require(config.get('NetworkDisabled') is True and networks == {} and type(networks) is dict,
                'kernel-network-endpoints')
        require(all(network.get(key) == '' for key in ('SandboxID','SandboxKey','IPAddress','Gateway','GlobalIPv6Address','IPv6Gateway'))
                and type(network.get('Ports')) is dict and network['Ports'] == {}, 'kernel-network-addresses')
    else:
        require(config.get('NetworkDisabled') in (None,False), 'managed-network-mode')
        require(type(networks) is dict and set(networks) == {'none'} and type(networks['none']) is dict, 'network-endpoints')
        require(all(networks['none'].get(key) == '' for key in ('IPAddress','Gateway','GlobalIPv6Address','IPv6Gateway')), 'network-addresses')
    require(metadata.get('Mounts') == [] and all(host.get(key) in (None,[]) for key in
            ('Binds','Mounts','VolumesFrom','Devices','DeviceRequests')), 'mount-device-exclusion')
    require(host.get('PidMode') in ('','private') and host.get('IpcMode') in ('private','none'), 'private-namespaces')
    require(type(host.get('RestartPolicy')) is dict and host['RestartPolicy'].get('Name') == 'no', 'restart-policy')
    require(state.get('Running') is True, 'running-worker')
    require(type(state.get('Pid')) is int and 0 < state['Pid'] <= 2**31-1, 'init-host-pid')
    entries = config.get('Env')
    require(type(entries) is list and len(entries) == len(SAFE_ENVIRONMENT), 'environment-allowlist')
    admitted = {}
    for entry in entries:
        require(type(entry) is str and '=' in entry, 'environment-shape')
        key, value = entry.split('=',1)
        require(key in SAFE_ENVIRONMENT and key not in admitted and value == SAFE_ENVIRONMENT[key], 'environment-allowlist')
        admitted[key] = value
    require(set(admitted) == set(SAFE_ENVIRONMENT), 'environment-allowlist')
    # Only approved values, counts and names leave this boundary. Unknown Env,
    # mount, credential or network values are never included in an exception.
    return {'container_id':container_id,'host_init_pid':state['Pid'],'owned':True,'immutable_image':image_id,'user':'65534:65534','readonly_root':True,'privileged':False,
            'cap_drop':['ALL'],'cap_add':[],'no_new_privileges':True,'outer_seccomp':'unconfined',
            'cpu_nanocpus':host['NanoCpus'],'memory_bytes':host['Memory'],
            'memory_swap_bytes':host['MemorySwap'],'pids_limit':host['PidsLimit'],
            'network_mode':'none','kernel_network_isolated':kernel_private,'network_addresses_empty':True,'mount_count':0,'device_count':0,
            'glibc_rseq_registration':'disabled','experimental_helper_policy':'foreground-jit-single-gc-marker-no-block-warmup','environment_keys':sorted(admitted),'host_canary_absent':True,'running':True}


def inspect_worker_configuration(container, owner, image_id, owner_label=OWNER_LABEL, *, kernel_private=False, timeout=5):
    import time
    deadline=time.monotonic()+timeout
    result = subprocess.run(['docker','inspect','--format','{{json .}}',container],
                             capture_output=True,text=True,timeout=timeout,check=False)
    if result.returncode or len(result.stdout.encode('utf-8')) > 65536:
        raise RuntimeError('owned worker configuration inspection failed')
    try:
        metadata = json.loads(result.stdout)
    except ValueError:
        raise ValueError('owned worker configuration JSON invalid') from None
    proof=None
    if kernel_private:
        from kernel_network import inspect_kernel_profile
        if type(metadata) is not dict:raise ValueError('owned worker configuration JSON invalid')
        proof=inspect_kernel_profile(metadata.get('Id'),metadata.get('State',{}).get('Pid'),timeout=deadline-time.monotonic())
    return audit_configuration(metadata,owner,container,image_id,owner_label,
                               kernel_private=kernel_private,kernel_proof=proof)


CONTAINERD_BUILDS = {
    'v2.4.1':'f2551031d7276a770f65f98c9b52e57e7dad07e8',
    'v2.4.2':'b7a25261e029d68978bbf290df0a62fc819b3c51',
}

# Internal infrastructure identity audit only; not production runtime admission.
CONTROL_PROFILES = {
    'github-hosted': {'docker': ('28.0.4', '6430e49'), 'containerd': CONTAINERD_BUILDS,
                      'runc': ('1.5.2', 'v1.5.2-0-g29dd3dc2')},
    'owned-guest': {'docker': ('29.9.1', 'b26fb77'),
                    'containerd': {'v2.4.2': 'b7a25261e029d68978bbf290df0a62fc819b3c51'},
                    'runc': ('1.5.2', 'v1.5.2-0-g29dd3dc2')},
}


def _option(arguments, name):
    values = []
    for index,value in enumerate(arguments):
        if value == name:
            if index+1 >= len(arguments): raise ValueError('host daemon option invalid')
            values.append(arguments[index+1])
        elif value.startswith(name+'='): values.append(value[len(name)+1:])
    if len(values)>1: raise ValueError('host daemon option duplicated')
    return values[0] if values else None


class ContainerdControlUnverified(ValueError):
    def __init__(self, category, observations):
        self.category=category
        self.observations=dict(observations)
        super().__init__('host containerd prerequisite unverified ('+category+')')


def audit_containerd_control(arguments, config, server, ctr_detail, *, host_scope='github-hosted'):
    facts={}
    def require(condition,category):
        if not condition: raise ContainerdControlUnverified(category,facts)
    profile = CONTROL_PROFILES.get(host_scope) if type(host_scope) is str else None
    require(profile is not None, 'host-profile')
    require(type(arguments) is list and all(type(value) is str for value in arguments)
            and type(config) is dict and type(server) is dict,'input-shape')
    address = _option(arguments,'--containerd') or config.get('containerd')
    namespace = _option(arguments,'--containerd-namespace') or config.get('containerd-namespace','moby')
    facts.update(address_configured=type(address) is str and address.startswith('/'),namespace_moby=namespace=='moby')
    require(facts['address_configured'] and facts['namespace_moby'],'address-namespace')
    facts.update(docker_version_match=server.get('Version')==profile['docker'][0],docker_commit_match=server.get('GitCommit')==profile['docker'][1])
    require(facts['docker_version_match'] and facts['docker_commit_match'] and type(server.get('Components')) is list,'docker-version')
    components=[row for row in server['Components'] if type(row) is dict and row.get('Name')=='containerd']
    facts['containerd_component_count']=len(components)
    require(len(components)==1,'containerd-component')
    containerd_version=components[0].get('Version')
    containerd_commit=profile['containerd'].get(containerd_version) if type(containerd_version) is str else None
    facts.update(containerd_version_match=containerd_commit is not None,
                 containerd_commit_match=containerd_commit is not None and type(components[0].get('Details')) is dict
                 and components[0]['Details'].get('GitCommit')==containerd_commit)
    require(facts['containerd_version_match'] and facts['containerd_commit_match'],'containerd-version')
    runtimes=[row for row in server['Components'] if type(row) is dict and row.get('Name')=='runc']
    facts['runc_component_count']=len(runtimes)
    require(len(runtimes)==1,'runc-component')
    facts.update(runc_version_match=runtimes[0].get('Version')==profile['runc'][0],
                 runc_commit_match=type(runtimes[0].get('Details')) is dict and
                 runtimes[0]['Details'].get('GitCommit')==profile['runc'][1])
    require(facts['runc_version_match'] and facts['runc_commit_match'],'runc-version')
    require(type(ctr_detail) is str and len(ctr_detail.encode())<=65536,'ctr-version-detail')
    sections={};current=None
    for line in ctr_detail.splitlines():
        if not line.strip():continue
        if line in ('Client:','Server:'):
            require(line not in sections,'ctr-version-detail');current={};sections[line]=current;continue
        require(current is not None and ':' in line,'ctr-version-detail')
        key,value=line.strip().split(':',1);value=value.strip()
        require(key in ('Version','Revision','Go version','UUID') and key not in current,'ctr-version-detail')
        current[key]=value
    require(set(sections)=={'Client:','Server:'},'ctr-version-detail')
    for section,prefix in (('Client:','ctr-client'),('Server:','ctr-server')):
        facts[prefix+'_version_match']=sections[section].get('Version')==containerd_version
        facts[prefix+'_revision_match']=sections[section].get('Revision')==containerd_commit
        require(facts[prefix+'_version_match'],prefix+'-version')
        require(facts[prefix+'_revision_match'],prefix+'-revision')
    return {'ctr':'/usr/bin/ctr','address':address,'namespace':namespace,'docker_version':profile['docker'][0],'docker_commit':profile['docker'][1],
            'runc_version':profile['runc'][0],'runc_commit':profile['runc'][1],
            'containerd_version':containerd_version[1:],'containerd_commit':containerd_commit,'ctr_revision_verified':True,'version_evidence':'single-client-server-query',
            'prerequisite_observations':facts,
            'namespace_source':'explicit' if _option(arguments,'--containerd-namespace') or 'containerd-namespace' in config else 'pinned-default'}


def read_default_docker_control(socket_path, *, timeout):
    """Read two fixed Engine routes after the caller verifies root provenance."""
    import http.client
    import math
    from pathlib import Path
    import socket
    import stat
    import threading
    import time
    if type(timeout) not in (int,float) or not math.isfinite(timeout) or not 0<timeout<=15:
        raise ValueError('Docker preflight budget rejected')
    started=time.monotonic();deadline=started+timeout
    endpoint=Path(socket_path);directory=endpoint.parent
    phases={};category='docker-default-socket';root_fd=None
    def identity(info):return info.st_dev,info.st_ino,info.st_uid,info.st_gid,info.st_mode
    try:
        root_fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        directory_identity=identity(os.fstat(root_fd))
        entry=os.stat(endpoint.name,dir_fd=root_fd,follow_symlinks=False)
        if not stat.S_ISSOCK(entry.st_mode):raise ValueError('default Docker socket rejected')
        socket_identity=identity(entry)
        def verify_endpoint():
            if (identity(os.stat(directory,follow_symlinks=False))!=directory_identity or
                    identity(os.stat(endpoint.name,dir_fd=root_fd,follow_symlinks=False))!=socket_identity):
                raise ValueError('default Docker socket changed')
        results=[]
        for route,category in (('/v1.48/info','docker-default-info'),('/version','docker-default-version')):
            phase_started=time.monotonic();remaining=deadline-phase_started
            if remaining<=0:raise TimeoutError('Docker preflight deadline')
            verify_endpoint()
            connection=http.client.HTTPConnection('localhost',timeout=remaining)
            client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            retained=client.dup();connection.sock=client
            def expire():
                try:retained.shutdown(socket.SHUT_RDWR)
                except OSError:pass
            fence=threading.Timer(remaining,expire);fence.daemon=True
            raw=b'';status=None;response=None
            fence.start()
            try:
                client.settimeout(remaining);client.connect(str(endpoint));verify_endpoint()
                connection.request('GET',route,headers={'Connection':'close'})
                response=connection.getresponse();status=response.status;raw=response.read(65537)
                if status!=200 or len(raw)>65536:raise ValueError('Docker metadata response rejected')
                value=json.loads(raw.decode('utf-8'))
                if type(value) is not dict:raise ValueError('Docker metadata object required')
                verify_endpoint()
            finally:
                # The retained socket lets the deadline interrupt response/close
                # even after HTTPConnection has cleared its public socket field.
                try:
                    if response is not None:response.close()
                finally:
                    try:connection.close()
                    finally:fence.cancel();fence.join();retained.close()
                phases[category]=round(1000*(time.monotonic()-phase_started))
            verify_endpoint()
            if time.monotonic()>=deadline:raise TimeoutError('Docker preflight deadline')
            results.append(value)
        return results[0],results[1],phases
    except (OSError,ValueError,http.client.HTTPException) as error:
        raise ContainerdControlUnverified(category,{
            'duration_ms':round(1000*(time.monotonic()-started)),
            'timed_out':isinstance(error,TimeoutError) or time.monotonic()>=deadline,
            'response_bytes':len(raw) if 'raw' in locals() else 0,
            'http_status':status if 'status' in locals() else None,
            'docker_preflight_phases_ms':dict(phases)}) from None
    finally:
        if root_fd is not None:os.close(root_fd)


def inspect_containerd_control(*, probe_first_use=False, host_context=None, with_binding=False):
    """Linux CI host infrastructure only; no socket/privilege reaches a worker."""
    import hashlib
    from pathlib import Path
    import stat
    import time
    from host_control import authorize_host_control
    authority_started=time.monotonic()
    host_scope=authorize_host_control(host_context,remaining=15)
    def trusted(path, kind, socket=False):
        real=Path(path).resolve(strict=True);info=real.stat()
        if info.st_uid != 0 or info.st_mode & (0o002 if socket else 0o022) or not kind(info.st_mode):
            raise RuntimeError('containerd proof path ownership unverified')
        for parent in real.parents:
            value=parent.stat()
            if value.st_uid != 0 or value.st_mode & 0o022:
                raise RuntimeError('containerd proof ancestor ownership unverified')
        return real
    def command(args,environment=None,category='host-command',timeout=5):
        started=time.monotonic()
        if host_context is not None and args[0]=='/usr/bin/sudo':
            authorize_host_control(host_context,remaining=timeout)
            timeout-=time.monotonic()-started
            if timeout<=0:raise ContainerdControlUnverified(category,{'timed_out':True})
        try:
            result=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,timeout=timeout,
                                  env=environment,check=False)
        except subprocess.TimeoutExpired as error:
            raise ContainerdControlUnverified(category,{'timed_out':True,'duration_ms':round(1000*(time.monotonic()-started)),
                'stdout_bytes':len(error.output or b''),'stderr_bytes':len(error.stderr or b''),'cli_returncode':None}) from None
        if result.returncode or len(result.stdout)>65536 or len(result.stderr)>4096:
            raise ContainerdControlUnverified(category,{'duration_ms':round(1000*(time.monotonic()-started)),
                'cli_returncode':result.returncode,'stdout_bytes':len(result.stdout),'stderr_bytes':len(result.stderr)})
        return result.stdout.decode('utf-8')
    pidfile=trusted('/var/run/docker.pid',stat.S_ISREG)
    raw=pidfile.read_bytes()
    if len(raw)>16 or not raw.strip().isdigit(): raise RuntimeError('Docker host identity unverified')
    pid=int(raw.strip())
    if not 1<pid<=2**31-1 or Path(f'/proc/{pid}/comm').read_text() != 'dockerd\n':
        raise RuntimeError('Docker host identity unverified')
    if Path(f'/proc/{pid}').stat().st_uid != 0: raise RuntimeError('Docker host ownership unverified')
    data=Path(f'/proc/{pid}/cmdline').read_bytes()
    if len(data)>65536: raise RuntimeError('Docker host configuration exceeded bound')
    arguments=[part.decode('utf-8') for part in data.split(b'\0') if part]
    config_path=_option(arguments,'--config-file') or '/etc/docker/daemon.json'
    config={}
    if Path(config_path).exists():
        path=trusted(config_path,stat.S_ISREG)
        if path.stat().st_size>65536: raise RuntimeError('Docker host configuration exceeded bound')
        config=json.loads(path.read_text())
    docker_started=time.monotonic();docker_phases={}
    default_socket=trusted('/var/run/docker.sock',stat.S_ISSOCK,socket=True)
    def endpoint_identity(info):return [info.st_dev,info.st_ino,info.st_uid,info.st_gid,info.st_mode]
    state_endpoint={'path':str(default_socket),
                    'directory_identity':endpoint_identity(default_socket.parent.stat(follow_symlinks=False)),
                    'socket_identity':endpoint_identity(default_socket.stat(follow_symlinks=False))}

    try:
        remaining=15-(time.monotonic()-docker_started)
        if remaining<=0:raise ContainerdControlUnverified('docker-preflight-deadline',{'timed_out':True})
        default_info,server,docker_phases=read_default_docker_control(str(default_socket),timeout=remaining)
        default_id=default_info.get('ID')
        if type(default_id) is not str or not 0<len(default_id)<=256 or any(c.isspace() for c in default_id):
            raise ContainerdControlUnverified('docker-default-identity',{})
        remaining=15-(time.monotonic()-docker_started)
        if remaining<=0:raise ContainerdControlUnverified('docker-preflight-deadline',{'timed_out':True})
        active_started=time.monotonic()
        try:
            # Preserve the actual ambient context/host selection. An endpoint
            # string alone cannot prove this CLI reaches the default daemon.
            active_id=command(['docker','info','--format','{{.ID}}'],
                              category='docker-active-info',timeout=remaining)
        finally:docker_phases['docker-active-info']=round(1000*(time.monotonic()-active_started))
        if active_id!=default_id+'\n':raise ContainerdControlUnverified('docker-association',{})
        docker_elapsed=time.monotonic()-docker_started
        if docker_elapsed>=15:raise ContainerdControlUnverified('docker-preflight-deadline',{'timed_out':True})
    except ContainerdControlUnverified as error:
        prior=error.observations.get('docker_preflight_phases_ms',{})
        error.observations.update(docker_preflight_phases_ms={**docker_phases,**prior},
            docker_preflight_budget_seconds=15,duration_ms=round(1000*(time.monotonic()-docker_started)))
        raise
    ctr=trusted('/usr/bin/ctr',stat.S_ISREG)
    if type(config) is not dict: raise ContainerdControlUnverified('configuration-shape',{})
    address=_option(arguments,'--containerd') or config.get('containerd')
    namespace=_option(arguments,'--containerd-namespace') or config.get('containerd-namespace','moby')
    if type(address) is not str or not address.startswith('/') or namespace!='moby':
        raise ContainerdControlUnverified('address-namespace',{'address_configured':type(address) is str and address.startswith('/'),'namespace_moby':namespace=='moby'})
    trusted(address,stat.S_ISSOCK,socket=True)
    retained_binding=None
    if host_context is not None:
        from privileged_control import HostDaemonBinding, daemon_identity
        retained_binding=HostDaemonBinding(host_context,daemon_identity(address,'/usr/bin/ctr'),default_id)
    startup_started=time.monotonic()
    phases={}
    probes={}
    prefix=['/usr/bin/sudo','-n','/usr/bin/env','-i','PATH=/usr/bin:/bin:/usr/sbin:/sbin',
            'CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS=true','/usr/bin/timeout',
            '--signal=TERM','--kill-after=0.2s']
    environment={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'}
    def remaining_budget():
        remaining=15-(time.monotonic()-startup_started)
        if remaining<=1:
            raise ContainerdControlUnverified('ctr-startup-deadline',
                {'duration_ms':round(1000*(time.monotonic()-startup_started)),
                 'host_startup_budget_seconds':15,'host_startup_phases_ms':dict(phases),
                 'host_startup_probes':dict(probes)})
        return remaining
    if retained_binding is not None:
        from privileged_control import ROOT_BINDING_SOURCE
        root_version=ROOT_BINDING_SOURCE+"\nimport sys\npayload=sys.argv[1];binding=json.loads(sys.argv[2]);deadline=min(float(sys.argv[3]),json.loads(payload)['deadlineMonotonic'])\nverify_root_binding(payload,binding,deadline)\nleft=math.floor((deadline-time.monotonic())*1000)/1000\nif left<=1:raise ValueError('root version budget expired')\nos.execv('/usr/bin/timeout',['/usr/bin/timeout','--signal=TERM','--kill-after=1s',str(left-1)+'s',*sys.argv[5:]])\n"
        prefix=['/usr/bin/sudo','-n','/usr/bin/python3','-I','-c',root_version,*retained_binding.root_arguments(authority_started+15),str(authority_started+15)]
    if probe_first_use:
        # Diagnostic benchmark only: isolate sudo/session startup, then cold ctr
        # loading without any server RPC. Each still consumes the same 15s fence.
        trusted('/usr/bin/true',stat.S_ISREG)
        for phase,arguments_to_run in [('privileged_noop',['/usr/bin/true']),
                                       ('ctr_banner',[str(ctr),'--version'])]:
            remaining=min(5,remaining_budget())
            started=time.monotonic()
            try:
                output=command(prefix+[str(remaining-1)+'s']+arguments_to_run,environment,
                               category=phase,timeout=remaining)
                probes[phase]={'passed':True,'timed_out':False,'cli_returncode':0,
                               'stdout_bytes':len(output.encode('utf-8'))}
            except ContainerdControlUnverified as error:
                probes[phase]={'passed':False,**error.observations,
                               'timed_out':error.observations.get('timed_out') is True or
                                           error.observations.get('cli_returncode')==124}
            except (OSError,UnicodeError):
                probes[phase]={'passed':False,'timed_out':False,'cli_returncode':None,
                               'launch_or_encoding_failed':True}
            phases[phase]=round(1000*(time.monotonic()-started))
            probes[phase]['duration_ms']=phases[phase]
    version_started=time.monotonic()
    remaining=remaining_budget() if probe_first_use else 15
    if host_context is not None:
        remaining=min(remaining,15-(time.monotonic()-authority_started))
        authorize_host_control(host_context,remaining=remaining)
        remaining=min(remaining,15-(time.monotonic()-authority_started))
        if remaining<=1:raise ContainerdControlUnverified('ctr-startup-deadline',{'timed_out':True})
    inner_timeout=str(remaining-1)+'s' if probe_first_use or host_context is not None else '14s'
    version_completed=None
    try:
        detail=command(prefix+[inner_timeout,str(ctr),'--address',address,'--namespace',namespace,'version'],
                       environment,category='ctr-version-command',timeout=remaining)
        version_completed=time.monotonic()
        control=audit_containerd_control(arguments,config,server,detail,host_scope=host_scope)
    except ContainerdControlUnverified as error:
        failure_observed=time.monotonic()
        completed=version_completed if version_completed is not None else failure_observed
        failed_phases={**phases,'authoritative_version':round(1000*(completed-version_started))}
        if version_completed is not None:failed_phases['identity_audit']=round(1000*(failure_observed-version_completed))
        error.observations.update(host_startup_phases_ms=failed_phases,host_startup_probes=dict(probes))
        raise
    audit_completed=time.monotonic()
    binary_sha256=hashlib.sha256(ctr.read_bytes()).hexdigest()
    hash_completed=time.monotonic()
    if (endpoint_identity(default_socket.parent.stat(follow_symlinks=False))!=state_endpoint['directory_identity']
            or endpoint_identity(default_socket.stat(follow_symlinks=False))!=state_endpoint['socket_identity']):
        raise ContainerdControlUnverified('docker-default-endpoint-changed',{})
    control['_docker_state_endpoint']=state_endpoint
    control.update({'ctr_binary_sha256':binary_sha256,
                    'ctr_root_owned':True,'socket_root_owned':True,'docker_association_verified':True,
                    'docker_default_socket_verified':True,'docker_preflight_source':'verified-unix-api-and-active-cli',
                    'docker_preflight_budget_seconds':15,'docker_preflight_duration_ms':round(1000*docker_elapsed),
                    'docker_preflight_phases_ms':docker_phases,
                    'host_access':'privileged-owned-registration-and-events','worker_authority_changed':False})
    elapsed=time.monotonic()-startup_started
    if elapsed>=15:
        raise ContainerdControlUnverified('ctr-startup-deadline',{'duration_ms':round(1000*elapsed),'host_startup_budget_seconds':15,
            'host_startup_phases_ms':{**phases,'authoritative_version':round(1000*(version_completed-version_started)),
                                      'identity_audit':round(1000*(audit_completed-version_completed)),
                                      'binary_sha256':round(1000*(hash_completed-audit_completed))},
            'host_startup_probes':dict(probes)})
    control.update(host_startup_budget_seconds=15,host_startup_duration_ms=round(1000*elapsed),
                   host_version_duration_ms=round(1000*(version_completed-version_started)),
                   first_version_preceded_by_startup_probes=probe_first_use,host_startup_probes=probes,
                   host_startup_phases_ms={**phases,'authoritative_version':round(1000*(version_completed-version_started)),
                                          'identity_audit':round(1000*(audit_completed-version_completed)),
                                          'binary_sha256':round(1000*(hash_completed-audit_completed))},
                   optional_deprecation_rpc=False)
    if with_binding:
        return control,retained_binding
    return control

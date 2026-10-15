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
}


def host_environment():
    # Host-only secret. It never becomes a Docker --env argument or report field.
    environment = dict(os.environ)
    environment[CANARY_NAME] = secrets.token_hex(32)
    return environment


def audit_configuration(metadata, owner, container, image_id, owner_label=OWNER_LABEL):
    def require(condition, label):
        if not condition: raise ValueError('owned worker configuration rejected: '+label)
    require(owner_label in (OWNER_LABEL,NATIVE_DATABASE_OWNER_LABEL), 'owner-binding')
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
            'network_mode':'none','network_addresses_empty':True,'mount_count':0,'device_count':0,
            'glibc_rseq_registration':'disabled','environment_keys':sorted(admitted),'host_canary_absent':True,'running':True}


def inspect_worker_configuration(container, owner, image_id, owner_label=OWNER_LABEL):
    result = subprocess.run(['docker','inspect','--format','{{json .}}',container],
                             capture_output=True,text=True,timeout=5,check=False)
    if result.returncode or len(result.stdout.encode('utf-8')) > 65536:
        raise RuntimeError('owned worker configuration inspection failed')
    try:
        metadata = json.loads(result.stdout)
    except ValueError:
        raise ValueError('owned worker configuration JSON invalid') from None
    return audit_configuration(metadata,owner,container,image_id,owner_label)


CONTAINERD_COMMIT = 'f2551031d7276a770f65f98c9b52e57e7dad07e8'


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


def audit_containerd_control(arguments, config, server, ctr_detail):
    facts={}
    def require(condition,category):
        if not condition: raise ContainerdControlUnverified(category,facts)
    require(type(arguments) is list and all(type(value) is str for value in arguments)
            and type(config) is dict and type(server) is dict,'input-shape')
    address = _option(arguments,'--containerd') or config.get('containerd')
    namespace = _option(arguments,'--containerd-namespace') or config.get('containerd-namespace','moby')
    facts.update(address_configured=type(address) is str and address.startswith('/'),namespace_moby=namespace=='moby')
    require(facts['address_configured'] and facts['namespace_moby'],'address-namespace')
    facts.update(docker_version_match=server.get('Version')=='28.0.4',docker_commit_match=server.get('GitCommit')=='6430e49')
    require(facts['docker_version_match'] and facts['docker_commit_match'] and type(server.get('Components')) is list,'docker-version')
    components=[row for row in server['Components'] if type(row) is dict and row.get('Name')=='containerd']
    facts['containerd_component_count']=len(components)
    require(len(components)==1,'containerd-component')
    facts.update(containerd_version_match=components[0].get('Version')=='v2.4.1',containerd_commit_match=type(components[0].get('Details')) is dict and components[0]['Details'].get('GitCommit')==CONTAINERD_COMMIT)
    require(facts['containerd_version_match'] and facts['containerd_commit_match'],'containerd-version')
    runtimes=[row for row in server['Components'] if type(row) is dict and row.get('Name')=='runc']
    facts['runc_component_count']=len(runtimes)
    require(len(runtimes)==1,'runc-component')
    facts.update(runc_version_match=runtimes[0].get('Version')=='1.5.2',
                 runc_commit_match=type(runtimes[0].get('Details')) is dict and
                 runtimes[0]['Details'].get('GitCommit')=='v1.5.2-0-g29dd3dc2')
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
        facts[prefix+'_version_match']=sections[section].get('Version')=='v2.4.1'
        facts[prefix+'_revision_match']=sections[section].get('Revision')==CONTAINERD_COMMIT
        require(facts[prefix+'_version_match'],prefix+'-version')
        require(facts[prefix+'_revision_match'],prefix+'-revision')
    return {'ctr':'/usr/bin/ctr','address':address,'namespace':namespace,'docker_version':'28.0.4','docker_commit':'6430e49',
            'runc_version':'1.5.2','runc_commit':'v1.5.2-0-g29dd3dc2',
            'containerd_version':'2.4.1','containerd_commit':CONTAINERD_COMMIT,'ctr_revision_verified':True,'version_evidence':'single-client-server-query',
            'prerequisite_observations':facts,
            'namespace_source':'explicit' if _option(arguments,'--containerd-namespace') or 'containerd-namespace' in config else 'pinned-default'}


def inspect_containerd_control():
    """Linux CI host infrastructure only; no socket/privilege reaches a worker."""
    import hashlib
    from pathlib import Path
    import stat
    import time
    from daemon_trace import eligible_host
    if not eligible_host(): raise RuntimeError('containerd proof host ineligible')
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
    environment=dict(os.environ)
    for key in ('DOCKER_CONTEXT','DOCKER_HOST','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_API_VERSION'):
        environment.pop(key,None)
    default_id=command(['docker','--host','unix:///var/run/docker.sock','info','--format','{{.ID}}'],environment)
    active_id=command(['docker','info','--format','{{.ID}}'])
    if not default_id.strip() or default_id!=active_id: raise RuntimeError('Docker host association unverified')
    server=json.loads(command(['docker','--host','unix:///var/run/docker.sock','version','--format','{{json .Server}}'],environment))
    ctr=trusted('/usr/bin/ctr',stat.S_ISREG)
    if type(config) is not dict: raise ContainerdControlUnverified('configuration-shape',{})
    address=_option(arguments,'--containerd') or config.get('containerd')
    namespace=_option(arguments,'--containerd-namespace') or config.get('containerd-namespace','moby')
    if type(address) is not str or not address.startswith('/') or namespace!='moby':
        raise ContainerdControlUnverified('address-namespace',{'address_configured':type(address) is str and address.startswith('/'),'namespace_moby':namespace=='moby'})
    trusted(address,stat.S_ISSOCK,socket=True)
    version_started=time.monotonic()
    detail=command(['/usr/bin/sudo','-n','/usr/bin/env','-i','PATH=/usr/bin:/bin:/usr/sbin:/sbin','CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS=true','/usr/bin/timeout','--signal=TERM','--kill-after=0.2s','14s',str(ctr),'--address',address,'--namespace',namespace,'version'],{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},category='ctr-version-command',timeout=15)
    control=audit_containerd_control(arguments,config,server,detail)
    control.update({'ctr_binary_sha256':hashlib.sha256(ctr.read_bytes()).hexdigest(),
                    'ctr_root_owned':True,'socket_root_owned':True,'docker_association_verified':True,
                    'host_access':'privileged-owned-registration-and-events','worker_authority_changed':False})
    elapsed=time.monotonic()-version_started
    if elapsed>=15:
        raise ContainerdControlUnverified('ctr-startup-deadline',{'duration_ms':round(1000*elapsed),'host_startup_budget_seconds':15})
    control.update(host_startup_budget_seconds=15,host_version_duration_ms=round(1000*elapsed),
                   optional_deprecation_rpc=False)
    return control

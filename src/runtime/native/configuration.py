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
    require(config.get('Entrypoint') == ['bun', '/probe/bootstrap.js'] and config.get('Cmd') in (None, [])
            and config.get('WorkingDir') == '/probe' and config.get('Volumes') in (None, {}), 'fixed-bootstrap')
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

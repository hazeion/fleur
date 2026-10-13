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
    return {'owned':True,'immutable_image':image_id,'user':'65534:65534','readonly_root':True,'privileged':False,
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

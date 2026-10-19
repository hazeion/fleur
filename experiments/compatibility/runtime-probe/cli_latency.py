"""Bounded host-only ctr timings; never forwards host authority to a worker."""
import json
import subprocess
import time

HOST_PATH='/usr/bin:/bin:/usr/sbin:/sbin'


def measure_command(command, *, timeout=5, validate=None):
    """Measure a fixed diagnostic command and emit only numeric/status facts."""
    started=time.monotonic()
    try:
        result=subprocess.run(command,stdin=subprocess.DEVNULL,capture_output=True,
                              env={'PATH':HOST_PATH},timeout=timeout,check=False)
        stdout_bytes=len(result.stdout);stderr_bytes=len(result.stderr)
        output_valid=True
        if validate is not None:
            try:validate(result.stdout)
            except (ValueError,UnicodeError):output_valid=False
        elapsed=time.monotonic()-started
        return {'duration_ms':round(1000*elapsed),'returncode':result.returncode,
                'timed_out':result.returncode==124,'stdout_bytes':stdout_bytes,'stderr_bytes':stderr_bytes,
                'passed':result.returncode==0 and output_valid and elapsed<timeout and stdout_bytes<=65536 and stderr_bytes<=4096}
    except subprocess.TimeoutExpired as error:
        # subprocess.run kills and waits for its direct child. Native invocations
        # additionally use a root-owned inner timeout to retire privileged ctr.
        return {'duration_ms':round(1000*(time.monotonic()-started)),'returncode':None,
                'timed_out':True,'stdout_bytes':len(error.output or b''),
                'stderr_bytes':len(error.stderr or b''),'passed':False}


def compare_host_cli(control):
    """Call only after inspect_containerd_control verifies native host provenance."""
    from configuration import audit_containerd_control
    def validate_version(output):
        # These Docker facts came from the immediately preceding verified host
        # inspection; every sample must still return both pinned ctr revisions.
        server={'Version':control['docker_version'],'GitCommit':control['docker_commit'],
                'Components':[{'Name':'containerd','Version':'v'+control['containerd_version'],
                               'Details':{'GitCommit':control['containerd_commit']}},
                              {'Name':'runc','Version':control['runc_version'],
                               'Details':{'GitCommit':control['runc_commit']}}]}
        audit_containerd_control(['dockerd','--containerd='+control['address']],
                                 {'containerd-namespace':control['namespace']},server,output.decode('utf-8'))
    rows=[]
    # Interleave repeated settings so a warm executable is not confused with
    # removal of the optional RPC. The first measured preflight remains in JSON.
    settings=[('banner',True),('version',False),('version',True),('version',True),('version',False)]
    for operation,suppressed in settings:
        environment=['/usr/bin/env','-i','PATH='+HOST_PATH]
        if suppressed:environment.append('CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS=true')
        command=['/usr/bin/sudo','-n',*environment,'/usr/bin/timeout',
                 '--signal=TERM','--kill-after=0.2s','4s',control['ctr']]
        if operation=='banner':command.append('--version')
        else:command.extend(['--address',control['address'],'--namespace',control['namespace'],'version'])
        result=measure_command(command,validate=validate_version if operation=='version' else None)
        rows.append({'operation':operation,'optional_deprecation_rpc':not suppressed,**result})
    return {'schema_version':1,'scope':'native-host-ctr-startup',
            'first_authoritative_version_ms':control['host_version_duration_ms'],
            'host_startup_duration_ms':control['host_startup_duration_ms'],
            'host_startup_phases_ms':control['host_startup_phases_ms'],
            'host_startup_probes':control.get('host_startup_probes',{}),
            'first_version_preceded_by_startup_probes':control['first_version_preceded_by_startup_probes'],
            'host_startup_budget_seconds':control['host_startup_budget_seconds'],
            'docker_preflight_duration_ms':control.get('docker_preflight_duration_ms'),
            'docker_preflight_phases_ms':control.get('docker_preflight_phases_ms',{}),
            'docker_preflight_budget_seconds':control.get('docker_preflight_budget_seconds'),
            'ctr_revision_verified':control['ctr_revision_verified'],
            'containerd_version':control['containerd_version'],'containerd_commit':control['containerd_commit'],
            'docker_version':control['docker_version'],'docker_commit':control['docker_commit'],
            'runc_version':control['runc_version'],'runc_commit':control['runc_commit'],
            'sample_command_budget_seconds':5,'samples':rows,
            'baseline_comparable':all(row['passed'] for row in rows if row['operation']=='version'),
            'passed':all(row['passed'] for row in rows if row['operation']=='version' and not row['optional_deprecation_rpc']),
            'worker_authority_changed':False}



def safe_failure_observations(observations):
    """Only bounded numeric/status fields from owned diagnostics leave the host."""
    def counts(value):
        if type(value) is not dict:return {}
        safe={}
        for name in ('duration_ms','stdout_bytes','stderr_bytes','response_bytes','http_status','host_startup_budget_seconds','docker_preflight_budget_seconds','cli_returncode'):
            entry=value.get(name)
            if type(entry) is int and (-2147483648 if name=='cli_returncode' else 0)<=entry<=2147483647:safe[name]=entry
            elif name in ('cli_returncode','http_status') and name in value and entry is None:safe[name]=None
        for name in ('passed','timed_out','launch_or_encoding_failed'):
            if type(value.get(name)) is bool:safe[name]=value[name]
        return safe
    result=counts(observations)
    if type(observations) is not dict:return result
    phases=observations.get('host_startup_phases_ms')
    if type(phases) is dict:
        result['host_startup_phases_ms']={name:phases[name] for name in
            ('privileged_noop','ctr_banner','authoritative_version','identity_audit','binary_sha256')
            if type(phases.get(name)) is int and 0<=phases[name]<=2147483647}
    docker_phases=observations.get('docker_preflight_phases_ms')
    if type(docker_phases) is dict:
        result['docker_preflight_phases_ms']={name:docker_phases[name] for name in
            ('docker-default-info','docker-default-version','docker-active-info')
            if type(docker_phases.get(name)) is int and 0<=docker_phases[name]<=2147483647}
    probes=observations.get('host_startup_probes')
    if type(probes) is dict:
        result['host_startup_probes']={name:counts(probes[name]) for name in
            ('privileged_noop','ctr_banner') if type(probes.get(name)) is dict}
    return result


def main():
    from configuration import inspect_containerd_control, ContainerdControlUnverified
    try:
        report=compare_host_cli(inspect_containerd_control(probe_first_use=True))
    except Exception as error:
        # Raw CLI/configuration errors can contain local paths or credentials.
        report={'schema_version':1,'scope':'native-host-ctr-startup','passed':False,
                'failure_category':error.category if isinstance(error,ContainerdControlUnverified) else 'host-startup-unverified',
                'failure_observations':safe_failure_observations(getattr(error,'observations',{}))}
    print(json.dumps(report,sort_keys=True))
    return 0 if report['passed'] else 1


if __name__=='__main__':raise SystemExit(main())

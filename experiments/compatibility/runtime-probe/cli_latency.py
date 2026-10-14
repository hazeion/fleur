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
                               'Details':{'GitCommit':control['containerd_commit']}}]}
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
            'host_startup_budget_seconds':control['host_startup_budget_seconds'],
            'ctr_revision_verified':control['ctr_revision_verified'],
            'containerd_version':control['containerd_version'],'containerd_commit':control['containerd_commit'],
            'sample_command_budget_seconds':5,'samples':rows,
            'baseline_comparable':all(row['passed'] for row in rows if row['operation']=='version'),
            'passed':all(row['passed'] for row in rows if row['operation']=='version' and not row['optional_deprecation_rpc']),
            'worker_authority_changed':False}


def main():
    from configuration import inspect_containerd_control
    try:
        report=compare_host_cli(inspect_containerd_control())
    except Exception as error:
        # Raw CLI/configuration errors can contain local paths or credentials.
        report={'schema_version':1,'scope':'native-host-ctr-startup','passed':False,
                'failure_category':getattr(error,'category','host-startup-unverified')}
    print(json.dumps(report,sort_keys=True))
    return 0 if report['passed'] else 1


if __name__=='__main__':raise SystemExit(main())

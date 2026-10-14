#!/usr/bin/env python3
"""Disposable native amd64/arm64 Linux experiment. Exit 0 accepts only bounded evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import time
from report import accept, accept_threads, CONTROLS
from runtime_profile import select_profile, native_elf_identity
from protocol import run_container, StartupAuditRejected
from resources import accept_resources
from diagnostics import snapshot_worker
from configuration import inspect_worker_configuration, host_environment, OWNER_LABEL, inspect_containerd_control, ContainerdControlUnverified
from lifecycle import run_lifecycle
from descriptor_audit import inspect_event_inventory
from completion import CompletionUnverified
from waiter import OwnedWaiter, WaitUnverified
from containerd_observer import ObserverUnverified
from daemon_trace import capture_daemon_trace

HERE = Path(__file__).resolve().parent
REPORT = {'scope': 'bounded-pre-application-tsync-render', 'v1_gate_passed': False,
          'expected_bun': '1.4.3', 'expected_gcc': '13.3.0'}


def command(args, timeout=30, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                            timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f'{args[0]} exited {result.returncode}: '
                           + (result.stdout + result.stderr)[-3000:])
    return result.stdout.strip()


def main(architecture=None, trusted_build_network=None, healthy_containerd_exit=False):
    tag = 'fleur-runtime-probe-' + str(time.time_ns())
    container = tag + '-run'
    result_code = 1
    build_started = False
    build_finished = False
    run_started = False
    resource_containers = []
    worker_environment = host_environment()
    try:
        if trusted_build_network not in (None,'host'): raise ValueError('trusted build network invalid')
        REPORT['trusted_build_network'] = trusted_build_network or 'default'
        architecture, selected = select_profile(architecture, platform.system(), platform.machine())
        base = selected['base']
        expected_compiler = selected['compiler_sha256']
        REPORT.update({'architecture':architecture, 'base_image':base,
                       'expected_gcc_binary_sha256':expected_compiler,
                       'compiler_status':'executed-pin',
                       'compiler_pin_verified':False})
        if type(expected_compiler) is not str or len(expected_compiler) != 64 or any(
                character not in '0123456789abcdef' for character in expected_compiler):
            raise RuntimeError('native compiler profile lacks an executed SHA-256 pin')
        compiler = shutil.which('gcc')
        if compiler is None:
            raise RuntimeError('gcc prerequisite missing; nothing installed')
        version = command([compiler, '-dumpfullversion'])
        REPORT['gcc'] = {'target': command([compiler, '-dumpmachine']), 'version': command([compiler, '--version']),
                         'binary_sha256': hashlib.sha256(Path(compiler).read_bytes()).hexdigest()}
        if REPORT['gcc']['target'] != selected['compiler_target']:
            raise RuntimeError('compiler target differs from native architecture')
        if REPORT['gcc']['binary_sha256'] != expected_compiler:
            raise RuntimeError('compiler binary differs from executed GCC pin')
        if version != REPORT['expected_gcc']:
            raise RuntimeError(f'compiler candidate mismatch: {version}')
        REPORT['compiler_pin_verified'] = True
        REPORT['source_sha256'] = {name:hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                                  for name in ('filter.c','abuse.c','bootstrap.ts','application.js',
                                               'protocol.py','report.py','runtime_profile.py','run.py','resources.py','threads.py','diagnostics.py','configuration.py','lifecycle.py','busy-application.js','descriptor_audit.py','completion.py','waiter.py','daemon_trace.py','containerd_observer.py')}
        REPORT['host'] = {'kernel': platform.release(),
                          'os_release': Path('/etc/os-release').read_text(),
                          'docker': command(['docker', 'version', '--format', '{{json .}}'])}
        with tempfile.TemporaryDirectory(prefix='fleur-runtime-probe-') as directory:
            context = Path(directory)
            for name in ('bootstrap.ts', 'application.js', 'busy-application.js'):
                shutil.copyfile(HERE / name, context / name)
            (context / 'profile.json').write_text(json.dumps({'architecture':architecture,
                                                             'negative_controls':CONTROLS[architecture]}))
            dependencies = HERE.parent / 'rendering'
            for name in ('package.json', 'bun.lock'):
                shutil.copyfile(dependencies / name, context / name)
            command([compiler, '-shared', '-fPIC', '-O2', '-std=c11', '-Wall', '-Wextra',
                     '-Werror', '-pthread', str(HERE / 'filter.c'), '-o', str(context / 'filter.so')])
            command([compiler, '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-pthread',
                     str(HERE / 'abuse.c'), '-o', str(context / 'abuse')])
            REPORT['helper_elf'] = native_elf_identity((context / 'filter.so').read_bytes()[:64], architecture)
            REPORT['abuse_elf'] = native_elf_identity((context / 'abuse').read_bytes()[:64], architecture)
            REPORT['abuse_sha256'] = hashlib.sha256((context / 'abuse').read_bytes()).hexdigest()
            REPORT['helper_sha256'] = hashlib.sha256((context / 'filter.so').read_bytes()).hexdigest()
            (context / 'Dockerfile').write_text(f'''FROM {base} AS prepare
WORKDIR /probe
COPY package.json bun.lock ./
RUN test "$(bun --version)" = "1.4.3" && bun install --production --frozen-lockfile
COPY bootstrap.ts ./
RUN bun build bootstrap.ts --target=bun --outfile=bootstrap.js
FROM {base}
WORKDIR /probe
COPY --from=prepare /probe/bootstrap.js ./
COPY filter.so application.js busy-application.js abuse profile.json ./
ENV GLIBC_TUNABLES=glibc.pthread.rseq=0
USER 65534:65534
ENTRYPOINT ["bun", "/probe/bootstrap.js"]
''')
            build_started = True
            command(['docker', 'build', *(['--network=host'] if trusted_build_network == 'host' else []), '--platform', 'linux/' + architecture, '-t', tag, str(context)], timeout=240)
            build_finished = True
            REPORT['image_architecture'] = command(['docker','image','inspect',tag,'--format','{{.Architecture}}'])
            if REPORT['image_architecture'] != architecture:
                raise RuntimeError('built Docker image architecture differs from native runner')
            REPORT['image_id'] = command(['docker', 'image', 'inspect', tag, '--format', '{{.Id}}'])
            run_started = True
            def audited_worker(name,owner,inventory):
                configuration = inspect_worker_configuration(name,owner,REPORT['image_id'])
                snapshot = snapshot_worker(name)
                rows = [{key:row[key] for key in ('pid','no_new_privs','seccomp','seccomp_filters')}
                        for row in snapshot['tasks']]
                if not accept_threads(rows):
                    raise RuntimeError('existing thread lacks the sole native restriction filter')
                descriptors = inspect_event_inventory(name,inventory)
                return {'host_threads':rows,'configuration_verified':True,'configuration':configuration,
                        'snapshot':snapshot,'descriptor_audit':descriptors}
            def startup_worker(inventory):
                audited = audited_worker(container,tag,inventory)
                REPORT['worker_configuration'] = audited['configuration']
                REPORT['host_pause_diagnostics'] = audited['snapshot']
                REPORT['host_threads'] = audited['host_threads']
                REPORT['worker_descriptors'] = audited['descriptor_audit']
                return audited['descriptor_audit']
            def completed_worker(frame,remaining):
                if ('host_threads' in frame or 'cleanup_complete' in frame
                        or not accept(dict(frame,host_threads=REPORT.get('host_threads'),cleanup_complete=True),architecture)
                        or frame.get('host_canary_absent') is not True):
                    raise RuntimeError('completed worker evidence invalid')
                return {'completed':True,'exit_code':0}
            def start_waiter(remaining):
                return OwnedWaiter(REPORT['worker_configuration']['container_id'],timeout=remaining)
            REPORT['worker_protocol'] = {}
            output = run_container(['docker', 'run', '-i', '--name', container, '--label', OWNER_LABEL+'='+tag, '--network=none',
                              '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                              '--security-opt=seccomp=unconfined', '--cpus=1', '--memory=512m',
                              '--memory-swap=512m', '--pids-limit=64', '--ulimit=core=0', '--pull=never', REPORT['image_id']], timeout=30, startup_audit=startup_worker, diagnostics=REPORT['worker_protocol'], environment=worker_environment, completion_observer=completed_worker,completion_start=start_waiter,completion_stall=capture_daemon_trace)
            if len(output) > 16384:
                raise RuntimeError('probe output exceeded bound')
            # Retain successful native evidence even if a later resource probe fails.
            REPORT['evidence'] = json.loads(output)
            evidence = REPORT['evidence']
            if isinstance(evidence, dict):
                evidence['host_threads'] = REPORT.get('host_threads')
                if evidence.get('host_canary_absent') is not True:
                    raise RuntimeError('restricted worker host canary exclusion failed')
            if not isinstance(evidence, dict) or not accept(dict(evidence, cleanup_complete=True), architecture):
                raise RuntimeError('incomplete, malformed or failed bounded runtime evidence')
            resources = {}
            REPORT['trusted_cgroup_abuse'] = resources
            for mode in ('cpu', 'memory', 'pids'):
                resource_name = tag + '-' + mode
                resource_containers.append(resource_name)
                abuse = subprocess.run(['docker', 'run', '--name', resource_name,
                    '--network=none', '--read-only', '--cap-drop=ALL',
                    '--security-opt=no-new-privileges', '--security-opt=seccomp=unconfined',
                    '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=64',
                    '--ulimit=core=0', '--pull=never', '--entrypoint=/probe/abuse',
                    REPORT['image_id'], mode], capture_output=True, text=True, timeout=15)
                if mode == 'memory':
                    state = json.loads(command(['docker', 'inspect', resource_name,
                                                '--format', '{{json .State}}']))
                    resources[mode] = {'container_exit': abuse.returncode,
                                       'docker_oom_killed': state.get('OOMKilled')}
                    if not abuse.stdout.strip() or len(abuse.stdout.encode('utf-8')) > 4096:
                        raise RuntimeError('native memory monitor output missing or exceeded bound')
                    monitor = json.loads(abuse.stdout)
                    if not isinstance(monitor, dict) or set(monitor) != {
                            'child_signal', 'oom_events_delta', 'oom_kill_delta',
                            'memory_max', 'swap_max'}:
                        raise RuntimeError('native memory monitor fields invalid')
                    resources[mode].update(monitor)
                else:
                    if abuse.returncode or len(abuse.stdout) > 4096:
                        raise RuntimeError('trusted cgroup ' + mode + ' experiment failed')
                    resources[mode] = json.loads(abuse.stdout)
            REPORT['trusted_cgroup_abuse'] = resources
            if not accept_resources(resources):
                raise RuntimeError('missing controlled cgroup enforcement evidence')
            control = inspect_containerd_control() if healthy_containerd_exit else None
            if control is not None: REPORT['host_containerd_control'] = control
            REPORT['healthy_exit_evidence'] = 'containerd-init-exit' if control is not None else 'startup-bound-docker-wait'
            REPORT['restricted_worker_lifecycle'] = run_lifecycle(
                REPORT['image_id'],tag,architecture,worker_environment,audited_worker,timeout=30,containerd_control=control)
            negative_name = tag+'-event-replacement'
            resource_containers.append(negative_name)
            negative_diagnostics = {}
            def replacement_audit(inventory):
                audited = audited_worker(negative_name,tag,inventory)
                REPORT['event_replacement_audit'] = audited['descriptor_audit']
                return audited['descriptor_audit']
            try:
                run_container(['docker','run','-i','--name',negative_name,'--label',OWNER_LABEL+'='+tag,
                    '--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
                    '--security-opt=seccomp=unconfined','--cpus=1','--memory=512m','--memory-swap=512m',
                    '--pids-limit=64','--ulimit=core=0','--pull=never',REPORT['image_id'],'event-replacement'],
                    startup_audit=replacement_audit,environment=worker_environment,diagnostics=negative_diagnostics,timeout=30)
            except StartupAuditRejected as rejected:
                stderr = negative_diagnostics.get('stderr','')
                if (rejected.category != 'class-mismatch' or '[compat-event] replacement-fd=' not in stderr
                        or '[compat-event] startup-approved' in stderr or '[compat-event] result=' in stderr
                        or '[DEBUG-runtime] eval-compile-start' in stderr):
                    raise RuntimeError('controlled descriptor replacement failed the expected pre-application rejection')
                REPORT['event_replacement_negative'] = {'passed':True,'category':'class-mismatch',
                    'application_evaluated':False,'event_probe_executed':False,'startup_acknowledged':False}
            else:
                raise RuntimeError('controlled descriptor replacement was admitted')
            REPORT['event_replacement_diagnostics'] = negative_diagnostics
        result_code = 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as error:
        REPORT['bounded_probe_passed'] = False
        REPORT['failure'] = str(error)[:4000]
        if isinstance(error,ContainerdControlUnverified):
            REPORT['host_containerd_failure']={'category':error.category,'observations':error.observations}
        if isinstance(error,StartupAuditRejected):
            REPORT['startup_failure'] = {'category':error.category}
        if isinstance(error,(CompletionUnverified,WaitUnverified,ObserverUnverified)):
            REPORT['completion_failure'] = {'category':error.category,'observations':error.observations}
        if hasattr(error,'worker_role') or hasattr(error,'lifecycle_cleanup'):
            REPORT['lifecycle_failure'] = {
                'error_type':type(error).__name__,
                'category':getattr(error,'category','lifecycle-error'),
                'observations':getattr(error,'observations',{}),
                'worker_role':getattr(error,'worker_role','unknown'),
                'state':getattr(error,'worker_state',{'outcome':'unavailable'}),
                'protocol':getattr(error,'worker_diagnostics',{}),
                'cleanup':getattr(error,'lifecycle_cleanup',[]),
                'cleanup_verified':getattr(error,'lifecycle_cleanup_verified',False),
            }
        if isinstance(error, subprocess.TimeoutExpired) and run_started and hasattr(error,'protocol_phase'):
            REPORT['worker_timeout'] = {
                'protocol_phase':getattr(error,'protocol_phase','unknown'),
                'stdout':(error.output or b'')[:16384].decode('utf-8',errors='replace'),
                'stderr':(error.stderr or b'')[:4096].decode('utf-8',errors='replace'),
            }
            if getattr(error,'worker_role',None) == 'healthy':
                REPORT['lifecycle_timeout'] = {'worker_role':'healthy','state':error.worker_state,
                                               'protocol':error.worker_diagnostics}
            else:
                try:
                    REPORT['host_timeout_diagnostics'] = snapshot_worker(container)
                except (OSError,RuntimeError,ValueError,subprocess.TimeoutExpired) as diagnostic_error:
                    REPORT['host_timeout_diagnostics'] = {'outcome':'timed-out' if isinstance(diagnostic_error,subprocess.TimeoutExpired) else 'unavailable'}
        result_code = 1
    finally:
        cleanup = []
        cleanup_resources = [
            ('container', run_started, ['docker', 'rm', '-f', container]),
            ('image', build_started, ['docker', 'image', 'rm', '-f', tag]),
        ]
        cleanup_resources.extend(('resource-container', True, ['docker', 'rm', '-f', name])
                                 for name in resource_containers)
        for resource, started, args in cleanup_resources:
            if not started:
                cleanup.append({'resource': resource, 'outcome': 'never-created'})
                continue
            try:
                removed = subprocess.run(args, capture_output=True, text=True,
                                         timeout=15, check=False)
                absent = (('No such container:' if resource in ('container', 'resource-container') else
                           'No such image:') in removed.stderr)
                outcome = 'removed' if removed.returncode == 0 else 'absent' if absent else 'failed'
                cleanup.append({'resource': resource, 'outcome': outcome})
            except (OSError, subprocess.TimeoutExpired):
                cleanup.append({'resource': resource, 'outcome': 'failed'})
        REPORT['cleanup'] = cleanup
        # A timed-out Docker build command can leave daemon work running after
        # its CLI has died. Removing a current tag does not cancel that work.
        REPORT['daemon_build_may_be_pending'] = build_started and not build_finished
        REPORT['cleanup_complete'] = (all(item['outcome'] != 'failed' for item in cleanup)
                                      and not REPORT['daemon_build_may_be_pending'])
        evidence = REPORT.get('evidence')
        REPORT['bounded_probe_passed'] = (result_code == 0 and isinstance(evidence, dict)
            and accept(dict(evidence, cleanup_complete=REPORT['cleanup_complete']), architecture)
            and accept_resources(REPORT.get('trusted_cgroup_abuse'))
            and type(REPORT.get('worker_configuration')) is dict
            and evidence.get('host_canary_absent') is True
            and type(REPORT.get('restricted_worker_lifecycle')) is dict
            and REPORT['restricted_worker_lifecycle'].get('passed') is True
            and type(REPORT['restricted_worker_lifecycle'].get('repeats')) is list
            and len(REPORT['restricted_worker_lifecycle']['repeats']) == 2
            and type(REPORT.get('worker_descriptors')) is dict and REPORT['worker_descriptors'].get('passed') is True
            and type(REPORT.get('event_replacement_negative')) is dict
            and REPORT['event_replacement_negative'].get('passed') is True)
        if not REPORT['cleanup_complete']:
            REPORT['cleanup_failure'] = 'owned resource cleanup incomplete or daemon build state unresolved'
            result_code = 1
        if not REPORT['bounded_probe_passed']:
            result_code = 1
        print(json.dumps(REPORT, indent=2))
    return result_code


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--architecture', choices=('amd64','arm64'),
                        help='require this native Linux architecture; default detects supported native host')
    parser.add_argument('--trusted-build-network',choices=('host',),help='explicit trusted dependency build networking; worker networking remains none')
    parser.add_argument('--healthy-containerd-exit',action='store_true',help='Linux-host-only matching init exit evidence for concurrent healthy workers; removal still required')
    arguments = parser.parse_args()
    raise SystemExit(main(arguments.architecture,arguments.trusted_build_network,arguments.healthy_containerd_exit))

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
from report import accept, CONTROLS
from runtime_profile import select_profile, native_elf_identity
from protocol import run_container
from resources import accept_resources
from threads import inspect_threads

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


def main(architecture=None):
    tag = 'fleur-runtime-probe-' + str(time.time_ns())
    container = tag + '-run'
    result_code = 1
    build_started = False
    build_finished = False
    run_started = False
    resource_containers = []
    try:
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
                                               'protocol.py','report.py','runtime_profile.py','run.py','resources.py','threads.py')}
        REPORT['host'] = {'kernel': platform.release(),
                          'os_release': Path('/etc/os-release').read_text(),
                          'docker': command(['docker', 'version', '--format', '{{json .}}'])}
        with tempfile.TemporaryDirectory(prefix='fleur-runtime-probe-') as directory:
            context = Path(directory)
            for name in ('bootstrap.ts', 'application.js'):
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
COPY filter.so application.js abuse profile.json ./
USER 65534:65534
ENTRYPOINT ["bun", "/probe/bootstrap.js"]
''')
            build_started = True
            command(['docker', 'build', '--platform', 'linux/' + architecture, '-t', tag, str(context)], timeout=240)
            build_finished = True
            REPORT['image_architecture'] = command(['docker','image','inspect',tag,'--format','{{.Architecture}}'])
            if REPORT['image_architecture'] != architecture:
                raise RuntimeError('built Docker image architecture differs from native runner')
            REPORT['image_id'] = command(['docker', 'image', 'inspect', tag, '--format', '{{.Id}}'])
            run_started = True
            def observe_worker(_request):
                REPORT['host_threads'] = inspect_threads(container)
            output = run_container(['docker', 'run', '-i', '--name', container, '--network=none',
                              '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                              '--security-opt=seccomp=unconfined', '--cpus=1', '--memory=512m',
                              '--memory-swap=512m', '--pids-limit=64', '--ulimit=core=0', '--pull=never', REPORT['image_id']], timeout=30, observer=observe_worker)
            if len(output) > 16384:
                raise RuntimeError('probe output exceeded bound')
            # Retain successful native evidence even if a later resource probe fails.
            REPORT['evidence'] = json.loads(output)
            evidence = REPORT['evidence']
            if isinstance(evidence, dict):
                evidence['host_threads'] = REPORT.get('host_threads')
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
        result_code = 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as error:
        REPORT['bounded_probe_passed'] = False
        REPORT['failure'] = str(error)[:4000]
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
            and accept_resources(REPORT.get('trusted_cgroup_abuse')))
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
    raise SystemExit(main(parser.parse_args().architecture))

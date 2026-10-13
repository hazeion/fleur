#!/usr/bin/env python3
"""Disposable amd64 Linux experiment. Exit 0 accepts only bounded evidence."""
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import time
from report import accept

BASE = 'oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e'
HERE = Path(__file__).resolve().parent
REPORT = {'scope': 'bounded-pre-application-tsync-render', 'v1_gate_passed': False,
          'base_image': BASE, 'expected_bun': '1.4.3', 'expected_gcc': '13.3.0'}


def command(args, timeout=30, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                            timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f'{args[0]} exited {result.returncode}: '
                           + (result.stdout + result.stderr)[-3000:])
    return result.stdout.strip()


def main():
    tag = 'fleur-runtime-probe-' + str(time.time_ns())
    container = tag + '-run'
    result_code = 1
    build_started = False
    build_finished = False
    run_started = False
    try:
        if platform.system() != 'Linux' or platform.machine() != 'x86_64':
            raise RuntimeError('requires disposable Linux x86_64 Docker runner')
        compiler = shutil.which('gcc')
        if compiler is None:
            raise RuntimeError('gcc prerequisite missing; nothing installed')
        version = command([compiler, '-dumpfullversion'])
        REPORT['gcc'] = {'version': command([compiler, '--version']),
                         'binary_sha256': hashlib.sha256(Path(compiler).read_bytes()).hexdigest()}
        if version != REPORT['expected_gcc']:
            raise RuntimeError(f'compiler candidate mismatch: {version}')
        REPORT['host'] = {'kernel': platform.release(),
                          'os_release': Path('/etc/os-release').read_text(),
                          'docker': command(['docker', 'version', '--format', '{{json .}}'])}
        with tempfile.TemporaryDirectory(prefix='fleur-runtime-probe-') as directory:
            context = Path(directory)
            for name in ('bootstrap.ts', 'application.js'):
                shutil.copyfile(HERE / name, context / name)
            dependencies = HERE.parent / 'rendering'
            for name in ('package.json', 'bun.lock'):
                shutil.copyfile(dependencies / name, context / name)
            command([compiler, '-shared', '-fPIC', '-O2', '-std=c11', '-Wall', '-Wextra',
                     '-Werror', '-pthread', str(HERE / 'filter.c'), '-o', str(context / 'filter.so')])
            REPORT['helper_sha256'] = hashlib.sha256((context / 'filter.so').read_bytes()).hexdigest()
            (context / 'Dockerfile').write_text(f'''FROM {BASE} AS prepare
WORKDIR /probe
COPY package.json bun.lock ./
RUN test "$(bun --version)" = "1.4.3" && bun install --production --frozen-lockfile
COPY bootstrap.ts ./
RUN bun build bootstrap.ts --target=bun --outfile=bootstrap.js
FROM {BASE}
WORKDIR /probe
COPY --from=prepare /probe/bootstrap.js ./
COPY filter.so application.js ./
USER 65534:65534
ENTRYPOINT ["bun", "/probe/bootstrap.js"]
''')
            build_started = True
            command(['docker', 'build', '--platform', 'linux/amd64', '-t', tag, str(context)], timeout=240)
            build_finished = True
            REPORT['image_id'] = command(['docker', 'image', 'inspect', tag, '--format', '{{.Id}}'])
            run_started = True
            output = command(['docker', 'run', '--name', container, '--network=none',
                              '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                              '--security-opt=seccomp=unconfined', '--cpus=1', '--memory=512m',
                              '--memory-swap=512m', '--pids-limit=64', '--ulimit=core=0', '--pull=never', REPORT['image_id']], timeout=30)
            if len(output) > 16384:
                raise RuntimeError('probe output exceeded bound')
            REPORT['evidence'] = json.loads(output)
            evidence = REPORT['evidence']
            if not isinstance(evidence, dict) or not accept(dict(evidence, cleanup_complete=True)):
                raise RuntimeError('incomplete, malformed or failed bounded runtime evidence')
        result_code = 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as error:
        REPORT['bounded_probe_passed'] = False
        REPORT['failure'] = str(error)[:4000]
        result_code = 1
    finally:
        cleanup = []
        for resource, started, args in (
            ('container', run_started, ['docker', 'rm', '-f', container]),
            ('image', build_started, ['docker', 'image', 'rm', '-f', tag]),
        ):
            if not started:
                cleanup.append({'resource': resource, 'outcome': 'never-created'})
                continue
            try:
                removed = subprocess.run(args, capture_output=True, text=True,
                                         timeout=15, check=False)
                absent = (('No such container:' if resource == 'container' else
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
            and accept(dict(evidence, cleanup_complete=REPORT['cleanup_complete'])))
        if not REPORT['cleanup_complete']:
            REPORT['cleanup_failure'] = 'owned resource cleanup incomplete or daemon build state unresolved'
            result_code = 1
        if not REPORT['bounded_probe_passed']:
            result_code = 1
        print(json.dumps(REPORT, indent=2))
    return result_code


if __name__ == '__main__':
    raise SystemExit(main())

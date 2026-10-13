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
            command(['docker', 'build', '--platform', 'linux/amd64', '-t', tag, str(context)], timeout=240)
            REPORT['image_id'] = command(['docker', 'image', 'inspect', tag, '--format', '{{.Id}}'])
            output = command(['docker', 'run', '--name', container, '--network=none',
                              '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                              '--security-opt=seccomp=unconfined', '--cpus=1', '--memory=512m',
                              '--memory-swap=512m', '--pids-limit=64', '--ulimit=core=0', '--pull=never', REPORT['image_id']], timeout=30)
            if len(output) > 16384:
                raise RuntimeError('probe output exceeded bound')
            REPORT['evidence'] = json.loads(output)
            REPORT['bounded_probe_passed'] = accept(REPORT['evidence'])
            if not REPORT['bounded_probe_passed']:
                raise RuntimeError('incomplete or failed bounded runtime evidence')
        return 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as error:
        REPORT['bounded_probe_passed'] = False
        REPORT['failure'] = str(error)[:4000]
        return 1
    finally:
        for args in (['docker', 'rm', '-f', container], ['docker', 'image', 'rm', '-f', tag]):
            try:
                subprocess.run(args, capture_output=True, timeout=15, check=False)
            except (OSError, subprocess.TimeoutExpired):
                pass
        print(json.dumps(REPORT, indent=2))


if __name__ == '__main__':
    raise SystemExit(main())

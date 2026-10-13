#!/usr/bin/env python3
"""Frozen distro userspace fixtures on a matching native Linux Docker host."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import uuid

TARGETS = {
    'debian-amd64': ('amd64', 'debian@sha256:918311b7b6c4c6f68b232ba516584925f6c78ad82b6fd534b98979df6438e483'),
    'debian-arm64': ('arm64', 'debian@sha256:a2ca65377c251208de42e1a2722cb949211236c161b634f6f3663754e2d06850'),
    'arch-amd64': ('amd64', 'archlinux@sha256:363129b67b2bc6c5a634f8fb4961a7e2eba213a2ec075d159127b1260290a722'),
}
LABEL = 'dev.fleur.compatibility.owner'

DEBIAN = '''RUN rm -f /etc/apt/sources.list.d/* && printf '%s\\n' \
 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261012T000000Z/ trixie main' \
 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261012T000000Z/ trixie-security main' \
 > /etc/apt/sources.list && apt-get -o Acquire::Check-Valid-Until=false update && \
 apt-get install -y --no-install-recommends python3 ca-certificates \
 libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 \
 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 \
 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
 fonts-liberation fonts-noto-color-emoji && \
 mkdir -p /evidence && dpkg-query -W > /evidence/packages.txt
'''
ARCH = '''RUN printf '%s\\n' 'Server = https://archive.archlinux.org/repos/2026/10/12/$repo/os/$arch' \
 > /etc/pacman.d/mirrorlist && pacman -Syyuu --noconfirm && \
 pacman -S --noconfirm --needed python ca-certificates alsa-lib at-spi2-core \
 cairo cups dbus glib2 libdrm libx11 libxcb libxcomposite libxdamage \
 libxext libxfixes libxkbcommon libxrandr mesa nspr nss pango \
 ttf-liberation noto-fonts-emoji && mkdir -p /evidence && \
 pacman -Q > /evidence/packages.txt
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=TARGETS, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    arch, base = TARGETS[args.target]
    owner = uuid.uuid4().hex
    image = 'fleur-distro-' + owner
    container = 'fleur-distro-' + owner
    report = {'scope': 'container userspace fixtures only; Ubuntu host kernel and Docker',
              'target': args.target, 'base_image': base, 'owner': owner,
              'passed': False, 'v1_gate_passed': False, 'commands': [],
              'host': {'system': platform.system(), 'architecture': platform.machine(),
                       'kernel': platform.release(), 'runner_image': os.environ.get('ImageVersion')}}
    args.out.mkdir(parents=True, exist_ok=True)
    stage = 'native Linux host'
    created = False
    built = False

    def run(name, command, timeout=1200):
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
            output = result.stdout + result.stderr
            (args.out / (name + '.txt')).write_text(output)
            report['commands'].append({'name': name, 'exit_code': result.returncode,
                                       'output_sha256': hashlib.sha256(output.encode()).hexdigest()})
            return result
        except subprocess.TimeoutExpired as error:
            (args.out / (name + '.txt')).write_text(str(error))
            report['commands'].append({'name': name, 'exit_code': None, 'timeout': True})
            return None

    try:
        native = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
        if platform.system() != 'Linux' or native != arch:
            raise ValueError('matching native Linux architecture required; no emulation')
        report['host']['os_release'] = Path('/etc/os-release').read_text()
        stage = 'Docker prerequisite'
        if not shutil.which('docker'):
            raise ValueError('Docker unavailable')
        version = run('docker-version', ['docker', 'version', '--format', '{{json .}}'], 30)
        if version is None or version.returncode:
            raise ValueError('Docker daemon unavailable')
        docker = json.loads(version.stdout)
        report['docker'] = docker
        if docker['Server']['Os'] != 'linux' or docker['Server']['Arch'] != arch:
            raise ValueError('Docker server is not matching native Linux architecture')
        with tempfile.TemporaryDirectory(prefix='fleur-distro-') as directory:
            context = Path(directory)
            source = Path(__file__).resolve().parent.parent
            report['fixture_inputs'] = {str(path.relative_to(source)): hashlib.sha256(path.read_bytes()).hexdigest()
                                       for path in source.rglob('*')
                                       if path.is_file() and ('node_modules' not in path.parts)
                                       and (path.name == 'bun.lock' or path.suffix == '.patch'
                                            or path.name == 'bootstrap.py')}
            for fixture in ('platforms', 'tooling', 'rendering', 'distro-fixtures'):
                shutil.copytree(source / fixture, context / fixture,
                                ignore=shutil.ignore_patterns('node_modules', '__pycache__', 'dist', 'test-results', 'playwright-report'))
            dockerfile = ('FROM ' + base + '\nLABEL ' + LABEL + '="' + owner + '"\n' +
                          (ARCH if args.target.startswith('arch') else DEBIAN) +
                          'COPY . /fixtures/\nWORKDIR /fixtures\nCMD ["python3", "distro-fixtures/inside.py"]\n')
            (context / 'Dockerfile').write_text(dockerfile)
            (args.out / 'Dockerfile').write_text(dockerfile)
            stage = 'snapshot image build'
            built = True
            result = run('image-build', ['docker', 'build', '--platform', 'linux/' + arch, '-t', image, str(context)])
            if result is None or result.returncode:
                raise ValueError('snapshot image provisioning failed')
            inspection = run('image-inspect', ['docker', 'image', 'inspect', image], 30)
            if inspection is None or inspection.returncode:
                raise ValueError('image identity unavailable')
            report['image'] = json.loads(inspection.stdout)[0]
            if report['image']['Architecture'] != arch or report['image']['Config']['Labels'].get(LABEL) != owner:
                raise ValueError('image identity rejected')
            stage = 'owned container create'
            created = True
            result = run('container-create', ['docker', 'create', '--name', container,
                         '--label', LABEL + '=' + owner, '--cap-drop=ALL',
                         '--security-opt=no-new-privileges', '--pids-limit=512', image], 30)
            if result is None or result.returncode:
                raise ValueError('container creation failed')
            stage = 'fixtures'
            result = run('fixtures', ['docker', 'start', '-a', container])
            copied = run('evidence-copy', ['docker', 'cp', container + ':/evidence/.', str(args.out)], 30)
            if copied is None or copied.returncode:
                raise ValueError('container evidence unavailable')
            if result is None or result.returncode:
                raise ValueError('fixture failure')
            evidence = json.loads((args.out / 'fixtures.json').read_text())
            if not evidence.get('passed'):
                raise ValueError('fixture report rejected')
            report['passed'] = True
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        report['failure_stage'] = stage
        report['error'] = str(error)
    finally:
        # Delete only randomly named resources after validating this run's ownership.
        for kind, exists, name in (('container', created, container), ('image', built, image)):
            if not exists:
                continue
            inspected = run('cleanup-inspect-' + kind, ['docker', kind, 'inspect', name], 30)
            owned = False
            if inspected and inspected.returncode == 0:
                try:
                    metadata = json.loads(inspected.stdout)[0]
                    owned = metadata.get('Config', {}).get('Labels', {}).get(LABEL) == owner
                except (ValueError, IndexError, AttributeError):
                    owned = False
            if not owned:
                report['passed'] = False
                report.setdefault('cleanup_errors', []).append(kind + ' ownership unverified')
                continue
            removed = run('cleanup-' + kind, ['docker', kind, 'rm', '-f', name], 30)
            if removed is None or removed.returncode:
                report['passed'] = False
                report.setdefault('cleanup_errors', []).append(kind + ' removal failed')
        (args.out / 'driver.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())

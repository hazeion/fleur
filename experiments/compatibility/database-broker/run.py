#!/usr/bin/env python3
"""Own one random ephemeral Docker PostgreSQL; never accept external DB URLs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
import sys
from ownership import OwnedContainer, LABEL
from native import run_native

IMAGE = 'postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bun', required=True)
    args = parser.parse_args()
    bun = str(Path(args.bun).resolve())
    report = {'scope': 'Disposable database/broker compatibility experiment only',
              'postgres_image': IMAGE, 'checks': [], 'passed': False}
    owner = secrets.token_hex(16)
    name = 'fleur-compat-db-' + owner
    database = 'fleur_probe_' + secrets.token_hex(8)
    password = secrets.token_hex(32)

    def command(arguments, **kwargs):
        return subprocess.run(arguments, text=True, capture_output=True, timeout=180, **kwargs)

    owned = OwnedContainer(command, name, owner)
    inspect_owned = owned.inspect

    try:
        version = command([bun, '--version'])
        if version.returncode or version.stdout.strip() != '1.4.3':
            raise RuntimeError('Bun 1.4.3 required')
        if not shutil.which('docker') or command(['docker', 'version', '--format', '{{.Server.Version}}']).returncode:
            raise RuntimeError('Docker daemon unavailable; no database test executed')
        result = command(['docker', 'pull', IMAGE])
        if result.returncode:
            raise RuntimeError('Immutable PostgreSQL image acquisition failed')
        image = command(['docker', 'image', 'inspect', IMAGE])
        metadata = json.loads(image.stdout)[0]
        if IMAGE not in metadata.get('RepoDigests', []):
            raise RuntimeError('Pulled image digest differs')
        report['image_id'] = metadata['Id']
        report['image_architecture'] = metadata['Architecture']
        # No host filesystem mount, external database or persistent named volume.
        result = owned.launch(['docker', 'run', '--detach', '--name', name,
                          '--label', LABEL + '=' + owner, '--cpus', '1', '--memory', '512m',
                          '--pids-limit', '64', '--tmpfs', '/var/lib/postgresql:rw,size=384m',
                          '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_USER=' + database,
                          '--env', 'POSTGRES_DB=' + database, '--env', 'POSTGRES_PASSWORD=' + password,
                          IMAGE])
        if result.returncode:
            raise RuntimeError('Owned disposable database launch failed')
        metadata = inspect_owned()
        if any(m['Type'] != 'tmpfs' or m['Destination'] != '/var/lib/postgresql' for m in metadata['Mounts']) or metadata['HostConfig']['Binds']:
            raise RuntimeError('Unexpected persistent or host mount')
        deadline = time.monotonic() + 60
        while True:
            ready = command(['docker', 'exec', name, 'pg_isready', '-U', database, '-d', database])
            if ready.returncode == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Owned database readiness deadline')
            time.sleep(0.2)
        ports = inspect_owned()['NetworkSettings']['Ports']['5432/tcp']
        if len(ports) != 1 or ports[0]['HostIp'] != '127.0.0.1':
            raise RuntimeError('Disposable endpoint is not exclusively loopback')
        port = int(ports[0]['HostPort'])
        environment = os.environ.copy()
        # Never inherit a previously supplied database target.
        environment['FLEUR_DISPOSABLE_DATABASE_URL'] = f'postgres://{database}:{password}@127.0.0.1:{port}/{database}'
        environment['FLEUR_DISPOSABLE_DATABASE_VERIFIED'] = '1'
        environment['FLEUR_DISPOSABLE_DATABASE_NAME'] = database
        with tempfile.TemporaryDirectory(prefix='fleur-database-broker-') as temp:
            root = Path(temp)
            shutil.copytree(Path(__file__).parent, root, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns('node_modules', '__pycache__'))

            def check(name, arguments, required=True, executable=bun):
                result = command([executable, *arguments], cwd=root, env=environment)
                output = (result.stdout + result.stderr).replace(password, '<redacted>').replace(database, '<owned-database>').replace(str(root), '<experiment>')
                report['checks'].append({'name': name, 'exit_code': result.returncode,
                    'passed': result.returncode == 0, 'required': required,
                    'output_sha256': hashlib.sha256(output.encode()).hexdigest(),
                    'output_excerpt': output[:5000], 'output_truncated': len(output) > 5000})
                return result.returncode == 0

            if not check('frozen-install', ['install', '--frozen-lockfile']):
                raise RuntimeError('Frozen installation failed')
            check('host-rpc-and-ownership-boundaries', ['-m', 'unittest', 'test_rpc.py', 'test_ownership.py'], executable=sys.executable)
            if not check('owned-server-identity-and-schema', ['init.ts']):
                raise RuntimeError('Verified target initialization failed')
            check('admission-and-declaration-integrity', ['test', 'admission.test.ts', 'patch.test.ts'])
            check('database-first', ['test', 'database.test.ts'])
            check('database-repeat', ['test', 'database.test.ts'])
            if check('native-fixture-identity-and-reset', ['reset.ts']):
                report['checks'].append(run_native(bun, root, environment, Path(__file__).resolve().parent.parent))
            check('strict-types', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'])
            check('oxlint', ['node_modules/oxlint/bin/oxlint', 'broker.ts', 'admission.test.ts', 'database.test.ts', 'init.ts', 'ipc.ts', 'worker.ts', 'patch.test.ts', 'proxy.ts', 'reset.ts'])
            if check('independent-eslint-install', ['install', '--frozen-lockfile', '--cwd', str(root / 'lint')]):
                check('independent-eslint', ['lint/node_modules/eslint/bin/eslint.js', 'broker.ts', 'admission.test.ts', 'database.test.ts', 'init.ts', 'ipc.ts', 'worker.ts', 'patch.test.ts', 'proxy.ts', 'reset.ts'])
            check('build', ['build', './ipc.ts', '--target=bun', '--outfile', str(root / 'broker.js')])
        report['passed'] = all(row['passed'] for row in report['checks'] if row['required'])
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError, KeyError) as error:
        # Do not emit raw subprocess errors or connection URLs.
        report['failure'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    finally:
        if owned.attempted:
            try:
                report['cleanup_verified'] = owned.cleanup()
                if not report['cleanup_verified']:
                    report['passed'] = False
            except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError, KeyError):
                report['cleanup_verified'] = False
                report['passed'] = False
        print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

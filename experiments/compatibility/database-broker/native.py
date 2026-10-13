"""Connect an actually restricted worker to the owned trusted PostgreSQL broker."""
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import secrets
import shutil
import subprocess
import tempfile
from rpc import TrustedBroker

BASE = 'oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e'
GCC_SHA256 = '1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26'
LABEL = 'fleur.compatibility.native-database-owner'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def attach_host_threads(worker_evidence, observed_threads):
    if type(worker_evidence) is not dict or 'host_threads' in worker_evidence:
        raise RuntimeError('Worker cannot supply trusted thread observations')
    if type(observed_threads) is not list:
        raise RuntimeError('Trusted thread inspection did not complete')
    return dict(worker_evidence, host_threads=observed_threads)


def run_native(bun, root, environment, source_root):
    row = {'name': 'restricted-worker-real-postgresql', 'required': True, 'passed': False}
    owner = secrets.token_hex(16)
    image = 'fleur-native-database-' + owner
    container = image + '-worker'
    attempted_build = False
    finished_build = False
    attempted_run = False
    cleanup = True

    def command(arguments, timeout=30):
        result = subprocess.run(arguments, text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError('Owned native database probe command failed')
        return result.stdout.strip()

    try:
        if platform.system() != 'Linux' or platform.machine() != 'x86_64':
            raise RuntimeError('Restricted native database probe requires Linux x86_64')
        compiler = shutil.which('gcc')
        if compiler is None or hashlib.sha256(Path(compiler).read_bytes()).hexdigest() != GCC_SHA256 or command([compiler, '-dumpfullversion']) != '13.3.0':
            raise RuntimeError('Approved native GCC pin unavailable')
        runtime = source_root / 'runtime-probe'
        protocol = load(runtime / 'protocol.py', 'fleur_native_database_protocol')
        acceptance = load(runtime / 'report.py', 'fleur_native_database_acceptance')
        threads = load(runtime / 'threads.py', 'fleur_native_database_thread_inspector')
        with tempfile.TemporaryDirectory(prefix='fleur-native-database-') as temporary:
            context = Path(temporary)
            for filename in ('bootstrap.ts', 'application.js'):
                shutil.copyfile(runtime / filename, context / filename)
            for filename in ('package.json', 'bun.lock'):
                shutil.copyfile(source_root / 'rendering' / filename, context / filename)
            command([compiler, '-shared', '-fPIC', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-pthread', str(runtime / 'filter.c'), '-o', str(context / 'filter.so')])
            (context / 'profile.json').write_text(json.dumps({'architecture':'amd64','negative_controls':acceptance.CONTROLS['amd64']}))
            row['helper_sha256'] = hashlib.sha256((context / 'filter.so').read_bytes()).hexdigest()
            (context / 'Dockerfile').write_text(f'''FROM {BASE} AS prepare
WORKDIR /probe
COPY package.json bun.lock ./
RUN test "$(bun --version)" = "1.4.3" && bun install --production --frozen-lockfile
COPY bootstrap.ts ./
RUN bun build bootstrap.ts --target=bun --outfile=bootstrap.js
FROM {BASE}
LABEL {LABEL}={owner}
WORKDIR /probe
COPY --from=prepare /probe/bootstrap.js ./
COPY filter.so application.js profile.json ./
USER 65534:65534
ENTRYPOINT ["bun", "/probe/bootstrap.js"]
''')
            attempted_build = True
            command(['docker', 'build', '--platform', 'linux/amd64', '-t', image, str(context)], timeout=240)
            finished_build = True
            metadata = json.loads(command(['docker', 'image', 'inspect', image]))[0]
            if metadata['Config']['Labels'].get(LABEL) != owner:
                raise RuntimeError('Native image identity mismatch')
            row['image_id'] = metadata['Id']
            observed_threads = None
            def observe_threads(_request):
                nonlocal observed_threads
                identity = json.loads(command(['docker','inspect',container],timeout=5))[0]
                if identity['Name'] != '/'+container or identity['Image'] != metadata['Id'] or identity['Config']['Labels'].get(LABEL) != owner:
                    raise RuntimeError('Native container identity differs before inspection')
                observed_threads = threads.inspect_threads(container)
            with_broker = TrustedBroker([bun, 'ipc.ts'], root, environment, timeout=8)
            try:
                attempted_run = True
                # No host env, DB credential, host mount, network or socket enters this worker.
                output = protocol.run_container(['docker', 'run', '-i', '--name', container,
                    '--label', LABEL + '=' + owner, '--network=none', '--read-only', '--cap-drop=ALL',
                    '--security-opt=no-new-privileges', '--security-opt=seccomp=unconfined',
                    '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=64',
                    '--ulimit=core=0', '--pull=never', metadata['Id']], dispatch=with_broker.dispatch, timeout=30, observer=observe_threads)
            finally:
                with_broker.close()
            evidence = attach_host_threads(json.loads(output), observed_threads)
            if not acceptance.accept(dict(evidence, cleanup_complete=True),expected_architecture='amd64'):
                raise RuntimeError('Restricted worker evidence incomplete')
            row['native_evidence'] = evidence
            row['passed'] = True
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError, KeyError) as error:
        row['failure'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    finally:
        for resource, attempted in [('container', attempted_run), ('image', attempted_build)]:
            if not attempted:
                continue
            name = container if resource == 'container' else image
            try:
                inspection = subprocess.run(['docker', 'inspect', name] if resource == 'container' else ['docker', 'image', 'inspect', name], text=True, capture_output=True, timeout=10)
                absent = inspection.returncode and ('No such object:' in inspection.stderr or 'No such image:' in inspection.stderr)
                if absent:
                    continue
                if inspection.returncode or json.loads(inspection.stdout)[0]['Config']['Labels'].get(LABEL) != owner:
                    cleanup = False
                    continue
                removal = subprocess.run(['docker', 'rm', '--force', name] if resource == 'container' else ['docker', 'image', 'rm', '--force', name], text=True, capture_output=True, timeout=10)
                cleanup = cleanup and removal.returncode == 0
            except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
                cleanup = False
        row['daemon_build_may_be_pending'] = attempted_build and not finished_build
        row['cleanup_verified'] = cleanup and not row['daemon_build_may_be_pending']
        row['passed'] = row['passed'] and row['cleanup_verified']
    return row

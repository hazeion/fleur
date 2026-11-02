"""Internal bootstrap for the fixed native Debian workout proof, never a Fleur command."""
import os
from pathlib import Path
import re
import subprocess


def browser_plan(text, installed):
    if not isinstance(text, str) or len(text.encode()) > 2 * 1024 * 1024:
        raise ValueError('Browser package simulation exceeded its bound')
    existing = {name.split(':')[0] for name in installed}
    admitted = {}
    for line in text.splitlines():
        if line.startswith(('Remv ', 'Purg ')):
            raise ValueError('Browser prerequisites cannot remove distribution packages')
        if not line.startswith('Inst '):
            continue
        match = re.fullmatch(r'Inst ([a-z0-9][a-z0-9+.-]*(?::amd64)?) (?:\[[^\]]+\] )?\(([A-Za-z0-9.+:~_-]+) ([^\r\n()]+) \[(amd64|all)\]\)', line)
        if not match:
            raise ValueError('Noncanonical browser package simulation')
        name, version, origins, _ = match.groups()
        if name.split(':')[0] in existing:
            raise ValueError('Browser prerequisites cannot change an existing distribution package')
        if name in admitted or len(admitted) >= 256 or any(not re.fullmatch(r'(?:Debian|Debian-Security):13(?:\.[0-9]+)?/(?:stable|stable-security|stable-updates|trixie|trixie-security|trixie-updates)', origin) for origin in origins.split(', ')):
            raise ValueError('Unexpected browser prerequisite origin or closure')
        admitted[name] = version
    return [name + '=' + version for name, version in sorted(admitted.items())]


def restore_source(pack, commit, destination):
    if not re.fullmatch('[a-f0-9]{40}', commit) or not isinstance(pack, bytes) or not 12 <= len(pack) <= 16 * 1024 * 1024 or pack[:4] != b'PACK':
        raise ValueError('Invalid bounded source pack')
    destination = Path(destination)
    destination.mkdir(mode=0o700)
    environment = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_COUNT': '0'}
    def git(*args, data=None):
        return subprocess.run(['git', '-C', str(destination), '-c', 'core.hooksPath=/dev/null', *args], input=data, capture_output=True, env=environment, check=True, timeout=60).stdout
    git('init', '--template=', '--quiet')
    (destination / '.git/shallow').write_text(commit + '\n')
    git('unpack-objects', data=pack)
    git('update-ref', 'HEAD', commit)
    git('reset', '--hard', '--quiet', commit)
    git('fsck', '--no-reflogs', '--connectivity-only', '--no-dangling')
    if git('status', '--porcelain') or git('remote') or git('rev-parse', 'HEAD').decode().strip() != commit:
        raise ValueError('Restored source identity differs')


def verify_proof_source(proof, commits):
    if not isinstance(proof, dict) or proof.get('ok') is not True:
        raise ValueError('Packed native workout proof failed its source or completion contract')
    sources = proof.get('source')
    if not isinstance(sources, dict) or set(sources) != {'fleur', 'workout'}:
        raise ValueError('Packed native workout proof failed its source or completion contract')
    for name, commit in commits.items():
        source = sources[name]
        if (not isinstance(source, dict) or source.get('commit') != commit or source.get('dirty') is not False
                or not isinstance(source.get('treeSha256'), str) or not re.fullmatch('[a-f0-9]{64}', source['treeSha256'])
                or type(source.get('files')) is not int or source['files'] <= 0):
            raise ValueError('Packed native workout proof failed its source or completion contract')


def main():
    import hashlib
    import json
    import platform
    import shutil
    import signal
    import stat
    import tempfile
    root = Path.cwd()
    active = set()
    result = {'formatVersion': 1, 'scope': 'native-debian-workout-production', 'ok': False}
    scratch = None
    canary = None
    def interrupted(_signal, _frame):
        raise RuntimeError('Native workout proof interrupted')
    for name in ('SIGINT', 'SIGTERM', 'SIGHUP'):
        signal.signal(getattr(signal, name), interrupted)
    def run(args, *, cwd=None, environment=None, timeout=60, allowed=(0,)):
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
            child = subprocess.Popen(args, cwd=cwd, env=environment, stdin=subprocess.DEVNULL, stdout=output, stderr=error, start_new_session=True)
            active.add(child)
            try:
                code = child.wait(timeout=timeout)
                if output.tell() > 8 * 1024 * 1024 or error.tell() > 8 * 1024 * 1024:
                    raise RuntimeError('Native proof tool output exceeded its bound')
                output.seek(0); error.seek(0)
                text, diagnostic = output.read().decode(), error.read().decode()
                if code not in allowed:
                    raise RuntimeError('Native proof tool failed: ' + args[0] + '\n' + diagnostic[-8192:] + '\n' + text[-8192:])
                return code, text, diagnostic
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
                active.discard(child)
    def packages():
        _, text, _ = run(['/usr/bin/dpkg-query', '--show', '--showformat=${binary:Package}\t${Version}\t${db:Status-Status}\n'])
        return {name: version for name, version, status in (line.split('\t') for line in text.splitlines()) if status == 'installed'}
    try:
        if os.getuid() == 0 or platform.system() != 'Linux' or platform.machine() != 'x86_64':
            raise ValueError('Ordinary native amd64 Linux required')
        release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
        if release.get('ID', '').strip('"') != 'debian' or release.get('VERSION_ID', '').strip('"') != '13':
            raise ValueError('Native Debian 13 required')
        def retained(name, maximum):
            descriptor = os.open(root / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, 'rb') as stream:
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= maximum:
                    raise ValueError('Invalid owned source artifact')
                data = stream.read(maximum + 1)
                after = os.fstat(stream.fileno())
                identity = lambda value: (value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_nlink,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
                if identity(before) != identity(after) or len(data) != before.st_size:
                    raise ValueError('Owned source artifact changed')
                return data
        metadata = json.loads(retained('native-workout-source.json', 4096))
        if set(metadata) != {'formatVersion', 'bunSha256', 'fleur', 'workout'} or metadata['formatVersion'] != 1:
            raise ValueError('Invalid source metadata')
        def bun_identity():
            digest = hashlib.sha256()
            descriptor = os.open(root/'bun', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor,'rb') as stream:
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= 256 * 1024 * 1024:
                    raise ValueError('Invalid authenticated Bun')
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk: break
                    digest.update(chunk)
                after = os.fstat(stream.fileno())
                if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) != (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or digest.hexdigest() != metadata['bunSha256']:
                    raise ValueError('Authenticated Bun changed')
        bun_identity()
        packs = {}
        for name in ('fleur', 'workout'):
            entry = metadata[name]
            if set(entry) != {'commit', 'bytes', 'sha256'}:
                raise ValueError('Invalid source identity')
            data = retained(name + '-source.pack', 16 * 1024 * 1024)
            if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ValueError('Source artifact identity differs')
            packs[name] = data
        scratch = Path(tempfile.mkdtemp(prefix='fleur-native-workout-'))
        environment = {**os.environ, 'HOME': str(scratch), 'PATH': str(root) + ':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'BUN_INSTALL_CACHE_DIR': str(scratch/'cache'), 'PLAYWRIGHT_BROWSERS_PATH': str(scratch/'browsers'), 'DOCKER_CONFIG': os.environ.get('DOCKER_CONFIG', str(Path.home()/'.docker')), 'LC_ALL': 'C', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
        before = packages()
        def daemon():
            return run(['docker','info','--format','{{json .ID}} {{json .ServerVersion}} {{json .KernelVersion}} {{json .CgroupDriver}} {{json .CgroupVersion}}'],environment=environment)[1]
        def service(name):
            return run(['/usr/bin/systemctl','show',name,'--property=ActiveState,SubState,ActiveEnterTimestampMonotonic,ExecMainStartTimestampMonotonic,ExecMainPID,UnitFileState'],environment=environment)[1]
        before_daemon = daemon()
        before_service = service('docker.service')
        before_nftables = service('nftables.service')
        if run(['docker','ps','--all','--quiet','--no-trunc'],environment=environment)[1].strip():
            raise ValueError('Native workout requires the completed empty disposable Docker baseline')
        original_images = set(run(['docker','image','ls','--quiet','--no-trunc'],environment=environment)[1].splitlines())
        import uuid
        chain = 'FW' + uuid.uuid4().hex[:20]
        iptables = ['/usr/bin/sudo','--non-interactive','/usr/sbin/iptables-nft','--wait','5']
        run(iptables + ['-N',chain],environment=environment)
        canary = (iptables,chain,environment)
        run(iptables + ['-A',chain,'-m','comment','--comment','fleur-workout-'+chain,'-j','RETURN'],environment=environment)
        before_canary = run(iptables + ['-S',chain],environment=environment)[1]
        plans = []
        def unchanged():
            current = packages()
            if any(current.get(name) != version for name, version in before.items()):
                raise ValueError('Existing distribution package changed')
        def install(names):
            if not names: return
            _, simulated, _ = run(['/usr/bin/apt-get', '--simulate', '--no-install-recommends', 'install', *names], environment=environment)
            pinned = browser_plan(simulated, packages())
            plans.append(pinned)
            if pinned:
                run(['/usr/bin/sudo', '--non-interactive', '/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', 'LC_ALL=C', '/usr/bin/apt-get', 'install', '--assume-yes', '--no-install-recommends', '--no-remove', *pinned], timeout=300, environment=environment)
            unchanged()
        run(['/usr/bin/sudo', '--non-interactive', '/usr/bin/apt-get', 'update'], environment=environment, timeout=180)
        if not Path('/usr/bin/git').is_file(): install(['git'])
        for name in ('fleur', 'workout'): restore_source(packs[name], metadata[name]['commit'], scratch/name)
        fleur, workout = scratch/'fleur', scratch/'workout'
        pin = json.loads((fleur/'scripts/workout-source.json').read_text())
        if pin != {'repository':'hazeion/fleur-workout','commit':metadata['workout']['commit']}:
            raise ValueError('Workout source differs from the reviewed pin')
        bun = str(root/'bun')
        floor = json.loads((fleur/'scripts/bun-floor.json').read_text())['version']
        if run([bun,'--version'],environment=environment)[1].strip() != floor:
            raise ValueError('Guest Bun differs from its authenticated release floor')
        for directory in (fleur, fleur/'lint'):
            run([bun,'install','--frozen-lockfile','--ignore-scripts'],cwd=directory,environment=environment,timeout=180)
        cli = str(fleur/'node_modules/@playwright/test/cli.js')
        _, missing, diagnostic = run([bun,cli,'install-deps','--dry-run','chromium'],cwd=fleur,environment=environment,timeout=60,allowed=(0,1))
        if 'fallback' in diagnostic.lower() or 'not officially supported' in diagnostic.lower():
            raise ValueError('Browser tool did not admit native Debian 13')
        names = []
        if missing.strip() != 'All system dependencies are installed.':
            lines = missing.strip().splitlines()
            if not lines or not re.fullmatch(r'Missing system dependencies \([0-9]+\):',lines[0]):
                raise ValueError('Unexpected browser prerequisite report')
            names = [line.strip() for line in lines[1:]]
            if not all(re.fullmatch('[a-z0-9][a-z0-9+.-]*(?::amd64)?', name) for name in names):
                raise ValueError('Noncanonical browser prerequisite name')
            existing = {name.split(':')[0] for name in packages()}
            names = [name for name in names if name.split(':')[0] not in existing]
        install(names)
        run([bun,cli,'install','chromium'],cwd=fleur,environment=environment,timeout=180)
        run([bun,'scripts/pull-pinned-development-images.ts'],cwd=fleur,environment=environment,timeout=180)
        _, proof, diagnostic = run([bun,'scripts/verify-workout.ts',str(workout)],cwd=fleur,environment=environment,timeout=900)
        verified = json.loads(proof)
        verify_proof_source(verified, {name: metadata[name]['commit'] for name in ('fleur', 'workout')})
        unchanged()
        if daemon() != before_daemon or service('docker.service') != before_service or service('nftables.service') != before_nftables or run(iptables + ['-S',chain],environment=environment)[1] != before_canary:
            raise ValueError('Daemon, nftables service or detached canary changed during workout proof')
        if run(['docker','ps','--all','--quiet','--no-trunc'],environment=environment)[1].strip():
            raise ValueError('Workout proof left execution or database containers')
        after_images = set(run(['docker','image','ls','--quiet','--no-trunc'],environment=environment)[1].splitlines())
        if not original_images.issubset(after_images):
            raise ValueError('Workout proof removed a baseline image')
        result['preservation'] = {'daemon':True,'daemonService':True,'nftablesService':True,'detachedCanary':True,'baselineImages':True,'noRemainingContainers':True}
        bun_identity()
        result.update(ok=True, source={name:metadata[name]['commit'] for name in ('fleur','workout')}, platform={'system':'Linux','distribution':'debian','version':'13','architecture':'x86_64','kernel':platform.release()}, prerequisites={'existingPackagesUnchanged':True,'beforeSha256':hashlib.sha256(json.dumps(before,sort_keys=True).encode()).hexdigest(),'newPinnedClosures':plans}, proof=verified)
    except BaseException as error:
        result['error'] = {'type':type(error).__name__,'message':str(error)[-16384:]}
    finally:
        failures = []
        for child in active:
            try: os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
            except BaseException: failures.append('Owned native tool did not retire')
        if canary:
            try:
                command, chain, environment = canary
                run(command + ['-F',chain],environment=environment)
                run(command + ['-X',chain],environment=environment)
            except BaseException: failures.append('Owned detached nftables canary cleanup failed')
        if scratch is not None:
            try: shutil.rmtree(scratch)
            except BaseException: failures.append('Owned native source cleanup failed')
        result['disposal'] = {'passed':not failures,'failures':failures}
        result['ok'] = result['ok'] and not failures
    print(json.dumps(result))
    return 0 if result['ok'] else 1

if __name__ == '__main__':
    raise SystemExit(main())

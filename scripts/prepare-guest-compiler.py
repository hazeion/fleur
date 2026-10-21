"""Offline verification prerequisite, never a Fleur setup action or release admission."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

MANIFEST_SHA256 = '11127a1f28b3bac544f79d0f0bc4f91a68afec74568c342bc4bb7c773dcf00d7'
COMPILER_SHA256 = '1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26'
COMPILER = '/usr/bin/x86_64-linux-gnu-gcc-13'
ALIAS = Path('/usr/local/bin/gcc')
DEADLINE = None
STATE = {}


def identity(value):
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def budget(limit):
    result = limit if DEADLINE is None else min(limit, DEADLINE - time.monotonic())
    if result <= 0:
        raise RuntimeError('Compiler preparation aggregate deadline expired')
    return result


def command_exited(child):
    # Linux-only provisioning retains the leader until its PGID is retired.
    return os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def stop_command_group(child):
    # Do not poll or reap before signaling, so PID reuse cannot target another group.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    child.wait(timeout=5)
    end = time.monotonic() + 5
    while True:
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            pass
        if time.monotonic() >= end:
            raise RuntimeError('Compiler command process-group cleanup could not be confirmed')
        time.sleep(0.02)


def bounded_command(args, timeout=60):
    end = time.monotonic() + budget(timeout)
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True, env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'DEBIAN_FRONTEND': 'noninteractive', 'DPKG_COLORS': 'never'})
    output = {child.stdout: bytearray(), child.stderr: bytearray()}
    selector = selectors.DefaultSelector()
    for stream in output:
        selector.register(stream, selectors.EVENT_READ)
    try:
        while selector.get_map():
            if time.monotonic() >= end:
                raise RuntimeError('Compiler preparation command deadline expired')
            for key, _ in selector.select(min(0.2, max(0, end-time.monotonic()))):
                block = os.read(key.fileobj.fileno(), 8192)
                if not block:
                    selector.unregister(key.fileobj)
                else:
                    output[key.fileobj].extend(block)
                    if sum(len(value) for value in output.values()) > 2 * 1024 * 1024:
                        raise RuntimeError('Compiler preparation output bound exceeded')
        while not command_exited(child):
            if time.monotonic() >= end:
                raise RuntimeError('Compiler preparation command deadline expired')
            time.sleep(0.02)
    finally:
        try:
            stop_command_group(child)
        finally:
            selector.close()
            child.stdout.close()
            child.stderr.close()
    if child.returncode != 0:
        raise RuntimeError('Compiler preparation command failed: ' + args[0] + ': ' + output[child.stderr].decode(errors='replace')[-2048:])
    return output[child.stdout].decode()


def authenticated_copy(source, destination, pin):
    """Authenticate retained bytes before publishing them to the package interpreter."""
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as input_file:
        before = os.fstat(input_file.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != pin['bytes'] or not 0 < before.st_size <= 32 * 1024 * 1024:
            raise RuntimeError('Compiler package type or size differs')
        # Verify before creating output; an unauthenticated payload never reaches dpkg.
        digest = hashlib.sha256()
        while block := input_file.read(1024 * 1024):
            budget(1)
            digest.update(block)
        if digest.hexdigest() != pin['sha256'] or identity(before) != identity(os.fstat(input_file.fileno())):
            raise RuntimeError('Compiler package authentication failed')
        output = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(output, 'wb') as output_file:
            input_file.seek(0)
            copied = 0
            digest = hashlib.sha256()
            while block := input_file.read(1024 * 1024):
                budget(1)
                copied += len(block)
                if copied > before.st_size:
                    raise RuntimeError('Compiler package grew during copy')
                output_file.write(block)
                digest.update(block)
            output_file.flush()
            os.fsync(output_file.fileno())
        if copied != before.st_size or digest.hexdigest() != pin['sha256'] or identity(before) != identity(os.fstat(input_file.fileno())) or identity(before) != identity(os.stat(source, follow_symlinks=False)):
            raise RuntimeError('Compiler package changed during copy')
        if hashlib.sha256(Path(destination).read_bytes()).hexdigest() != pin['sha256']:
            raise RuntimeError('Retained compiler package changed')
    return {'bytes': copied, 'sha256': digest.hexdigest()}


def manifest():
    path = Path(__file__).with_name('guest-compiler-ubuntu24-amd64.json')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as file:
        before = os.fstat(file.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= 64 * 1024:
            raise RuntimeError('Compiler manifest type or size differs')
        data = file.read(64 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != MANIFEST_SHA256 or identity(before) != identity(os.fstat(file.fileno())):
            raise RuntimeError('Source-owned compiler manifest differs')
    return json.loads(data)


def validate_guest(nonce):
    parsed_nonce = uuid.UUID(nonce)
    if str(parsed_nonce) != nonce or parsed_nonce.version != 4:
        raise RuntimeError('Owned guest nonce is invalid')
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or os.getuid() != 0 or Path('/proc/1/comm').read_text().strip() != 'systemd':
        raise RuntimeError('Compiler provisioning requires the owned root Linux amd64 guest')
    release = Path('/etc/os-release').read_text()
    if 'ID=ubuntu\n' not in release or 'VERSION_ID="24.04"' not in release:
        raise RuntimeError('Compiler provisioning requires Ubuntu 24.04')
    for path in (Path('/'), Path('/etc')):
        entry = path.lstat()
        if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != 0 or entry.st_mode & 0o022:
            raise RuntimeError('Owned guest marker ancestry is unsafe')
    descriptor = os.open('/etc/fleur-owned-guest', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as marker:
        before = os.fstat(marker.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o022 or before.st_size != 36 or before.st_nlink != 1 or marker.read(37).decode() != nonce or identity(before) != identity(os.fstat(marker.fileno())) or identity(before) != identity(os.stat('/etc/fleur-owned-guest', follow_symlinks=False)):
            raise RuntimeError('Owned guest marker differs')


def verify_compiler(command):
    path = Path(COMPILER)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as file:
        before = os.fstat(file.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o022 or not 0 < before.st_size <= 2 * 1024 * 1024:
            raise RuntimeError('Installed compiler custody differs')
        digest = hashlib.sha256(file.read(2 * 1024 * 1024 + 1)).hexdigest()
        if digest != COMPILER_SHA256 or identity(before) != identity(os.fstat(file.fileno())):
            raise RuntimeError('Installed compiler differs from existing executed pin')
        version = command([COMPILER, '-dumpfullversion']).strip()
        target = command([COMPILER, '-dumpmachine']).strip()
        banner = command([COMPILER, '--version']).strip()
        if version != '13.3.0' or target != 'x86_64-linux-gnu' or 'Ubuntu 13.3.0-6ubuntu2~24.04.1' not in banner or identity(before) != identity(os.stat(path, follow_symlinks=False)):
            raise RuntimeError('Installed compiler identity differs')
    return {'path': COMPILER, 'sha256': digest, 'version': version, 'target': target, 'banner': banner}


def ensure_alias():
    parent = ALIAS.parent
    for directory in (Path('/'), Path('/usr'), Path('/usr/local'), parent):
        entry = directory.lstat()
        if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != 0 or entry.st_mode & 0o022:
            raise RuntimeError('Compiler alias ancestry is unsafe')
    created = False
    try:
        os.symlink(COMPILER, ALIAS)
        created = True
    except FileExistsError:
        if not ALIAS.is_symlink() or os.readlink(ALIAS) != COMPILER or ALIAS.lstat().st_uid != 0:
            raise RuntimeError('Existing compiler alias was preserved; prerequisite is unavailable')
    if hashlib.sha256(ALIAS.read_bytes()).hexdigest() != COMPILER_SHA256:
        raise RuntimeError('Compiler alias does not resolve to the existing pin')
    return {'path': str(ALIAS), 'target': COMPILER, 'created': created}


def provision(package_directory, nonce, command=None):
    validate_guest(nonce)
    command = bounded_command if command is None else command
    if command(['/usr/bin/systemd-detect-virt']).strip() not in ('qemu', 'kvm'):
        raise RuntimeError('Compiler provisioning requires the owned full-system guest')
    data = manifest()
    STATE.update(manifestSha256=MANIFEST_SHA256, phase='authenticating-payloads', packageInstallationAttempted=False)
    if len(data['artifacts']) != 38 or data['totalBytes'] != 59127120:
        raise RuntimeError('Compiler closure differs')
    # Root-owned private retained copies prevent the user-writable transfer paths
    # from being replaced while dpkg or maintainer scripts interpret the DEBs.
    with tempfile.TemporaryDirectory(prefix='fleur-compiler-prerequisite-', dir='/var/tmp') as directory:
        stage = Path(directory)
        paths = []
        for item in data['artifacts']:
            if item['file'] != item['package'] + '.deb' or not re.fullmatch(r'[a-z0-9+.-]+\.deb', item['file']):
                raise RuntimeError('Compiler closure filename differs')
            destination = stage / item['file']
            authenticated_copy(package_directory / item['file'], destination, item)
            paths.append(str(destination))
        for item in data['helperSources']:
            authenticated_copy(Path.cwd() / 'experiments/compatibility/runtime-probe' / item['file'], stage / item['file'], item)
        before = command(['/usr/bin/dpkg-query', '--show', '--showformat=${Package}\t${Version}\t${db:Status-Abbrev}\n'])
        STATE.update(phase='installing-verification-prerequisite', packageInstallationAttempted=True)
        command(['/usr/bin/dpkg', '--install', '--', *paths], timeout=180)
        installed = command(['/usr/bin/dpkg-query', '--show', '--showformat=${Package}\t${Version}\t${db:Status-Abbrev}\n', *[item['package'] for item in data['artifacts']]])
        expected = {item['package']: item['version'] for item in data['artifacts']}
        actual = {}
        for row in installed.splitlines():
            fields = row.split('\t')
            if len(fields) != 3 or fields[0] in actual or fields[2] != 'ii ':
                raise RuntimeError('Compiler closure installation state differs')
            actual[fields[0]] = fields[1]
        if actual != expected:
            raise RuntimeError('Compiler closure installed versions differ')
        STATE['phase'] = 'verifying-installed-compiler'
        compiler = verify_compiler(command)
        alias = ensure_alias()
        helpers = []
        for name, flags in [('filter', ['-shared', '-fPIC']), ('abuse', [])]:
            output = stage / ('filter.so' if name == 'filter' else 'abuse')
            arguments = [str(ALIAS), *flags, '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-pthread', str(stage / (name + '.c')), '-o', str(output)]
            command(arguments, timeout=30)
            body = output.read_bytes()
            if not 64 <= len(body) <= 2 * 1024 * 1024 or body[:6] != b'\x7fELF\x02\x01' or int.from_bytes(body[18:20], 'little') != 62:
                raise RuntimeError('Compiled helper native ELF identity differs')
            helpers.append({'name': output.name, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'elfMachine': 62, 'executed': False})
        return {'formatVersion': 1, 'scope': 'verification-only-compiler-prerequisite', 'ok': True,
                'fleurSetupAction': False, 'runtimeSupport': 'unverified', 'installationEvidence': 'pending',
                'order': 'before-docker-baseline-and-session-deadline', 'manifestSha256': MANIFEST_SHA256,
                'packageCount': len(paths), 'totalBytes': data['totalBytes'], 'packages': data['artifacts'],
                'beforePackagesSha256': hashlib.sha256(before.encode()).hexdigest(),
                'installedClosureSnapshotSha256': hashlib.sha256(installed.encode()).hexdigest(),
                'compiler': compiler, 'alias': alias, 'helperBuild': helpers, 'helperSources': data['helperSources'], 'ownedPackageStageRemoved': True}


def main():
    global DEADLINE
    DEADLINE = time.monotonic() + 240
    report = {'formatVersion': 1, 'scope': 'verification-only-compiler-prerequisite', 'ok': False,
              'fleurSetupAction': False, 'runtimeSupport': 'unverified', 'installationEvidence': 'pending'}
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('Compiler preparation accepts only the owned guest nonce')
        report = provision(Path.cwd() / 'compiler-debs', sys.argv[1])
    except Exception as error:
        report.update(STATE)
        report['error'] = {'code': 'COMPILER_PREREQUISITE_FAILED', 'message': str(error)}
    print(json.dumps(report, separators=(',', ':')))
    return 0 if report['ok'] else 4


if __name__ == '__main__':
    sys.exit(main())

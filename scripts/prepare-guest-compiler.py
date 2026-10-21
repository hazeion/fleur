"""Offline verification prerequisite, never a Fleur setup action or release admission."""
from contextlib import contextmanager
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
COMMAND_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
BINUTILS = {
    'as': {'target': '/usr/bin/x86_64-linux-gnu-as', 'sha256': '21aff249b692b5c31a44007491f922dcb49f41323e362c57d2ada3f52eddb7f0', 'bytes': 745768},
    'ld': {'target': '/usr/bin/x86_64-linux-gnu-ld.bfd', 'sha256': 'e9ceb054c12207970f2726dfc07e9a66b411602748628baf27399f02a9bbb31b', 'bytes': 1359128},
}
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
                             start_new_session=True, env={'PATH': COMMAND_PATH, 'LC_ALL': 'C', 'DEBIAN_FRONTEND': 'noninteractive', 'DPKG_COLORS': 'never'})
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


def rollback_binutils_aliases(parent, receipt):
    """Atomically claim names; never unlink a replacement observed at cleanup."""
    confirmed = True
    quarantine = None
    quarantine_fd = None
    try:
        for row in reversed(receipt['aliases']):
            name = row['path'].rsplit('/', 1)[1]
            if row['identity'] is None:
                row['rollback'] = 'creation-custody-unconfirmed'; confirmed = False
                continue
            try:
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                row['rollback'] = 'already-absent'
                continue
            if identity(current) != row['identity'] or not stat.S_ISLNK(current.st_mode) or os.readlink(name, dir_fd=parent) != row['target']:
                row['rollback'] = 'foreign-preserved'; confirmed = False
                continue
            if quarantine is None:
                quarantine = tempfile.mkdtemp(prefix='fleur-compiler-alias-cleanup-', dir='/var/tmp')
                quarantine_fd = os.open(quarantine, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                value = os.fstat(quarantine_fd)
                if not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or value.st_mode & 0o077:
                    raise RuntimeError('Binutils cleanup quarantine custody differs')
            os.rename(name, name, src_dir_fd=parent, dst_dir_fd=quarantine_fd)
            claimed = os.stat(name, dir_fd=quarantine_fd, follow_symlinks=False)
            if (claimed.st_dev, claimed.st_ino) != row['identity'][:2] or claimed.st_uid != 0 or not stat.S_ISLNK(claimed.st_mode) or os.readlink(name, dir_fd=quarantine_fd) != row['target']:
                row['rollback'] = 'foreign-quarantined'; confirmed = False
                receipt['retainedQuarantine'] = quarantine
                continue
            os.unlink(name, dir_fd=quarantine_fd)
            row['rollback'] = 'owned-removed'
    except Exception as error:
        confirmed = False
        receipt['cleanupError'] = str(error)
        if quarantine is not None:
            receipt['retainedQuarantine'] = quarantine
    finally:
        if quarantine_fd is not None:
            try:
                if not os.listdir(quarantine_fd):
                    current = os.stat(quarantine, follow_symlinks=False)
                    retained = os.fstat(quarantine_fd)
                    if (current.st_dev, current.st_ino) != (retained.st_dev, retained.st_ino):
                        raise RuntimeError('Binutils cleanup quarantine changed')
                    os.rmdir(quarantine)
                    receipt.pop('retainedQuarantine', None)
            except Exception as error:
                confirmed = False; receipt['cleanupError'] = str(error)
            finally:
                os.close(quarantine_fd)
        receipt['cleanupConfirmed'] = confirmed
    return confirmed


@contextmanager
def authenticated_binutils_aliases(command):
    """Expose only the authenticated existing tools under generic compiler names."""
    receipt = {'aliases': [], 'compilerSearch': {}, 'cleanupConfirmed': None}
    STATE['binutilsAliases'] = receipt
    retained = []
    parent = None
    try:
        for directory in ('/', '/usr', '/usr/bin', '/usr/local', '/usr/local/bin', '/usr/local/sbin', '/usr/sbin'):
            value = os.lstat(directory)
            if not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or value.st_mode & 0o022:
                raise RuntimeError('Binutils ancestry is unsafe')
        for directory, canonical in (('/bin', '/usr/bin'), ('/sbin', '/usr/sbin')):
            value = os.lstat(directory)
            if stat.S_ISLNK(value.st_mode):
                if value.st_uid != 0 or os.readlink(directory) not in (canonical, canonical[1:]):
                    raise RuntimeError('Binutils PATH ancestry is unsafe')
            elif not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or value.st_mode & 0o022:
                raise RuntimeError('Binutils PATH ancestry is unsafe')
        for name, pin in BINUTILS.items():
            descriptor = os.open(pin['target'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            file = os.fdopen(descriptor, 'rb'); retained.append((file, pin))
            before = os.fstat(file.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o022 or before.st_nlink != 1 or before.st_size != pin['bytes'] or not before.st_mode & 0o111:
                raise RuntimeError('Binutils target custody differs')
            body = file.read(pin['bytes'] + 1)
            if len(body) != pin['bytes'] or hashlib.sha256(body).hexdigest() != pin['sha256'] or body[:6] != b'\x7fELF\x02\x01' or int.from_bytes(body[18:20], 'little') != 62 or identity(before) != identity(os.fstat(file.fileno())) or identity(before) != identity(os.stat(pin['target'], follow_symlinks=False)):
                raise RuntimeError('Binutils target authenticated identity differs')
            pin = {**pin, 'identity': identity(before)}; retained[-1] = (file, pin)
        for name in BINUTILS:
            for directory in COMMAND_PATH.split(':'):
                try: os.lstat(directory + '/' + name)
                except FileNotFoundError: continue
                raise RuntimeError('Existing generic binutils tool was preserved')
        parent = os.open('/usr/local/bin', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        parent_stat = os.fstat(parent)
        if not stat.S_ISDIR(parent_stat.st_mode) or parent_stat.st_uid != 0 or parent_stat.st_mode & 0o022:
            raise RuntimeError('Binutils alias parent custody differs')
        parent_identity = (parent_stat.st_dev, parent_stat.st_ino)
        for name, pin in BINUTILS.items():
            os.symlink(pin['target'], name, dir_fd=parent)
            row = {'path': '/usr/local/bin/' + name, 'target': pin['target'], 'targetSha256': pin['sha256'], 'targetBytes': pin['bytes'], 'elfMachine': 62, 'created': True, 'identity': None}
            receipt['aliases'].append(row)
            value = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISLNK(value.st_mode) or value.st_uid != 0 or os.readlink(name, dir_fd=parent) != pin['target']:
                raise RuntimeError('New binutils alias custody differs')
            row.update(device=value.st_dev, inode=value.st_ino, identity=identity(value))
        current_parent = os.stat('/usr/local/bin', follow_symlinks=False)
        if parent_identity != (current_parent.st_dev, current_parent.st_ino) or current_parent.st_uid != 0 or current_parent.st_mode & 0o022:
            raise RuntimeError('Binutils alias parent changed')
        for compiler in (COMPILER, str(ALIAS)):
            receipt['compilerSearch'][compiler] = {}
            for name in BINUTILS:
                reported = command([compiler, '-print-prog-name=' + name], timeout=5).strip()
                expected = '/usr/local/bin/' + name
                if reported == name:
                    resolved = None
                    for directory in COMMAND_PATH.split(':'):
                        try: os.lstat(directory + '/' + name)
                        except FileNotFoundError: continue
                        resolved = directory + '/' + name; break
                else: resolved = os.path.normpath(reported) if reported.startswith('/') else None
                if resolved != expected:
                    raise RuntimeError('Compiler subtool search did not select the authenticated alias')
                receipt['compilerSearch'][compiler][name] = resolved
        def verify_retained():
            for file, pin in retained:
                file.seek(0)
                body = file.read(pin['bytes'] + 1)
                if len(body) != pin['bytes'] or hashlib.sha256(body).hexdigest() != pin['sha256'] or pin['identity'] != identity(os.fstat(file.fileno())) or pin['identity'] != identity(os.stat(pin['target'], follow_symlinks=False)):
                    raise RuntimeError('Binutils target changed during helper compilation')
            for row in receipt['aliases']:
                name = row['path'].rsplit('/', 1)[1]
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if identity(current) != row['identity'] or not stat.S_ISLNK(current.st_mode) or current.st_uid != 0 or os.readlink(name, dir_fd=parent) != row['target']:
                    raise RuntimeError('Binutils alias changed during helper compilation')
            current_parent = os.stat('/usr/local/bin', follow_symlinks=False)
            if parent_identity != (current_parent.st_dev, current_parent.st_ino) or current_parent.st_uid != 0 or current_parent.st_mode & 0o022:
                raise RuntimeError('Binutils alias parent changed during helper compilation')
        verify_retained()
        yield receipt
        verify_retained()
        receipt['retainedForRestriction'] = True
    except Exception as error:
        if parent is not None and not rollback_binutils_aliases(parent, receipt):
            raise RuntimeError(str(error) + '; binutils alias cleanup could not be confirmed') from error
        raise
    finally:
        for file, _ in retained: file.close()
        if parent is not None: os.close(parent)


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
        with authenticated_binutils_aliases(command) as binutils:
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
                'compiler': compiler, 'alias': alias, 'binutilsAliases': binutils, 'helperBuild': helpers, 'helperSources': data['helperSources'], 'ownedPackageStageRemoved': True}


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

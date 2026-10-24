"""Private fixture administrator transition between two owned VM kernel boots.

This does not reconcile Fleur setup or modify product evidence/authority. It
archives the original root boot manifest and creates separately bound custody.
"""
import hashlib
import types
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys
import time

UUID = r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'
SHA = r'[a-f0-9]{64}'


def protected(path, maximum, mode=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022 or not 0 < info.st_size <= maximum or mode is not None and stat.S_IMODE(info.st_mode) != mode:
            raise RuntimeError('Unsafe original root fixture input')
        body = os.read(fd, info.st_size + 1)
        after = os.fstat(fd)
        named = Path(path).lstat()
        fields = lambda item: (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid, item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        if len(body) != info.st_size or fields(info) != fields(after) or fields(info) != fields(named):
            raise RuntimeError('Original root fixture input changed')
        return body, info
    finally:
        os.close(fd)


def flush(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe root fixture parent')
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    if os.getuid() != 0 or os.geteuid() != 0 or len(sys.argv) != 7:
        raise RuntimeError('Explicit owned fixture administrator and complete original binding required')
    nonce, old_boot, old_sha, machine_sha, producer_sha, uid_text = sys.argv[1:]
    if not re.fullmatch(UUID, nonce) or not re.fullmatch(UUID, old_boot) or any(not re.fullmatch(SHA, value) for value in (old_sha, machine_sha, producer_sha)) or not re.fullmatch(r'[1-9][0-9]{0,9}', uid_text):
        raise RuntimeError('Invalid original reboot transition identity')
    uid = int(uid_text)
    if uid != pwd.getpwnam('fleur').pw_uid:
        raise RuntimeError('Original ordinary fixture account differs')
    marker, _ = protected('/etc/fleur-owned-guest', 36, 0o444)
    before, original = protected('/etc/fleur-owned-guest.json', 2048, 0o444)
    machine, _ = protected('/etc/machine-id', 65)
    producer, _ = protected('/usr/local/lib/fleur-owned-guest.py', 65536, 0o444)
    if marker != nonce.encode() or hashlib.sha256(before).hexdigest() != old_sha or hashlib.sha256(machine).hexdigest() != machine_sha or hashlib.sha256(producer).hexdigest() != producer_sha:
        raise RuntimeError('Original seed, machine, manifest or producer differs')
    old = json.loads(before)
    if set(old) != {'formatVersion', 'nonce', 'bootId', 'uid', 'osRelease'} or type(old['formatVersion']) is not int or old['formatVersion'] != 1 or old['nonce'] != nonce or old['bootId'] != old_boot or type(old['uid']) is not int or old['uid'] != uid:
        raise RuntimeError('Original boot manifest binding differs')
    module = types.ModuleType('owned_reboot_producer')
    module.__file__ = '/usr/local/lib/fleur-owned-guest.py'
    if module.__name__ in sys.modules:
        raise RuntimeError('Owned producer namespace is occupied')
    sys.modules[module.__name__] = module
    exec(compile(producer, module.__file__, 'exec'), module.__dict__)
    deadline = time.monotonic() + 10
    current_boot, _custody, release = module.environment(deadline)
    if current_boot == old_boot or release != old['osRelease'] or release.get('id') != 'debian' or release.get('versionId') != '13':
        raise RuntimeError('Different kernel boot and unchanged original Debian13 target required')
    directory = Path('/etc') / ('fleur-owned-reboot-' + nonce)
    directory.mkdir(mode=0o700)
    flush('/etc')
    # Root-only exclusive directory; no preexisting destination can be adopted.
    latest, current = protected('/etc/fleur-owned-guest.json', 2048, 0o444)
    if latest != before or (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
        raise RuntimeError('Original manifest changed before archival')
    os.rename('/etc/fleur-owned-guest.json', directory / 'original.json')
    flush(directory)
    flush('/etc')
    created = module.create(nonce, deadline=deadline, fixture='debian13-amd64')
    after, _new_info = protected('/etc/fleur-owned-guest.json', 2048, 0o444)
    now = json.loads(after)
    archived, archived_info = protected(directory / 'original.json', 2048, 0o444)
    if archived != before or (archived_info.st_dev, archived_info.st_ino) != (original.st_dev, original.st_ino) or now != {**old, 'bootId': current_boot} or created['manifestSha256'] != hashlib.sha256(after).hexdigest():
        raise RuntimeError('New custody or original inode preservation differs')
    result = {'formatVersion': 1, 'scope': 'owned-guest-explicit-reboot-transition', 'ok': True,
              'nonce': nonce, 'uid': uid, 'originalBootId': old_boot, 'currentBootId': current_boot,
              'originalManifestSha256': old_sha, 'currentManifestSha256': created['manifestSha256'],
              'originalManifestIdentity': {'dev': str(original.st_dev), 'ino': str(original.st_ino)},
              'machineSha256': machine_sha, 'producerSha256': producer_sha,
              'helperSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'runtimeAdmission': False, 'humanConsentProof': False, 'historicalTransactionOutcome': 'unknown'}
    body = json.dumps(result, sort_keys=True, separators=(',', ':')).encode()
    fd = os.open(directory / 'transition.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
    try:
        os.fchmod(fd, 0o444)
        offset = 0
        while offset < len(body):
            count = os.write(fd, body[offset:])
            if count <= 0:
                raise RuntimeError('Transition receipt publication made no progress')
            offset += count
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chmod(directory, 0o755)
    flush(directory)
    flush('/etc')
    if time.monotonic() >= deadline:
        raise TimeoutError('Original reboot custody deadline expired')
    print(json.dumps({**result, 'receiptSha256': hashlib.sha256(body).hexdigest()}, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'formatVersion': 1, 'scope': 'owned-guest-explicit-reboot-transition', 'ok': False, 'runtimeAdmission': False, 'humanConsentProof': False, 'error': str(error)}, separators=(',', ':')))
        sys.exit(4)

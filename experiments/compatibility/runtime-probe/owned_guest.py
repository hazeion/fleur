"""Explicit disposable guest fixture custody, never runtime profile admission.

The account has sudo. These checks bind an owned fixture across transports; they
are not proof against a privileged adversary, human consent or CPU performance.
"""
from dataclasses import dataclass
import hashlib
import json
import math
import os
import platform
import pwd
import re
import stat
import subprocess
import sys
import time

MARKER = '/etc/fleur-owned-guest'
MANIFEST = '/etc/fleur-owned-guest.json'
ROOT_VALIDATOR = '/usr/local/lib/fleur-owned-guest.py'
NONCE = r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
BOOT = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
HOSTED = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux',
          'GITHUB_REPOSITORY': 'hazeion/fleur', 'GITHUB_WORKFLOW': 'Compatibility experiments',
          'GITHUB_JOB': 'runtime-probe'}


def identity(value):
    fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid')
    # Other root-owned entries may change during installation. Retain directory
    # identity/permissions, while file byte custody also retains size and times.
    if not stat.S_ISDIR(value.st_mode):
        fields += ('st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    return tuple(getattr(value, key) for key in fields)


def budget_remaining(deadline, maximum=None):
    if type(deadline) not in (int, float) or not math.isfinite(deadline):
        raise ValueError('owned guest deadline required')
    left = deadline - time.monotonic()
    if left <= 0:
        raise ValueError('owned guest custody deadline expired')
    return min(maximum, left) if maximum is not None else left


def operation_deadline(deadline):
    value = time.monotonic() + 10 if deadline is None else deadline
    budget_remaining(value)
    return value


def protected_read(path, maximum, exact_mode=None, *, deadline=None):
    """Traverse without symlinks, retain descriptors, compare published identities."""
    deadline = operation_deadline(deadline)
    descriptors = []
    identities = []
    try:
        directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(directory)
        parts = path.strip('/').split('/')
        for index, part in enumerate([''] + parts[:-1]):
            if index:
                directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                    dir_fd=directory)
                descriptors.append(directory)
            info = os.fstat(directory)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('protected ancestor')
            identities.append(('/' + '/'.join(parts[:index]), identity(info)))
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        descriptors.append(fd)
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_gid != 0
                or before.st_nlink != 1 or before.st_mode & 0o022 or before.st_size > maximum
                or exact_mode is not None and stat.S_IMODE(before.st_mode) != exact_mode):
            raise ValueError('protected file')
        body = bytearray()
        while len(body) <= maximum:
            budget_remaining(deadline)
            chunk = os.read(fd, min(4096, maximum + 1 - len(body)))
            if not chunk:
                break
            body.extend(chunk)
        if len(body) > maximum or identity(os.fstat(fd)) != identity(before):
            raise ValueError('changed file')
        identities.append((path, identity(before)))
        for name, expected in identities:
            if identity(os.stat(name or '/', follow_symlinks=False)) != expected:
                raise ValueError('changed custody')
        budget_remaining(deadline)
        return bytes(body), tuple(identities)
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def environment(deadline=None):
    deadline = operation_deadline(deadline)
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise ValueError('guest platform')
    release_bytes, release_identity = protected_read('/usr/lib/os-release', 16384, deadline=deadline)
    release = release_bytes.decode()
    fields = {}
    for line in release.splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            if key in fields:
                raise ValueError('duplicate release field')
            fields[key] = value.strip('"')
    if (fields.get('ID'), fields.get('VERSION_ID')) not in (('ubuntu', '24.04'), ('ubuntu', '26.04'), ('debian', '13')):
        raise ValueError('guest distribution')
    if protected_read('/proc/1/comm', 64, deadline=deadline)[0] != b'systemd\n':
        raise ValueError('guest init')
    protected_read('/usr/bin/systemd-detect-virt', 8 * 1024 * 1024, deadline=deadline)
    virtualization = subprocess.run(['/usr/bin/systemd-detect-virt'], stdin=subprocess.DEVNULL,
        capture_output=True, timeout=budget_remaining(deadline, 3), check=False, env={'PATH': '/usr/bin:/bin'})
    budget_remaining(deadline)
    if (virtualization.returncode != 0 or len(virtualization.stdout) > 64
            or len(virtualization.stderr) > 512 or virtualization.stdout not in (b'qemu\n', b'kvm\n')):
        raise ValueError('guest virtualization')
    boot_id = protected_read('/proc/sys/kernel/random/boot_id', 64, deadline=deadline)[0].decode().rstrip('\n')
    if re.fullmatch(BOOT, boot_id) is None:
        raise ValueError('guest boot identity')
    release_digest = hashlib.sha256(release_bytes).hexdigest()
    return boot_id, (release_identity, release_digest), {'id': fields['ID'], 'versionId': fields['VERSION_ID'], 'sha256': release_digest}


def object_pairs(pairs):
    value = {}
    for key, field in pairs:
        if key in value:
            raise ValueError('duplicate manifest key')
        value[key] = field
    return value


@dataclass(frozen=True)
class OwnedGuestContext:
    nonce: str
    boot_id: str
    uid: int
    manifest_sha256: str
    files: tuple
    os_release: tuple = ()

    def verify(self, remaining=None, *, absolute_deadline=None):
        if remaining is not None and (type(remaining) not in (int, float) or not math.isfinite(remaining) or remaining <= 0):
            raise ValueError('owned guest remaining budget required')
        deadline = time.monotonic() + (10 if remaining is None else min(10, remaining))
        if absolute_deadline is not None:
            if type(absolute_deadline) not in (int, float) or not math.isfinite(absolute_deadline):
                raise ValueError('owned guest absolute deadline required')
            deadline = min(deadline, absolute_deadline)
        budget_remaining(deadline)
        if validate(self.nonce, deadline=deadline) != self:
            raise ValueError('owned guest context changed')
        budget_remaining(deadline)

    def custody_digest(self):
        return hashlib.sha256(json.dumps(self.files, separators=(',', ':'), allow_nan=False).encode()).hexdigest()

    def report(self):
        return {'nonce': self.nonce, 'bootId': self.boot_id, 'uid': self.uid,
                'manifestSha256': self.manifest_sha256, 'fixtureCustodyValidated': True}


def validate(nonce, *, deadline=None, ordinary_uid=None):
    deadline = operation_deadline(deadline)
    if type(nonce) is not str or re.fullmatch(NONCE, nonce) is None:
        raise ValueError('explicit canonical owned nonce required')
    if any(key in os.environ for key in HOSTED):
        raise ValueError('ambiguous hosted and owned scope')
    if ordinary_uid is None:
        uid = os.getuid()
        if uid <= 0:
            raise ValueError('ordinary guest identity required')
    else:
        if os.getuid() != 0 or os.geteuid() != 0 or type(ordinary_uid) is not int or not 0 < ordinary_uid < 2**31:
            raise ValueError('root validator and original ordinary UID required')
        uid = ordinary_uid
    boot_id, release_custody, os_release = environment(deadline)
    marker, marker_identity = protected_read(MARKER, 36, 0o444, deadline=deadline)
    manifest, manifest_identity = protected_read(MANIFEST, 2048, 0o444, deadline=deadline)
    producer, producer_identity = protected_read(ROOT_VALIDATOR, 32768, 0o444, deadline=deadline)
    with open(__file__, 'rb') as source:
        expected_source = source.read(32769)
    if len(expected_source) > 32768 or hashlib.sha256(producer).digest() != hashlib.sha256(expected_source).digest():
        raise ValueError('root validator source differs')
    budget_remaining(deadline)
    parsed = json.loads(manifest, object_pairs_hook=object_pairs)
    if (marker != nonce.encode() or type(parsed) is not dict
            or set(parsed) != {'formatVersion', 'nonce', 'bootId', 'uid', 'osRelease'}
            or type(parsed['formatVersion']) is not int or parsed['formatVersion'] != 1
            or parsed['nonce'] != nonce or parsed['bootId'] != boot_id
            or parsed['osRelease'] != os_release
            or type(parsed['uid']) is not int or parsed['uid'] != uid):
        raise ValueError('owned manifest binding')
    context = OwnedGuestContext(nonce, boot_id, uid, hashlib.sha256(manifest).hexdigest(),
                                (marker_identity, manifest_identity, producer_identity, release_custody),
                                tuple(os_release[key] for key in ('id', 'versionId', 'sha256')))
    budget_remaining(deadline)
    return context


def create(nonce, *, deadline=None, fixture='ubuntu24-amd64'):
    deadline = operation_deadline(deadline)
    if os.getuid() != 0 or os.geteuid() != 0 or type(nonce) is not str or re.fullmatch(NONCE, nonce) is None:
        raise ValueError('root boot producer and canonical nonce required')
    if type(fixture) is not str or fixture not in ('ubuntu24-amd64', 'ubuntu26-amd64', 'debian13-amd64'):
        raise ValueError('source-owned guest fixture required')
    boot_id, _release_custody, os_release = environment(deadline)
    target = {'ubuntu24-amd64': ('ubuntu', '24.04'), 'ubuntu26-amd64': ('ubuntu', '26.04'), 'debian13-amd64': ('debian', '13')}[fixture]
    if (os_release['id'], os_release['versionId']) != target:
        raise ValueError('guest differs from source-owned seed target')
    if protected_read(MARKER, 36, 0o444, deadline=deadline)[0] != nonce.encode():
        raise ValueError('seed nonce differs')
    uid = pwd.getpwnam('fleur').pw_uid
    if type(uid) is not int or uid <= 0:
        raise ValueError('guest account absent')
    body = json.dumps({'formatVersion': 1, 'nonce': nonce, 'bootId': boot_id, 'uid': uid, 'osRelease': os_release},
                      sort_keys=True, separators=(',', ':')).encode()
    directory = os.open('/etc', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('manifest parent')
        fd = os.open('fleur-owned-guest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o444, dir_fd=directory)
        try:
            os.fchmod(fd, 0o444)
            offset = 0
            while offset < len(body):
                written = os.write(fd, body[offset:])
                if written <= 0:
                    raise OSError('manifest write')
                offset += written
            os.fsync(fd)
            if os.fstat(fd).st_uid != 0 or os.fstat(fd).st_nlink != 1:
                raise ValueError('manifest ownership')
        finally:
            os.close(fd)
        os.fsync(directory)
    finally:
        os.close(directory)
    budget_remaining(deadline)
    return {'nonce': nonce, 'bootId': boot_id, 'uid': uid,
            'manifestSha256': hashlib.sha256(body).hexdigest(), 'manifestCreated': True}


def verify_root_control(text, *, deadline):
    if os.getuid() != 0 or os.geteuid() != 0 or type(text) is not str or len(text.encode()) > 2048:
        raise ValueError('fixed root validation invocation required')
    value = json.loads(text, object_pairs_hook=object_pairs)
    if (type(value) is not dict or set(value) != {'formatVersion', 'nonce', 'bootId', 'uid', 'manifestSha256', 'custodySha256', 'deadlineMonotonic'}
            or type(value['formatVersion']) is not int or value['formatVersion'] != 1
            or type(value['nonce']) is not str or re.fullmatch(NONCE, value['nonce']) is None
            or type(value['bootId']) is not str or re.fullmatch(BOOT, value['bootId']) is None
            or type(value['uid']) is not int or not 0 < value['uid'] < 2**31
            or any(type(value[key]) is not str or re.fullmatch(r'[a-f0-9]{64}', value[key]) is None for key in ('manifestSha256', 'custodySha256'))
            or type(value['deadlineMonotonic']) not in (int, float) or not math.isfinite(value['deadlineMonotonic'])):
        raise ValueError('complete original root control binding required')
    started = time.monotonic()
    original = value['deadlineMonotonic']
    if not started < original <= started + 600:
        raise ValueError('original root control deadline expired or expanded')
    end = min(deadline, original)
    budget_remaining(end)
    context = validate(value['nonce'], deadline=end, ordinary_uid=value['uid'])
    if ((context.boot_id, context.uid, context.manifest_sha256, context.custody_digest())
            != (value['bootId'], value['uid'], value['manifestSha256'], value['custodySha256'])):
        raise ValueError('original root control custody changed')
    budget_remaining(end)
    return {**context.report(), 'custodySha256': context.custody_digest(),
            'deadlineMonotonic': original, 'rootValidation': True}


def main(arguments):
    started = time.monotonic()
    deadline = started + 10
    result = {'formatVersion': 1, 'scope': 'owned-guest-custody-validation', 'ok': False,
              'runtimeSupport': 'unverified', 'runtimeAdmission': False,
              'humanConsentProof': False, 'nativeCpuPerformanceProof': False}
    try:
        if len(arguments) == 4 and arguments[2] == '--budget-seconds':
            raw_budget = arguments[3]
            if type(raw_budget) is not str or re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', raw_budget) is None:
                raise ValueError('finite positive owned budget required')
            seconds = float(raw_budget)
            if not math.isfinite(seconds) or not 0 < seconds <= 10:
                raise ValueError('owned budget may only narrow ten seconds')
            deadline = started + seconds
            arguments = arguments[:2]
        budget_remaining(deadline)
        if len(arguments) != 2 or arguments[0] not in ('--owned-guest-nonce', '--create', '--create-ubuntu26', '--create-debian13', '--verify-control'):
            raise ValueError('explicit invocation required')
        if arguments[0] == '--verify-control':
            result['scope'] = 'owned-guest-root-control-validation'
            result.update(verify_root_control(arguments[1], deadline=deadline))
            deadline = min(deadline, result['deadlineMonotonic'])
        elif arguments[0] in ('--create', '--create-ubuntu26', '--create-debian13'):
            result['scope'] = 'owned-guest-boot-manifest'
            result.update(create(arguments[1], deadline=deadline, fixture={'--create':'ubuntu24-amd64', '--create-ubuntu26':'ubuntu26-amd64', '--create-debian13':'debian13-amd64'}[arguments[0]]))
        else:
            context = validate(arguments[1], deadline=deadline)
            context.verify(budget_remaining(deadline), absolute_deadline=deadline)
            result.update(context.report())
            # Ordinary observation only; the strict root-control reply is unchanged.
            result['osRelease'] = dict(zip(('id', 'versionId', 'sha256'), context.os_release))
        budget_remaining(deadline)
        result['ok'] = True
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.TimeoutExpired):
        result['error'] = {'code': 'OWNED_GUEST_CUSTODY_UNVERIFIED',
                           'message': 'Explicit owned guest fixture custody could not be established.'}
    print(json.dumps(result))
    return 0 if result['ok'] else 4


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))

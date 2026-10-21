"""Internal fixed-name artifact staging; policy is supplied only by trusted code."""
from dataclasses import dataclass
import hashlib
import math
import json
import time
import os
import stat
from pathlib import Path
from runtime_profile import native_elf_identity


class HelperArtifactUnverified(ValueError):
    def __init__(self, message, *, recovery_required=False):
        super().__init__(message)
        self.recovery_required = recovery_required
        self.cleanup_confirmed = not recovery_required


@dataclass(frozen=True)
class ArtifactPin:
    bytes: int
    sha256: str


@dataclass(frozen=True)
class PairSpec:
    filter: ArtifactPin
    abuse: ArtifactPin


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def stage_pair(source_directory, destination_directory, pair_spec, absolute_deadline):
    def remaining():
        if type(absolute_deadline) not in (int, float) or not math.isfinite(absolute_deadline) or time.monotonic() >= absolute_deadline:
            raise ValueError('artifact deadline expired')
    remaining()
    if type(pair_spec) is not PairSpec or any(type(pin) is not ArtifactPin or type(pin.bytes) is not int or not 0 < pin.bytes <= 47576 or type(pin.sha256) is not str or len(pin.sha256) != 64 or any(character not in '0123456789abcdef' for character in pin.sha256) for pin in (pair_spec.filter, pair_spec.abuse)) or pair_spec.filter.bytes+pair_spec.abuse.bytes > 47576:
        raise HelperArtifactUnverified('artifact catalog differs')
    directories = []
    inputs = []
    outputs = []
    publication_attempted = False
    try:
        for path in (source_directory, destination_directory):
            remaining()
            try:
                fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
            except OSError as error:
                raise ValueError('artifact parent custody differs') from error
            directories.append((path, fd, None))
            directories[-1] = (path, fd, os.fstat(fd))
        def parents_unchanged():
            remaining()
            for path, fd, before in directories:
                held = os.fstat(fd)
                named = os.stat(path, follow_symlinks=False)
                if not stat.S_ISDIR(held.st_mode) or held.st_uid != os.getuid() or held.st_mode & 0o077 or (held.st_dev, held.st_ino, held.st_mode, held.st_uid) != (before.st_dev, before.st_ino, before.st_mode, before.st_uid) or (named.st_dev, named.st_ino, named.st_mode, named.st_uid) != (held.st_dev, held.st_ino, held.st_mode, held.st_uid):
                    raise ValueError('artifact parent custody changed')
        parents_unchanged()
        source_fd, destination_fd = directories[0][1], directories[1][1]
        authenticated = {}
        for name, pin in [('filter.so', pair_spec.filter), ('abuse', pair_spec.abuse)]:
            remaining()
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
            except OSError as error:
                raise ValueError('artifact custody differs') from error
            inputs.append((name, fd, None))
            before = os.fstat(fd)
            inputs[-1] = (name, fd, before)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_mode & 0o077:
                raise ValueError('artifact custody differs')
            body = bytearray()
            while len(body) <= pin.bytes:
                remaining()
                block = os.read(fd, min(65536, pin.bytes+1-len(body)))
                if not block:
                    break
                body.extend(block)
            if len(body) != pin.bytes or hashlib.sha256(body).hexdigest() != pin.sha256:
                raise ValueError('artifact digest differs')
            if _identity(before) != _identity(os.fstat(fd)) or _identity(before) != _identity(os.stat(name, dir_fd=source_fd, follow_symlinks=False)):
                raise ValueError('artifact custody changed')
            parents_unchanged()
            authenticated[name] = bytes(body)
        files = {}
        for name, body in authenticated.items():
            parents_unchanged()
            publication_attempted = True
            try:
                fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=destination_fd)
            except OSError as error:
                raise ValueError('artifact publication refused') from error
            outputs.append((name, fd, None))
            position = 0
            while position < len(body):
                remaining()
                written = os.write(fd, body[position:])
                if written <= 0:
                    raise ValueError('artifact publication incomplete')
                position += written
            os.fsync(fd)
            before = os.fstat(fd)
            outputs[-1] = (name, fd, before)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_mode & 0o077 or before.st_size != len(body):
                raise ValueError('artifact output custody differs')
            for retained in (fd,):
                os.lseek(retained, 0, os.SEEK_SET)
                readback = bytearray()
                while len(readback) <= len(body):
                    remaining()
                    block = os.read(retained, min(65536, len(body)+1-len(readback)))
                    if not block:
                        break
                    readback.extend(block)
                if bytes(readback) != body:
                    raise ValueError('artifact output bytes differ')
            try:
                named_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=destination_fd)
            except OSError as error:
                raise ValueError('artifact output name changed') from error
            try:
                if _identity(before) != _identity(os.fstat(named_fd)):
                    raise ValueError('artifact output name changed')
                readback = bytearray()
                while len(readback) <= len(body):
                    remaining()
                    block = os.read(named_fd, min(65536, len(body)+1-len(readback)))
                    if not block:
                        break
                    readback.extend(block)
                if bytes(readback) != body:
                    raise ValueError('artifact output bytes differ')
            finally:
                os.close(named_fd)
            if _identity(before) != _identity(os.fstat(fd)) or _identity(before) != _identity(os.stat(name, dir_fd=destination_fd, follow_symlinks=False)):
                raise ValueError('artifact output custody changed')
            parents_unchanged()
            files[name] = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'header': body[:64], 'identity': _identity(before)}
        for name, fd, before in outputs:
            remaining()
            if _identity(before) != _identity(os.fstat(fd)) or _identity(before) != _identity(os.stat(name, dir_fd=destination_fd, follow_symlinks=False)):
                raise ValueError('artifact output custody changed')
        for name, fd, before in inputs:
            remaining()
            if _identity(before) != _identity(os.fstat(fd)) or _identity(before) != _identity(os.stat(name, dir_fd=source_fd, follow_symlinks=False)):
                raise ValueError('artifact custody changed')
        parents_unchanged()
        parent = os.fstat(destination_fd)
        return {'files': files, 'parent_identity': (parent.st_dev, parent.st_ino, parent.st_uid, parent.st_mode)}
    except (OSError, ValueError) as error:
        message = 'artifact operation failed' if isinstance(error, OSError) else str(error)
        raise HelperArtifactUnverified(message, recovery_required=publication_attempted) from error
    finally:
        for _, fd, _ in reversed(outputs):
            os.close(fd)
        for _, fd, _ in reversed(inputs):
            os.close(fd)
        for _, fd, _ in reversed(directories):
            os.close(fd)


RECORDED_MANIFEST_SHA256 = '26167bf5307aacabbec7f51e05e348418170d98075baa1964b971460988cf47b'


def _recorded_manifest(absolute_deadline):
    if type(absolute_deadline) not in (int, float) or not math.isfinite(absolute_deadline) or time.monotonic() >= absolute_deadline:
        raise HelperArtifactUnverified('artifact deadline expired')
    path = Path(__file__).with_name('recorded-helper-origin.json')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= 16384:
            raise HelperArtifactUnverified('recorded helper manifest custody differs')
        body = bytearray()
        while len(body) <= 16384:
            if time.monotonic() >= absolute_deadline:
                raise HelperArtifactUnverified('artifact deadline expired')
            block = os.read(fd, min(4096, 16385-len(body)))
            if not block:
                break
            body.extend(block)
        if hashlib.sha256(body).hexdigest() != RECORDED_MANIFEST_SHA256 or _identity(before) != _identity(os.fstat(fd)) or _identity(before) != _identity(os.stat(path, follow_symlinks=False)):
            raise HelperArtifactUnverified('recorded helper manifest differs')
        value = json.loads(body)
        if time.monotonic() >= absolute_deadline:
            raise HelperArtifactUnverified('artifact deadline expired')
        return value
    finally:
        os.close(fd)


def _recorded_sources(manifest, absolute_deadline):
    identities = {}
    for source in manifest['sources']:
        if time.monotonic() >= absolute_deadline:
            raise HelperArtifactUnverified('artifact deadline expired')
        path = Path(__file__).with_name(source['file'])
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != source['bytes']:
                    raise HelperArtifactUnverified('recorded helper source differs')
                body = bytearray()
                while len(body) <= source['bytes']:
                    if time.monotonic() >= absolute_deadline:
                        raise HelperArtifactUnverified('artifact deadline expired')
                    block = os.read(fd, min(65536, source['bytes']+1-len(body)))
                    if not block:
                        break
                    body.extend(block)
                if len(body) != source['bytes'] or hashlib.sha256(body).hexdigest() != source['sha256'] or _identity(before) != _identity(os.fstat(fd)) or _identity(before) != _identity(os.stat(path, follow_symlinks=False)):
                    raise HelperArtifactUnverified('recorded helper source differs')
                identities[source['file']] = _identity(before)
            finally:
                os.close(fd)
        except OSError as error:
            raise HelperArtifactUnverified('recorded helper source custody differs') from error
    if time.monotonic() >= absolute_deadline:
        raise HelperArtifactUnverified('artifact deadline expired')
    return identities


def stage_recorded_helpers(source_directory, destination_directory, architecture, base, absolute_deadline):
    manifest = _recorded_manifest(absolute_deadline)
    if architecture != manifest['architecture'] or base != manifest['baseImage']:
        raise HelperArtifactUnverified('recorded helper profile differs')
    source_identities = _recorded_sources(manifest, absolute_deadline)
    pins = {item['name']: ArtifactPin(item['bytes'], item['sha256']) for item in manifest['helpers']}
    staged = stage_pair(source_directory, destination_directory, PairSpec(pins['filter.so'], pins['abuse']), absolute_deadline)
    try:
        if time.monotonic() >= absolute_deadline:
            raise HelperArtifactUnverified('artifact deadline expired')
        directory = os.open(destination_directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            parent = os.fstat(directory)
            for name in ('filter.so', 'abuse'):
                if time.monotonic() >= absolute_deadline:
                    raise HelperArtifactUnverified('artifact deadline expired')
                item = staged['files'][name]
                item['elf'] = native_elf_identity(item['header'], architecture)
                if int.from_bytes(item['header'][16:18], 'little') != manifest['abi']['elfType']:
                    raise HelperArtifactUnverified('recorded helper ELF type differs')
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    if _identity(os.fstat(fd)) != item['identity']:
                        raise HelperArtifactUnverified('artifact output custody changed')
                    os.fchmod(fd, 0o555)
                    os.fsync(fd)
                    after = os.fstat(fd)
                    os.lseek(fd, 0, os.SEEK_SET)
                    sealed = bytearray()
                    while len(sealed) <= item['bytes']:
                        if time.monotonic() >= absolute_deadline:
                            raise HelperArtifactUnverified('artifact deadline expired')
                        block = os.read(fd, min(65536, item['bytes']+1-len(sealed)))
                        if not block:
                            break
                        sealed.extend(block)
                    if len(sealed) != item['bytes'] or hashlib.sha256(sealed).hexdigest() != item['sha256'] or _identity(after) != _identity(os.fstat(fd)):
                        raise HelperArtifactUnverified('artifact output bytes changed')
                    if after.st_dev != item['identity'][0] or after.st_ino != item['identity'][1] or _identity(after) != _identity(os.stat(name, dir_fd=directory, follow_symlinks=False)):
                        raise HelperArtifactUnverified('artifact output custody changed')
                    item['identity'] = _identity(after)
                finally:
                    os.close(fd)
            named = os.stat(destination_directory, follow_symlinks=False)
            if not stat.S_ISDIR(named.st_mode) or (named.st_dev, named.st_ino) != (parent.st_dev, parent.st_ino) or time.monotonic() >= absolute_deadline:
                raise HelperArtifactUnverified('artifact parent custody changed')
        finally:
            os.close(directory)
    except (OSError, ValueError) as error:
        raise HelperArtifactUnverified('recorded helper publication unconfirmed', recovery_required=True) from error
    try:
        if _recorded_sources(manifest, absolute_deadline) != source_identities:
            raise ValueError('recorded helper source custody changed')
    except (OSError, ValueError) as error:
        raise HelperArtifactUnverified('recorded helper source custody changed', recovery_required=True) from error
    staged['source_identities'] = source_identities
    staged['origin'] = _origin_record(manifest)
    return staged


def _origin_record(manifest):
    return {'mode': 'recorded-prebuilt', 'manifest_sha256': RECORDED_MANIFEST_SHA256,
            'architecture': manifest['architecture'], 'base_image': manifest['baseImage'],
            'local_compiler_executed': False, 'producer': manifest['producer'],
            'source_sha256': {item['file']: item['sha256'] for item in manifest['sources']},
            'helpers': manifest['helpers']}


def accept_helper_origin(report, recorded=False, absolute_deadline=None):
    """Validate report data against the source record; this does not stage or execute bytes."""
    if type(recorded) is not bool or type(report) is not dict:
        return False
    if not recorded:
        return report.get('compiler_status') == 'executed-pin' and report.get('compiler_pin_verified') is True and report.get('helper_origin') is None
    try:
        manifest = _recorded_manifest(absolute_deadline)
        expected = _origin_record(manifest)
        if report.get('expected_gcc') != manifest['producer']['compiler']['version'] or report.get('expected_gcc_binary_sha256') != manifest['producer']['compiler']['sha256']:
            return False
        if report.get('compiler_status') != 'prebuilt-origin' or report.get('compiler_pin_verified') is not False or 'gcc' in report or report.get('architecture') != manifest['architecture'] or report.get('base_image') != manifest['baseImage']:
            return False
        if json.dumps(report.get('helper_origin'), sort_keys=True, allow_nan=False) != json.dumps(expected, sort_keys=True, allow_nan=False):
            return False
        files = {item['name']: item for item in manifest['helpers']}
        return (time.monotonic() < absolute_deadline and report.get('helper_sha256') == files['filter.so']['sha256']
                and report.get('abuse_sha256') == files['abuse']['sha256']
                and all(report.get('source_sha256', {}).get(item['file']) == item['sha256'] for item in manifest['sources'])
                and all(json.dumps(report.get(field), sort_keys=True) == json.dumps({'class': 64, 'endianness': 'little', 'machine': 62}, sort_keys=True) for field in ('helper_elf', 'abuse_elf')))
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return False


def revalidate_pair(directory, pair_spec, staged, absolute_deadline):
    def remaining():
        if type(absolute_deadline) not in (int, float) or not math.isfinite(absolute_deadline) or time.monotonic() >= absolute_deadline:
            raise HelperArtifactUnverified('artifact deadline expired', recovery_required=True)
    remaining()
    if type(pair_spec) is not PairSpec or any(type(pin) is not ArtifactPin or type(pin.bytes) is not int or not 0 < pin.bytes <= 47576 for pin in (pair_spec.filter, pair_spec.abuse)):
        raise HelperArtifactUnverified('artifact catalog differs', recovery_required=True)
    parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
    files = []
    try:
        before = os.fstat(parent)
        expected_parent = (before.st_dev, before.st_ino, before.st_uid, before.st_mode)
        if expected_parent != staged.get('parent_identity') or before.st_uid != os.getuid() or before.st_mode & 0o077:
            raise HelperArtifactUnverified('artifact parent custody changed', recovery_required=True)
        for name, pin in [('filter.so', pair_spec.filter), ('abuse', pair_spec.abuse)]:
            remaining()
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            files.append((name, fd))
            expected = staged['files'][name]['identity']
            observed = os.fstat(fd)
            if _identity(observed) != expected or not stat.S_ISREG(observed.st_mode) or observed.st_uid != os.getuid() or observed.st_nlink != 1:
                raise HelperArtifactUnverified('artifact output custody changed', recovery_required=True)
            body = bytearray()
            while len(body) <= pin.bytes:
                remaining()
                block = os.read(fd, min(65536, pin.bytes+1-len(body)))
                if not block:
                    break
                body.extend(block)
            if len(body) != pin.bytes or hashlib.sha256(body).hexdigest() != pin.sha256:
                raise HelperArtifactUnverified('artifact output digest differs', recovery_required=True)
        for name, fd in files:
            remaining()
            expected = staged['files'][name]['identity']
            if _identity(os.fstat(fd)) != expected or _identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != expected:
                raise HelperArtifactUnverified('artifact output custody changed', recovery_required=True)
        named = os.stat(directory, follow_symlinks=False)
        held = os.fstat(parent)
        if (named.st_dev, named.st_ino, named.st_uid, named.st_mode) != expected_parent or (held.st_dev, held.st_ino, held.st_uid, held.st_mode) != expected_parent:
            raise HelperArtifactUnverified('artifact parent custody changed', recovery_required=True)
        remaining()
        return True
    except OSError as error:
        raise HelperArtifactUnverified('artifact output custody unconfirmed', recovery_required=True) from error
    finally:
        for _, fd in reversed(files):
            os.close(fd)
        os.close(parent)


def revalidate_recorded_helpers(directory, staged, absolute_deadline):
    try:
        manifest = _recorded_manifest(absolute_deadline)
        if _recorded_sources(manifest, absolute_deadline) != staged.get('source_identities'):
            raise HelperArtifactUnverified('recorded helper source custody changed', recovery_required=True)
        if json.dumps(staged.get('origin'), sort_keys=True, allow_nan=False) != json.dumps(_origin_record(manifest), sort_keys=True, allow_nan=False):
            raise HelperArtifactUnverified('recorded helper origin differs', recovery_required=True)
        pins = {item['name']: ArtifactPin(item['bytes'], item['sha256']) for item in manifest['helpers']}
        return revalidate_pair(directory, PairSpec(pins['filter.so'], pins['abuse']), staged, absolute_deadline)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise HelperArtifactUnverified('recorded helper prebuild custody unconfirmed', recovery_required=True) from error

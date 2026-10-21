"""Internal fixed-name artifact staging; policy is supplied only by trusted code."""
from dataclasses import dataclass
import hashlib
import math
import time
import os
import stat
from pathlib import Path


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
            files[name] = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'header': body[:64]}
        for name, fd, before in outputs:
            remaining()
            if _identity(before) != _identity(os.fstat(fd)) or _identity(before) != _identity(os.stat(name, dir_fd=destination_fd, follow_symlinks=False)):
                raise ValueError('artifact output custody changed')
        for name, fd, before in inputs:
            remaining()
            if _identity(before) != _identity(os.fstat(fd)) or _identity(before) != _identity(os.stat(name, dir_fd=source_fd, follow_symlinks=False)):
                raise ValueError('artifact custody changed')
        parents_unchanged()
        return {'files': files}
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

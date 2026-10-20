"""Build and inspect one owned NoCloud ISO. Never attach, mount or boot it."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import selectors
import signal
import time
import stat
import subprocess
import sys

LIMITS = {"user-data": 65536, "meta-data": 16384}
BLOCK = 2048
MAX_IMAGE = 8 * 1024 * 1024
report = {"formatVersion": 1, "scope": "owned-nocloud-seed", "ok": False}
code = 4
work = None
owned = {}
published = False


def identity(value):
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def regular(path, maximum, directory=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size <= 0 or info.st_size > maximum:
        os.close(fd)
        raise RuntimeError("Unsafe bounded regular input")
    return fd, info


def both(data):
    n = len(data) // 2
    a, b = int.from_bytes(data[:n], "little"), int.from_bytes(data[n:], "big")
    if a != b:
        raise RuntimeError("Inconsistent ISO numeric encodings")
    return a


def inspect(image, expected):
    size = len(image)
    if size < 19 * BLOCK or size > MAX_IMAGE or size % BLOCK:
        raise RuntimeError("ISO size is invalid")
    primary = None
    supplementary = None
    terminated = False
    for sector in range(16, min(size // BLOCK, 80)):
        descriptor = image[sector * BLOCK:(sector + 1) * BLOCK]
        if descriptor[1:6] != b"CD001" or descriptor[6] != 1:
            raise RuntimeError("Invalid ISO volume descriptor")
        if descriptor[0] == 255:
            terminated = True
            break
        if descriptor[0] == 1:
            if primary is not None:
                raise RuntimeError("Duplicate primary descriptor")
            primary = descriptor
        elif descriptor[0] == 2:
            if supplementary is not None or descriptor[88:91] not in (b"%/@", b"%/C", b"%/E"):
                raise RuntimeError("Unsupported supplementary descriptor")
            supplementary = descriptor
        else:
            raise RuntimeError("Unadmitted ISO descriptor")
    if not terminated or primary is None or supplementary is None:
        raise RuntimeError("Required ISO/Joliet descriptors are missing")
    if primary[40:72].decode("ascii").strip(" \x00").lower() != "cidata" or supplementary[40:72].decode("utf-16-be").strip(" \x00").lower() != "cidata":
        raise RuntimeError("NoCloud volume label differs")
    volume_bytes = both(primary[80:88]) * BLOCK
    for descriptor in (primary, supplementary):
        if both(descriptor[128:132]) != BLOCK or both(descriptor[80:88]) * BLOCK != volume_bytes or volume_bytes < 19 * BLOCK or volume_bytes > size:
            raise RuntimeError("ISO volume bounds differ")
    if any(image[volume_bytes:]):
        raise RuntimeError("ISO trailing payload is unadmitted")
    root = supplementary[156:190]
    if root[0] != 34 or root[25] != 2:
        raise RuntimeError("Invalid ISO root directory")
    extent, length = both(root[2:10]), both(root[10:18])
    start = extent * BLOCK
    if start < 19 * BLOCK or length <= 0 or length > 65536 or start + length > volume_bytes:
        raise RuntimeError("ISO directory bounds differ")
    directory = image[start:start + length]
    files = {}
    ranges = [(start, start + length)]
    offset = 0
    while offset < len(directory):
        width = directory[offset]
        if width == 0:
            offset = ((offset // BLOCK) + 1) * BLOCK
            continue
        if width < 34 or offset + width > len(directory) or offset % BLOCK + width > BLOCK:
            raise RuntimeError("Malformed ISO directory record")
        record = directory[offset:offset + width]
        offset += width
        count = record[32]
        if 33 + count > width:
            raise RuntimeError("ISO filename exceeds its record")
        name = record[33:33 + count]
        if name in (b"\x00", b"\x01"):
            if record[25] != 2:
                raise RuntimeError("Invalid ISO directory reference")
            continue
        if count % 2 or record[25] != 0 or record[1] != 0 or record[26:28] != b"\x00\x00":
            raise RuntimeError("Unadmitted ISO payload type")
        name = name.decode("utf-16-be").removesuffix(";1")
        if name not in expected or name in files:
            raise RuntimeError("Unexpected or duplicate NoCloud payload")
        first, last = both(record[2:10]) * BLOCK, both(record[10:18])
        if last != len(expected[name]) or first < 19 * BLOCK or first + last > volume_bytes or any(first < end and first + last > begin for begin, end in ranges):
            raise RuntimeError("Invalid or overlapping ISO payload extent")
        if image[first:first + last] != expected[name]:
            raise RuntimeError("Recorded NoCloud bytes differ")
        ranges.append((first, first + last))
        files[name] = hashlib.sha256(expected[name]).hexdigest()
    if set(files) != set(expected):
        raise RuntimeError("NoCloud payloads are missing")
    return files


parent_fd = source_fd = stage_fd = inputs_fd = None
stage_name = None
owned_image = None

def tool(args):
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, pass_fds=(stage_fd, inputs_fd), start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + 28
    count = 0
    captured = bytearray()
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise RuntimeError("Seed tool deadline expired")
            for key, _ in selector.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                count += len(chunk)
                captured.extend(chunk)
                if count > 65536:
                    raise RuntimeError("Seed tool output exceeded its bound")
        child.wait(timeout=max(0.001, deadline - time.monotonic()))
        if child.returncode:
            raise RuntimeError("Seed tool returned failure: " + captured.decode(errors="replace")[-2048:])
    finally:
        selector.close()
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=5)
        # Only this command's newly created group is inspected or signaled.
        def group_alive():
            try:
                os.killpg(child.pid, 0)
                return True
            except ProcessLookupError:
                return False
        survived = group_alive()
        if survived:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(child.pid, sig)
                except ProcessLookupError:
                    pass
                for _ in range(10):
                    if not group_alive():
                        break
                    time.sleep(0.05)
                if not group_alive():
                    break
            if group_alive():
                raise RuntimeError("Owned seed-tool group cleanup is unconfirmed")
            raise RuntimeError("Seed tool left a surviving process group")

try:
    args = sys.argv[1:]
    if len(args) != 4 or args[0] != "--source" or args[2] != "--output":
        raise RuntimeError("Use --source <owned-directory> --output <new-image>")
    source = Path(args[1]).absolute()
    output = Path(args[3]).absolute()
    source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    parent_fd = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    source_info, parent_info = os.fstat(source_fd), os.fstat(parent_fd)
    for value in (source_info, parent_info):
        if value.st_uid != os.getuid() or value.st_mode & 0o077:
            raise RuntimeError("Private owned directories are required")
    if set(os.listdir(source_fd)) != set(LIMITS):
        raise RuntimeError("Unexpected input entries")
    try:
        os.stat(output.name, dir_fd=parent_fd, follow_symlinks=False)
        raise RuntimeError("Existing output is preserved")
    except FileNotFoundError:
        pass
    stage_name = ".fleur-seed-" + secrets.token_hex(16)
    os.mkdir(stage_name, 0o700, dir_fd=parent_fd)
    stage_fd = os.open(stage_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    os.mkdir("inputs", 0o700, dir_fd=stage_fd)
    inputs_fd = os.open("inputs", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=stage_fd)
    expected = {}
    for name, maximum in LIMITS.items():
        fd, before = regular(name, maximum, source_fd)
        with os.fdopen(fd, "rb") as file:
            data = file.read(maximum + 1)
            if len(data) > maximum or identity(before) != identity(os.fstat(file.fileno())):
                raise RuntimeError("Input changed during bounded read")
        expected[name] = data
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=inputs_fd)
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            file.flush()
            owned[name] = identity(os.fstat(file.fileno()))
    # The child inherits this retained directory as its actual cwd. Darwin's
    # hdiutil cannot traverse /dev/fd/<directory>/child pathnames.
    os.fchdir(stage_fd)
    tool(["hdiutil", "makehybrid", "-o", "seed.iso", "inputs", "-iso", "-joliet", "-iso-volume-name", "cidata", "-joliet-volume-name", "cidata"])
    fd, before = regular("seed.iso", MAX_IMAGE, stage_fd)
    with os.fdopen(fd, "rb") as file:
        image = file.read(MAX_IMAGE + 1)
        files = inspect(image, expected)
        if identity(before) != identity(os.fstat(file.fileno())):
            raise RuntimeError("ISO changed during inspection")
        owned_image = identity(before)
        current = os.stat("seed.iso", dir_fd=stage_fd, follow_symlinks=False)
        if identity(current) != identity(before):
            raise RuntimeError("ISO pathname changed")
        os.link("seed.iso", output.name, src_dir_fd=stage_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
        published = True
        sealed = os.fstat(file.fileno())
        file.seek(0)
        final_image = file.read(MAX_IMAGE + 1)
        current = os.stat(output.name, dir_fd=parent_fd, follow_symlinks=False)
        parent_path = os.stat(output.parent, follow_symlinks=False)
        if final_image != image or identity(sealed) != identity(os.fstat(file.fileno())) or identity(current) != identity(sealed) or (parent_path.st_dev, parent_path.st_ino) != (parent_info.st_dev, parent_info.st_ino):
            raise RuntimeError("Published ISO bytes or namespace changed")
    report.update(imageBytes=len(image), imageSha256=hashlib.sha256(image).hexdigest(), files=files, volumeLabel="cidata")
    code = 0
except Exception as error:
    report["error"] = {"code": "SEED_PREPARATION_FAILED", "message": str(error)}
    report["preparationError"] = str(error)
finally:
    if stage_fd is not None:
        try:
            allowed = {"inputs"} | ({"seed.iso"} if owned_image else set())
            if set(os.listdir(stage_fd)) != allowed or set(os.listdir(inputs_fd)) != set(owned):
                raise RuntimeError("Unknown staged seed entry retained")
            for name, expected_identity in owned.items():
                current = os.stat(name, dir_fd=inputs_fd, follow_symlinks=False)
                if not stat.S_ISREG(current.st_mode) or identity(current) != expected_identity:
                    raise RuntimeError("Staged input changed")
            if owned_image:
                current = os.stat("seed.iso", dir_fd=stage_fd, follow_symlinks=False)
                if not stat.S_ISREG(current.st_mode) or identity(current)[:3] != owned_image[:3]:
                    raise RuntimeError("Staged image changed")
                os.unlink("seed.iso", dir_fd=stage_fd)
            for name in owned:
                os.unlink(name, dir_fd=inputs_fd)
            os.rmdir("inputs", dir_fd=stage_fd)
            os.rmdir(stage_name, dir_fd=parent_fd)
        except Exception:
            code = 5
            report["retainedStage"] = stage_name
            report["error"] = {"code": "SEED_CLEANUP_UNCONFIRMED", "message": "Private seed ownership or cleanup is uncertain; entries were retained."}
    for fd in (inputs_fd, stage_fd, source_fd, parent_fd):
        if fd is not None:
            os.close(fd)
    report["ok"] = code == 0
    if published and code != 0:
        report["publishedOutputRetained"] = True
    print(json.dumps(report, separators=(",", ":")))
    sys.exit(code)

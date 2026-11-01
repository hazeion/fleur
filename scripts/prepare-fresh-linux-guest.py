"""Prepare only the authenticated guest Bun entry. No installer or external tool."""
import hashlib
import json
import os
import re
import secrets
import stat
import sys
import time
import zipfile

MAX_ARCHIVE = 160 * 1024 * 1024
MAX_EXECUTABLE = 256 * 1024 * 1024
MAX_RECORD = 4096
ARCHIVE = "bun-linux-x64"
ENTRY = ARCHIVE + "/bun"
report = {"formatVersion": 1, "scope": "guest-bun-preparation", "ok": False}
parent = None
created = None
exit_code = 4
preparation_started = time.monotonic()


def preparation_event(stage, state):
    if os.environ.get("FLEUR_GUEST_PREPARATION_EVENTS") == "yes":
        print(json.dumps({"formatVersion": 1, "scope": "guest-bun-preparation-event", "stage": stage,
                          "state": state, "elapsedMs": int((time.monotonic() - preparation_started) * 1000)},
                         separators=(",", ":")), flush=True)


def cleanup_event(state):
    # Losing diagnostic delivery must not bypass owned-file cleanup. Ordinary
    # stage events still fail preparation; cleanup runs even with a broken pipe.
    try:
        preparation_event("cleanup", state)
    except Exception:
        pass


def identity(value):
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def release_floor(parent):
    """Read the official x64 archive digest of the release floor Bun from the record the host staged beside the archive.

    The host authenticates `bun.zip` against the same tracked record before staging both files, then checks the
    reported digest against it again; arguments still cannot override the pin.
    """
    descriptor = os.open("bun-floor.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(descriptor, "rb") as record_file:
        info = os.fstat(record_file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or not 0 < info.st_size <= MAX_RECORD:
            raise RuntimeError("Release floor record is not an owned bounded regular file")
        record = json.loads(record_file.read(MAX_RECORD))
    archive = record["archives"]["linux-x64"]
    if record.get("formatVersion") != 1 or archive.get("name") != ARCHIVE or not re.fullmatch(r"[a-f0-9]{64}", archive.get("sha256", "")):
        raise RuntimeError("Release floor record malformed")
    return archive["sha256"]


def authenticate(archive):
    archive.seek(0)
    digest = hashlib.sha256()
    size = 0
    while chunk := archive.read(1024 * 1024):
        size += len(chunk)
        if size > MAX_ARCHIVE:
            raise RuntimeError("Archive bound exceeded")
        digest.update(chunk)
    if digest.hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError("Archive authentication failed")
    return size


try:
    if len(sys.argv) != 1:
        raise RuntimeError("Guest preparation accepts no artifact or pin override")
    cwd = os.getcwd()
    parent = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    directory = os.fstat(parent)
    if directory.st_uid != os.getuid() or directory.st_mode & 0o077:
        raise RuntimeError("Guest preparation requires a private owned directory")
    ARCHIVE_SHA256 = release_floor(parent)
    descriptor = os.open("bun.zip", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(descriptor, "rb") as archive:
        original = os.fstat(archive.fileno())
        if not stat.S_ISREG(original.st_mode) or original.st_uid != os.getuid() or original.st_size <= 0 or original.st_size > MAX_ARCHIVE:
            raise RuntimeError("Archive is not an owned bounded regular file")
        preparation_event("archive-authentication", "started")
        archive_size = authenticate(archive)
        preparation_event("archive-authentication", "completed")
        if identity(original) != identity(os.fstat(archive.fileno())):
            raise RuntimeError("Archive changed during authentication")
        preparation_event("zip-entry-validation", "started")
        with zipfile.ZipFile(archive) as contents:
            entries = contents.infolist()
            names = [item.filename for item in entries]
            if len(entries) not in (1, 2) or len(set(names)) != len(names) or ENTRY not in names:
                raise RuntimeError("Unexpected archive entry count")
            for item in entries:
                if item.filename != item.orig_filename or item.flag_bits & 1:
                    raise RuntimeError("Ambiguous or encrypted archive entry")
                kind = stat.S_IFMT(item.external_attr >> 16)
                if item.filename == ENTRY:
                    if item.is_dir() or kind != stat.S_IFREG or item.file_size <= 0 or item.file_size > MAX_EXECUTABLE:
                        raise RuntimeError("Bun entry is not a bounded regular file")
                elif item.filename != ARCHIVE + "/" or not item.is_dir() or kind != stat.S_IFDIR or item.file_size != 0:
                    raise RuntimeError("Unadmitted archive entry")
                if item.compress_size < 0 or item.compress_size > MAX_ARCHIVE:
                    raise RuntimeError("Compressed entry bound exceeded")
            preparation_event("zip-entry-validation", "completed")
            entry = contents.getinfo(ENTRY)
            preparation_event("executable-extraction", "started")
            descriptor = os.open("bun", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700, dir_fd=parent)
            with os.fdopen(descriptor, "w+b") as output:
                owned = os.fstat(output.fileno())
                created = owned.st_dev, owned.st_ino
                copied = 0
                executable_digest = hashlib.sha256()
                with contents.open(entry) as source:
                    while chunk := source.read(1024 * 1024):
                        copied += len(chunk)
                        if copied > entry.file_size or copied > MAX_EXECUTABLE:
                            raise RuntimeError("Executable bound exceeded")
                        output.write(chunk)
                        executable_digest.update(chunk)
                if copied != entry.file_size:
                    raise RuntimeError("Executable size differs")
                output.flush()
                os.fsync(output.fileno())
                os.fchmod(output.fileno(), 0o700)
                preparation_event("executable-extraction", "completed")
                preparation_event("retained-output-authentication", "started")
                # Authenticate the actual retained output, not merely the ZIP
                # stream we intended to write. Keep this descriptor until every
                # final input/path identity check has completed.
                sealed = os.fstat(output.fileno())
                output.seek(0)
                final_digest = hashlib.sha256()
                verified = 0
                while chunk := output.read(1024 * 1024):
                    verified += len(chunk)
                    if verified > MAX_EXECUTABLE or verified > copied:
                        raise RuntimeError("Final executable bound exceeded")
                    final_digest.update(chunk)
                final = os.fstat(output.fileno())
                if verified != copied or final_digest.digest() != executable_digest.digest() or identity(sealed) != identity(final):
                    raise RuntimeError("Retained executable bytes changed")
                preparation_event("retained-output-authentication", "completed")
                preparation_event("archive-reauthentication", "started")
                authenticate(archive)
                if identity(original) != identity(os.fstat(archive.fileno())):
                    raise RuntimeError("Archive changed during extraction")
                preparation_event("archive-reauthentication", "completed")
                preparation_event("output-custody", "started")
                current = os.stat("bun", dir_fd=parent, follow_symlinks=False)
                current_directory = os.stat(cwd, follow_symlinks=False)
                if not stat.S_ISREG(current.st_mode) or current.st_size != copied or stat.S_IMODE(current.st_mode) != 0o700 or identity(current) != identity(final) or (current.st_dev, current.st_ino) != created or (current_directory.st_dev, current_directory.st_ino) != (directory.st_dev, directory.st_ino):
                    raise RuntimeError("Owned output or directory identity changed")
                preparation_event("output-custody", "completed")
                report.update(ok=True, archiveSha256=ARCHIVE_SHA256, archiveBytes=archive_size, executableBytes=copied, executableSha256=final_digest.hexdigest())
                exit_code = 0
except Exception:
    report["error"] = {"code": "PREPARATION_FAILED", "message": "Authenticated guest Bun preparation failed; no installation was attempted."}
    if created is not None:
        cleanup_event("started")
        try:
            current = os.stat("bun", dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != created:
                raise RuntimeError("Output ownership changed")
            # Claim the public entry atomically before deleting anything. The
            # precheck preserves an already-known foreign entry in place; a
            # replacement racing that check is retained in private quarantine.
            quarantine_name = ".fleur-bun-cleanup-" + secrets.token_hex(16)
            os.mkdir(quarantine_name, 0o700, dir_fd=parent)
            quarantine = os.open(quarantine_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                os.rename("bun", "entry", src_dir_fd=parent, dst_dir_fd=quarantine)
                claimed = os.stat("entry", dir_fd=quarantine, follow_symlinks=False)
                if not stat.S_ISREG(claimed.st_mode) or (claimed.st_dev, claimed.st_ino) != created:
                    report["retainedQuarantine"] = quarantine_name
                    raise RuntimeError("Claimed output is a foreign replacement")
                os.unlink("entry", dir_fd=quarantine)
            finally:
                os.close(quarantine)
            os.rmdir(quarantine_name, dir_fd=parent)
            report["ownedPartialRemoved"] = True
            cleanup_event("completed")
        except Exception:
            exit_code = 5
            report["error"] = {"code": "CLEANUP_UNCONFIRMED", "message": "Output ownership changed or cleanup failed; unrelated entries were preserved."}
finally:
    if parent is not None:
        os.close(parent)
    print(json.dumps(report, separators=(",", ":")))
    sys.exit(exit_code)

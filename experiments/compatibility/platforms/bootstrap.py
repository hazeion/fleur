"""Obtain one verified experiment runtime and record its native host identity."""
import argparse
import ctypes
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import urllib.request
import zipfile

PLATFORMS = {("Darwin", "x86_64"): "darwin-x64", ("Darwin", "arm64"): "darwin-arm64",
             ("Linux", "x86_64"): "linux-x64", ("Linux", "arm64"): "linux-arm64"}


def floor_record():
    """Read the release floor record, `scripts/bun-floor.json`, from the nearest enclosing checkout or fixture context.

    The record declares the one Bun version CI installs and the official archive digests for that release;
    `package.json` `engines.bun` must equal `>=` that version (checked by `tests/ci`). The distribution fixtures copy
    it beside the experiment directories, so the search climbs from this file rather than assuming the repository layout.
    """
    for root in Path(__file__).resolve().parents:
        candidate = root / "scripts" / "bun-floor.json"
        if candidate.is_file():
            record = json.loads(candidate.read_text())
            if (type(record) is not dict or record.get("formatVersion") != 1 or type(record.get("version")) is not str
                    or set(record.get("archives", {})) != set(PLATFORMS.values())):
                raise ValueError("Bun floor record malformed")
            return record
    raise ValueError("Bun floor record unavailable")


def read_command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=10)
    if result.returncode:
        return None
    return result.stdout.strip()


def process_translation():
    """Query this process; only Apple's ENOENT case establishes native execution."""
    query = ctypes.CDLL(None, use_errno=True).sysctlbyname
    query.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                      ctypes.c_void_p, ctypes.c_size_t]
    query.restype = ctypes.c_int
    translated = ctypes.c_int()
    size = ctypes.c_size_t(ctypes.sizeof(translated))
    ctypes.set_errno(0)
    result = query(b"sysctl.proc_translated", ctypes.byref(translated), ctypes.byref(size), None, 0)
    if result != 0:
        if ctypes.get_errno() == errno.ENOENT:
            return 0
        raise ValueError("process translation state unavailable")
    if size.value != ctypes.sizeof(translated) or translated.value not in (0, 1):
        raise ValueError("process translation state malformed")
    return translated.value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--system", required=True, choices=("Darwin", "Linux"))
    parser.add_argument("--architecture", required=True, choices=("x86_64", "arm64"))
    parser.add_argument("--ubuntu", choices=("24.04", "26.04"))
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    report = {"scope": "native runtime bootstrap only", "v1_gate_passed": False}
    stage = "host identity"
    try:
        architecture = {"aarch64": "arm64"}.get(platform.machine(), platform.machine())
        system = platform.system()
        report["host"] = {"system": system, "process_architecture": architecture,
                          "kernel": platform.release(), "runner_image": os.environ.get("ImageVersion")}
        if (system, architecture) != (args.system, args.architecture):
            raise ValueError("host differs from requested native target")
        if system == "Darwin":
            cpu = read_command(["/usr/sbin/sysctl", "-n", "hw.cputype"])
            translated = process_translation()
            report["host"].update({"macos": platform.mac_ver()[0], "cpu_type": cpu,
                                  "process_translated": translated})
            expected_cpu = 7 if architecture == "x86_64" else 12
            if cpu is None or int(cpu) & 0xFFFFFF != expected_cpu or translated != 0:
                raise ValueError("native CPU identity unverified or process translated")
        else:
            release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines()
                           if "=" in line)
            report["host"]["distribution"] = {key: release.get(key, "").strip('"')
                                                 for key in ("ID", "VERSION_ID")}
            if args.ubuntu and report["host"]["distribution"] != {"ID": "ubuntu", "VERSION_ID": args.ubuntu}:
                raise ValueError("Ubuntu release differs from requested target")
        report["native_identity_verified"] = True
        stage = "runtime archive"
        floor = floor_record()
        version = floor["version"]
        archive, digest = (floor["archives"][PLATFORMS[(system, architecture)]][key] for key in ("name", "sha256"))
        url = f"https://github.com/oven-sh/bun/releases/download/bun-v{version}/{archive}.zip"
        with urllib.request.urlopen(url, timeout=60) as response:
            payload = response.read(256 * 1024 * 1024 + 1)
        if len(payload) > 256 * 1024 * 1024 or hashlib.sha256(payload).hexdigest() != digest:
            raise ValueError("runtime archive digest or size rejected")
        # Extract only the known binary into the explicit disposable destination.
        binary = zipfile.ZipFile(io.BytesIO(payload)).read(f"{archive}/bun")
        args.out.mkdir(parents=True, exist_ok=True)
        executable = args.out / "bun"
        if executable.exists():
            raise ValueError("runtime destination already exists")
        executable.write_bytes(binary)
        executable.chmod(0o755)
        stage = "runtime execution"
        if read_command([str(executable), "--version"]) != version:
            raise ValueError("installed Bun differs from the release floor")
        report["runtime"] = {"version": version, "revision": read_command([str(executable), "--revision"]),
                             "archive_sha256": digest, "binary_sha256": hashlib.sha256(binary).hexdigest()}
        report["ok"] = True
        print(json.dumps(report, indent=2))
        return 0
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired, zipfile.BadZipFile):
        report.update({"ok": False, "failure_stage": stage})
        print(json.dumps(report, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

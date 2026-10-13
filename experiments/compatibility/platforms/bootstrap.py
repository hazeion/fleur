"""Obtain one verified experiment runtime and record its native host identity."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import urllib.request
import zipfile

PINS = {
    ("Darwin", "x86_64"): ("bun-darwin-x64", "62660e6438eb872278877acca77e1152d5d031324df368d4a81b428211489d2d"),
    ("Darwin", "arm64"): ("bun-darwin-aarch64", "80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403"),
    ("Linux", "x86_64"): ("bun-linux-x64", "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18"),
    ("Linux", "arm64"): ("bun-linux-aarch64", "efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21"),
}


def read_command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=10)
    if result.returncode:
        return None
    return result.stdout.strip()


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
            translated = read_command(["/usr/sbin/sysctl", "-n", "sysctl.proc_translated"])
            report["host"].update({"macos": platform.mac_ver()[0], "cpu_type": cpu,
                                  "process_translated": translated})
            expected_cpu = 7 if architecture == "x86_64" else 12
            if cpu is None or int(cpu) & 0xFFFFFF != expected_cpu or translated == "1":
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
        archive, digest = PINS[(system, architecture)]
        url = f"https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/{archive}.zip"
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
        if read_command([str(executable), "--version"]) != "1.4.3":
            raise ValueError("runtime version differs from exact pin")
        report["runtime"] = {"version": "1.4.3", "revision": read_command([str(executable), "--revision"]),
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

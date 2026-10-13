"""Read-only isolation experiment inventory. Never executes application code.

Python is an experiment tool, not a proposed Fleur runtime prerequisite.
This diagnostic cannot pass issue #23; no restriction bootstrap exists yet.
"""
import argparse
import json
import platform
import re
import shutil
import subprocess

TIMEOUT_SECONDS = 5
IMAGE_PIN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}\Z")


def query(command):
    """Do not expose subprocess diagnostics, environment, paths or daemon state."""
    try:
        result = subprocess.run(
            command, stdin=subprocess.DEVNULL, capture_output=True,
            text=True, timeout=TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return None
    if result.returncode != 0 or len(result.stdout) > 4096:
        return None
    return result.stdout.strip()


def inspect_prerequisites(image):
    report = {
        "schemaVersion": 1,
        "gate": "blocked",
        "applicationEvaluated": False,
        "host": {"system": platform.system(), "architecture": platform.machine()},
        "observations": {},
        "blockers": [
            "pre-evaluation-bootstrap-unverified",
            "negative-syscall-and-broker-tests-unexecuted",
            "resource-and-container-boundary-tests-unexecuted",
        ],
    }
    blockers = report["blockers"]
    observations = report["observations"]
    valid_pin = bool(image and IMAGE_PIN.fullmatch(image))
    if not image:
        blockers.append("image-pin-missing")
    elif not valid_pin:
        blockers.append("image-pin-invalid")

    docker = shutil.which("docker")
    if docker is None:
        blockers.append("docker-missing")
        return report

    # Read only selected public fields; never output raw daemon info or errors.
    server = query([docker, "version", "--format", "{{json .Server}}"])
    try:
        server = json.loads(server) if server is not None else None
    except json.JSONDecodeError:
        server = None
    if not isinstance(server, dict):
        blockers.append("docker-unavailable")
        return report
    version, system, architecture = (server.get(key) for key in ("Version", "Os", "Arch"))
    if not all(isinstance(value, str) for value in (version, system, architecture)):
        blockers.append("docker-response-invalid")
        return report
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", version):
        blockers.append("docker-response-invalid")
        return report
    if system != "linux" or architecture not in ("amd64", "arm64"):
        blockers.append("docker-target-unsupported")
        return report
    observations["dockerServer"] = {"version": version, "system": system, "architecture": architecture}
    if valid_pin:
        image_platform = query([docker, "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image])
        if image_platform != f"linux/{architecture}":
            blockers.append("pinned-image-missing-or-incompatible")
        else:
            observations["pinnedImageLocallyPresent"] = True
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", help="Local repository@sha256 digest to inspect; never pulled")
    args = parser.parse_args()
    print(json.dumps(inspect_prerequisites(args.image), sort_keys=True))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

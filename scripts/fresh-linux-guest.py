"""Execute the real packed candidate inside one explicitly owned Ubuntu guest.

PTY replies below are automated test inputs. They prove neither real human
consent nor acceptance of any legal agreement. No production grant API is added.
"""
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import selectors
import signal
import subprocess
import sys
import time

ROOT = Path.home() / "lab"
BUN = str(ROOT / "bun")
CLI = str(ROOT / "package/bin/fleur.ts")
REPORT = {"formatVersion": 1, "ok": False, "installationEvidence": "pending",
          "runtimeSupport": "unverified", "humanConsentProof": False,
          "authorityInput": "automated-disposable-guest-PTY-fixture", "runs": []}


def run(args, timeout=60, allowed=(0,)):
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    output = {child.stdout: bytearray(), child.stderr: bytearray()}
    selector = selectors.DefaultSelector()
    for stream in output:
        selector.register(stream, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise RuntimeError("Guest command deadline expired: " + args[0])
            for key, _ in selector.select(0.2):
                part = os.read(key.fileobj.fileno(), 8192)
                if not part:
                    selector.unregister(key.fileobj)
                else:
                    output[key.fileobj].extend(part)
                    if sum(len(value) for value in output.values()) > 2 * 1024 * 1024:
                        raise RuntimeError("Guest command output exceeded evidence limit")
        child.wait(timeout=max(0.001, deadline - time.monotonic()))
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
        selector.close()
    stdout, stderr = bytes(output[child.stdout]), bytes(output[child.stderr])
    if child.returncode not in allowed:
        raise RuntimeError("Guest command failed: " + args[0] + ": " + stderr.decode(errors="replace")[-2048:])
    return child.returncode, stdout.decode(), stderr.decode()


def snapshot():
    packages = run(["dpkg-query", "--show", "--showformat=${Package}\t${Version}\t${db:Status-Abbrev}\n"])[1]
    services = run(["systemctl", "show", "docker.service", "docker.socket", "containerd.service",
                    "--property=LoadState,ActiveState,UnitFileState"], allowed=(0, 1))[1]
    sources = []
    for pattern in ("/etc/apt/sources.list", "/etc/apt/sources.list.d/*", "/etc/apt/keyrings/*", "/etc/apt/trusted.gpg.d/*"):
        import glob
        for filename in sorted(glob.glob(pattern)):
            path = Path(filename)
            if path.is_file() and not path.is_symlink():
                data = path.read_bytes()
                sources.append({"path": filename, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
    return {"packages": packages, "services": services, "groups": run(["id"])[1], "sources": sources}


def command_json(name):
    code, text, _ = run([BUN, CLI, name, "--json", "--timeout", "60"], timeout=75, allowed=(0, 1, 3, 4, 5))
    data = json.loads(text)
    if data.get("formatVersion") != 1 or data.get("command") != name or data.get("truncated") is not False:
        raise RuntimeError("Candidate returned malformed command evidence")
    return {"exitCode": code, "result": data}


def setup_pty(reply):
    master, slave = pty.openpty()
    child = subprocess.Popen([BUN, CLI, "setup", "--timeout", "600"], stdin=slave, stdout=slave,
                             stderr=slave, start_new_session=True, close_fds=True)
    os.close(slave)
    output = bytearray()
    answered = 0
    deadline = time.monotonic() + 615
    try:
        while child.poll() is None:
            if time.monotonic() > deadline:
                raise RuntimeError("Candidate PTY setup deadline expired")
            if not select.select([master], [], [], 0.2)[0]:
                continue
            try:
                chunk = os.read(master, 8192)
            except OSError:
                break
            output.extend(chunk)
            if len(output) > 1024 * 1024:
                raise RuntimeError("Candidate PTY output exceeded evidence limit")
            text = output.decode(errors="replace")
            prompts = list(re.finditer(r"Authorize ([a-z-]+) using ([a-z-]+) for [^\r\n]+\r?\nPlan ([a-f0-9]{64})\r?\nType 'once', 'remember', or 'deny': ", text))
            while answered < len(prompts):
                match = prompts[answered]
                allowed = {"install", "configuration", "repository-configuration", "docker-access", "service-start", "service-enable", "image-acquire"}
                if match[1] not in allowed or match[2] != ("docker-digest-pull" if match[1] == "image-acquire" else "docker-official-apt") or answered >= 8:
                    raise RuntimeError("Unexpected authority prompt; no response supplied")
                os.write(master, (reply + "\n").encode())
                answered += 1
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
        os.close(master)
    return {"exitCode": child.returncode, "promptsAnswered": answered,
            "transcript": output.decode(errors="replace"), "reply": reply}


def main():
    nonce = sys.argv[1] if len(sys.argv) == 2 else ""
    if not re.fullmatch(r"[a-f0-9-]{36}", nonce) or Path("/etc/fleur-owned-guest").read_text().strip() != nonce:
        raise RuntimeError("Owned guest identity is absent")
    if os.getuid() == 0 or Path("/proc/1/comm").read_text().strip() != "systemd":
        raise RuntimeError("Ordinary guest account and its own systemd are required")
    os_release = Path("/etc/os-release").read_text()
    if 'ID=ubuntu\n' not in os_release or 'VERSION_ID="24.04"' not in os_release or run(["uname", "-m"])[1].strip() != "x86_64":
        raise RuntimeError("Guest differs from frozen Ubuntu24 amd64 tuple")
    REPORT["guest"] = {"osRelease": os_release, "kernel": run(["uname", "-srmo"])[1],
                       "virtualization": run(["systemd-detect-virt"])[1].strip(), "bun": run([BUN, "--version"])[1].strip()}
    if REPORT["guest"]["virtualization"] not in ("qemu", "kvm") or REPORT["guest"]["bun"] != "1.4.3":
        raise RuntimeError("Guest virtualization/runtime identity differs")
    baseline = snapshot()
    REPORT["baseline"] = baseline
    if any(re.match(r"(?:docker-ce|docker-ce-cli|containerd\.io|docker-buildx-plugin|docker-compose-plugin)\t", line) for line in baseline["packages"].splitlines()):
        raise RuntimeError("Guest already contains Docker packages; fresh-install proof refused")
    REPORT["doctorBefore"] = command_json("doctor")
    REPORT["noninteractiveSetup"] = command_json("setup")
    if REPORT["noninteractiveSetup"]["exitCode"] != 3 or snapshot() != baseline:
        raise RuntimeError("Noninteractive setup altered baseline or failed to request authority")
    REPORT["deniedSetup"] = setup_pty("deny")
    if REPORT["deniedSetup"]["exitCode"] != 3 or REPORT["deniedSetup"]["promptsAnswered"] != 1 or snapshot() != baseline:
        raise RuntimeError("Denied setup altered baseline or did not preserve authority boundary")
    REPORT["authorizedFixtureSetup"] = setup_pty("once")
    REPORT["afterSetup"] = snapshot()
    metadata = json.loads((ROOT / "package/internal-native-candidate.json").read_text())
    packages = [item["name"] + "=" + item["version"] for item in metadata["artifacts"]]
    simulation = run(["apt-get", "--simulate", "--no-install-recommends", "--no-remove", "--no-upgrade", "install"] + packages, allowed=(0, 100))
    REPORT["actualDependencySimulation"] = {"exitCode": simulation[0], "stdout": simulation[1], "stderr": simulation[2]}
    REPORT["signedIndexes"] = []
    for path in sorted(Path("/var/lib/apt/lists").glob("*")):
        if path.is_file() and not path.is_symlink() and path.stat().st_size <= 64 * 1024 * 1024:
            data = path.read_bytes()
            REPORT["signedIndexes"].append({"name": path.name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
    REPORT["reprobe"] = command_json("setup")
    REPORT["ordinaryUserDoctor"] = command_json("doctor")
    state = REPORT["ordinaryUserDoctor"]["result"].get("data", {}).get("components", {})
    if state.get("daemon", {}).get("state") == "denied":
        REPORT["error"] = {"code": "USER_ACCESS_REQUIRED", "message": "The ordinary account has no scoped Docker access. No membership or root-readiness substitution was performed."}
        return
    if state.get("daemon", {}).get("state") != "ready":
        REPORT["error"] = {"code": "NATIVE_SETUP_INCOMPLETE", "message": "Inspect actual setup transcript, package state and signed repository evidence. No dependency preinstallation was performed."}
        return
    # Doctor's complete image identity and nonce checks remain the product boundary.
    # No public image-acquire grant mint is available here; missing authority stays incomplete.
    if state.get("smoke", {}).get("state") != "ready":
        REPORT["smokeAcquisitionFixture"] = setup_pty("once")
        REPORT["ordinaryUserDoctorAfterAcquisition"] = command_json("doctor")
        state = REPORT["ordinaryUserDoctorAfterAcquisition"]["result"].get("data", {}).get("components", {})
        if state.get("smoke", {}).get("state") != "ready":
            REPORT["error"] = {"code": "SMOKE_AUTHORITY_REQUIRED", "message": "Separate supported image acquisition did not establish readiness."}
            return
    verify_smoke_and_restrictions(state)


def verify_smoke_and_restrictions(state):
    context = run(["docker", "context", "show"])[1].strip()
    endpoint = json.loads(run(["docker", "context", "inspect", context, "--format", "{{json .Endpoints.docker}}"])[1])["Host"]
    if not re.fullmatch(r"unix:///[^\s?#]+", endpoint):
        raise RuntimeError("Guest endpoint is not a local Unix socket")
    docker = ["docker", "--host", endpoint]
    image = run([BUN, "-e", "import {smokeImages} from " + json.dumps(str(ROOT / "package/src/setup/profiles.ts")) + ";process.stdout.write(smokeImages.x64)"])[1]
    if not re.fullmatch(r"oven/bun@sha256:[a-f0-9]{64}", image):
        raise RuntimeError("Smoke image is not digest-pinned")
    original = run(docker + ["ps", "--all", "--quiet", "--no-trunc"])[1].splitlines()
    nonce = os.urandom(16).hex()
    name = "fleur-guest-unrelated-" + nonce
    sentinel = run(docker + ["create", "--name", name, "--label", "dev.fleur.guest-sentinel=" + nonce,
                           "--network", "none", "--read-only", "--cap-drop", "ALL", "--pull", "never",
                           image, "/usr/local/bin/bun", "-e", "process.exit(0)"])[1].strip()
    if not re.fullmatch(r"[a-f0-9]{64}", sentinel):
        raise RuntimeError("Sentinel did not return full ownership identity")
    def sentinel_snapshot():
        data = json.loads(run(docker + ["inspect", sentinel])[1])[0]
        if data["Id"] != sentinel or data["Name"] != "/" + name or data["Config"]["Labels"].get("dev.fleur.guest-sentinel") != nonce or data["State"]["Running"]:
            raise RuntimeError("Sentinel ownership/state changed; removal refused")
        return json.dumps(data, sort_keys=True)
    before_sentinel = sentinel_snapshot()
    try:
        for _ in range(2):
            before = snapshot()
            observed = command_json("doctor")
            envelope = observed.get("result", {})
            components = envelope.get("data", {}).get("components", {})
            # The internal candidate deliberately remains release-unverified:
            # healthy readiness must retain doctor exit 4 and its exact envelope.
            ready = (observed.get("exitCode") == 4
                     and envelope.get("formatVersion") == 1
                     and envelope.get("command") == "doctor"
                     and envelope.get("ok") is False
                     and envelope.get("truncated") is False
                     and envelope.get("error", {}).get("code") == "PREREQUISITE_UNAVAILABLE"
                     and all(components.get(name, {}).get("state") == "ready"
                             for name in ("cli", "daemon", "compose", "smoke"))
                     and components.get("smoke", {}).get("cleanup") is True
                     and components.get("release", {}).get("state") == "unverified")
            if not ready or snapshot() != before or sentinel_snapshot() != before_sentinel or run(["docker", "context", "show"])[1].strip() != context:
                raise RuntimeError("Repeat ordinary-user smoke or host state preservation failed")
            REPORT["runs"].append(observed)
        # Execute the existing gate without skipping any GC, idle, resource or deadline assertion.
        probe = ROOT / "experiments/compatibility/runtime-probe/run.py"
        code, text, _ = run(["python3", str(probe), "--architecture", "amd64", "--healthy-containerd-exit", "--idle-runtime-stress"], timeout=600, allowed=(0, 1))
        REPORT["restrictionProbe"] = {"exitCode": code, "result": json.loads(text)}
        if code != 0 or REPORT["restrictionProbe"]["result"].get("cleanup_complete") is not True or REPORT["restrictionProbe"]["result"].get("bounded_probe_passed") is not True:
            REPORT["error"] = {"code": "RESTRICTION_EVIDENCE_REQUIRED", "message": "Actual guest runtime restriction probe did not pass. Missing compiler/dependencies were not preinstalled."}
            return
        REPORT["installationEvidence"] = "verified-full-system-guest"
        REPORT["ok"] = True
    finally:
        if sentinel_snapshot() != before_sentinel:
            raise RuntimeError("Unrelated sentinel changed; removal refused")
        run(docker + ["rm", sentinel])
        after = run(docker + ["ps", "--all", "--quiet", "--no-trunc"])[1].splitlines()
        if sorted(original) != sorted(after):
            raise RuntimeError("Guest original Docker inventory was not restored")
        REPORT["sentinelCleanup"] = True


try:
    main()
except Exception as error:
    REPORT["ok"] = False
    REPORT["error"] = {"code": "GUEST_VERIFICATION_FAILED", "message": str(error)}
finally:
    print(json.dumps(REPORT, separators=(",", ":")))
    sys.exit(0 if REPORT["ok"] else 4)

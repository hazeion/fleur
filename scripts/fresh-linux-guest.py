"""Execute the real packed candidate inside one explicitly owned Ubuntu guest.

PTY replies below are automated test inputs. They prove neither real human
consent nor acceptance of any legal agreement. No production grant API is added.
"""
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import pty
import re
import select
import selectors
import signal
import stat
import subprocess
import sys
import time
from typing import NamedTuple

ROOT = Path.home() / "lab"
BUN = str(ROOT / "bun")
CLI = str(ROOT / "package/bin/fleur.ts")
REPORT = {"formatVersion": 1, "ok": False, "installationEvidence": "pending",
          "runtimeSupport": "unverified", "humanConsentProof": False,
          "authorityInput": "automated-disposable-guest-PTY-fixture", "runs": []}


GUEST_DEADLINE = None
RECORDED_HELPERS = False
_RECORDED_MODULE = None

def release_floor():
    """The Bun version the host staged in `bun-floor.json` beside the archive; the guest runs exactly that release."""
    record = json.loads((ROOT / "bun-floor.json").read_text())
    version = record.get("version") if type(record) is dict else None
    if type(version) is not str or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise RuntimeError("Release floor record malformed")
    return version


def budget_seconds(limit):
    remaining = limit if GUEST_DEADLINE is None else min(limit, GUEST_DEADLINE - time.monotonic())
    if remaining < 1:
        raise TimeoutError("Guest aggregate verification deadline expired")
    return remaining


def command_exited(child):
    # Observe without reaping: the retained leader reserves this owned PGID.
    return os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def stop_command_group(child):
    # Never poll/wait before signaling: a reaped leader's PID could be reused.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        # Some kernels refuse signaling a group containing only zombies.
        # Reaping and disappearance, never this exception, establish cleanup.
        pass
    child.wait(timeout=5)
    # Successful signaling does not prove root-owned descendants were killed.
    deadline = time.monotonic() + 5
    while True:
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("Guest command process-group cleanup could not be confirmed")
        time.sleep(0.02)


def run(args, timeout=60, allowed=(0,), *, absolute_deadline=None):
    timeout = budget_seconds(timeout)
    work_deadline = None
    if absolute_deadline is not None:
        if type(absolute_deadline) not in (int, float) or not math.isfinite(absolute_deadline):
            raise ValueError("Finite owned command deadline required")
        started = time.monotonic()
        if absolute_deadline <= started:
            raise TimeoutError("Guest command deadline expired: " + args[0])
        work_deadline = min(absolute_deadline, started + timeout)
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    output = {child.stdout: bytearray(), child.stderr: bytearray()}
    selector = selectors.DefaultSelector()
    for stream in output:
        selector.register(stream, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout if work_deadline is None else work_deadline
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise TimeoutError("Guest command deadline expired: " + args[0])
            for key, _ in selector.select(0.2):
                part = os.read(key.fileobj.fileno(), 8192)
                if not part:
                    selector.unregister(key.fileobj)
                else:
                    output[key.fileobj].extend(part)
                    if sum(len(value) for value in output.values()) > 2 * 1024 * 1024:
                        raise RuntimeError("Guest command output exceeded evidence limit")
        while not command_exited(child):
            if time.monotonic() >= deadline:
                raise TimeoutError("Guest command deadline expired: " + args[0])
            time.sleep(0.02)
        if work_deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("Guest command deadline expired: " + args[0])
    finally:
        try:
            stop_command_group(child)
        finally:
            selector.close()
            child.stdout.close()
            child.stderr.close()
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
    limit = int(budget_seconds(60))
    code, text, _ = run([BUN, CLI, name, "--json", "--timeout", str(limit)], timeout=75, allowed=(0, 1, 3, 4, 5))
    data = json.loads(text)
    if not isinstance(data, dict) or data.get("formatVersion") != 1 or data.get("command") != name or data.get("truncated") is not False:
        raise RuntimeError("Candidate returned malformed command evidence")
    return {"exitCode": code, "result": data}



def object_field(value, key):
    field = value.get(key, {})
    if not isinstance(field, dict):
        raise RuntimeError("Candidate returned malformed object field: " + key)
    return field


def command_data(envelope):
    # Version 1 permits null data. It supplies no plan or readiness evidence.
    if "data" not in envelope:
        raise RuntimeError("Candidate returned missing command data")
    if envelope["data"] is None:
        return {}
    return object_field(envelope, "data")


def setup_pty(reply, expected_prompt=None):
    limit = int(budget_seconds(600))
    master, slave = pty.openpty()
    child = subprocess.Popen([BUN, CLI, "setup", "--timeout", str(limit)], stdin=slave, stdout=slave,
                             stderr=slave, start_new_session=True, close_fds=True)
    os.close(slave)
    output = bytearray()
    answered = 0
    accepted_prompts = []
    deadline = time.monotonic() + budget_seconds(615)
    try:
        while not command_exited(child):
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
            prompts = list(re.finditer(r"Authorize ([a-z-]+) using ([a-z-]+) for ([^\r\n]+)\r?\nPlan ([a-f0-9]{64})\r?\nType 'once', 'remember', or 'deny': ", text))
            while answered < len(prompts):
                match = prompts[answered]
                allowed = {"install", "configuration", "repository-configuration", "docker-access", "service-start", "service-enable", "image-acquire"}
                if match[1] not in allowed or match[2] != ("docker-digest-pull" if match[1] == "image-acquire" else "docker-official-apt") or answered >= 8:
                    raise RuntimeError("Unexpected authority prompt; no response supplied")
                prompt = {"action": match[1], "method": match[2], "target": match[3], "checksum": match[4]}
                if expected_prompt and (answered != 0 or any(prompt[key] != expected_prompt[key] for key in ("action", "method", "target", "checksum"))):
                    raise RuntimeError("Authority prompt differs from its separately inspected plan")
                accepted_prompts.append(prompt)
                os.write(master, (reply + "\n").encode())
                answered += 1
    finally:
        try:
            stop_command_group(child)
        finally:
            os.close(master)
    return {"exitCode": child.returncode, "promptsAnswered": answered,
            "transcript": output.decode(errors="replace"), "reply": reply, "prompts": accepted_prompts}


def access_observation(plan):
    user = run(["getent", "--service=files", "passwd", str(os.getuid())])[1].strip().split(":")
    group = run(["getent", "--service=files", "group", "docker"])[1].strip().split(":")
    if len(user) != 7 or len(group) != 4 or user[0] != plan["user"]["name"] or int(user[2]) != os.getuid() or group[0] != "docker" or int(group[2]) != plan["group"]["gid"]:
        raise RuntimeError("Enrollment account or Docker group identity differs")
    def groups(args):
        text = run(args)[1].strip()
        if not re.fullmatch(r"[0-9]+(?: [0-9]+)*", text):
            raise RuntimeError("Numeric enrollment groups are unavailable")
        values = [int(value) for value in text.split()]
        if len(set(values)) != len(values):
            raise RuntimeError("Duplicate enrollment groups")
        return values
    socket = run(["stat", "--format=%d|%i|%F|%u|%g|%a", "--", "/run/docker.sock"])[1].strip()
    if not re.fullmatch(r"[0-9]+\|[0-9]+\|socket\|0\|" + str(plan["group"]["gid"]) + r"\|660", socket):
        raise RuntimeError("Enrollment socket identity differs")
    return {"user": {"name": user[0], "uid": int(user[2])}, "group": {"name": "docker", "gid": int(group[2])}, "members": sorted(filter(None, group[3].split(","))), "accountGroups": groups(["id", "--groups", "--", user[0]]), "sessionGroups": groups(["id", "--groups"]), "socket": socket}


def checked_enrollment_plan(observed):
    envelope = observed.get("result", {})
    plan = object_field(command_data(envelope), "plan")
    user, group = object_field(plan, "user"), object_field(plan, "group")
    checksum = plan.get("checksum", "")
    if (observed.get("exitCode") != 3 or envelope.get("formatVersion") != 1 or envelope.get("command") != "setup" or envelope.get("ok") is not False or envelope.get("truncated") is not False or object_field(envelope, "error").get("code") != "AUTHORITY_REQUIRED"
            or plan.get("action") != "docker-access" or plan.get("method") != "docker-official-apt" or plan.get("privilege") != "root-equivalent daemon access"
            or type(user.get("uid")) is not int or user["uid"] != os.getuid() or user["uid"] == 0 or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", user.get("name", ""))
            or group.get("name") != "docker" or type(group.get("gid")) is not int or not 0 < group["gid"] <= 4294967294
            or plan.get("endpoint") not in ("unix:///run/docker.sock", "unix:///var/run/docker.sock") or not re.fullmatch(r"[a-f0-9]{64}", checksum)
            or plan.get("target") != f'Add {user["name"]} to Docker group {group["gid"]}: root-equivalent daemon access; plan {checksum}'):
        raise RuntimeError("Separate root-equivalent enrollment plan is invalid")
    if checksum in {prompt["checksum"] for prompt in REPORT["authorizedFixtureSetup"]["prompts"]}:
        raise RuntimeError("Package-side-effect authority cannot cover account enrollment")
    return plan


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def observed_input(path, limit, expected=None, *, absolute_deadline=None):
    def check_budget():
        budget_seconds(900)
        if absolute_deadline is not None and (type(absolute_deadline) not in (int, float) or not math.isfinite(absolute_deadline) or time.monotonic() >= absolute_deadline):
            raise TimeoutError('Handoff original input deadline expired')
    check_budget()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_size > limit or (expected and file_identity(before) != file_identity(expected)):
            raise RuntimeError("Handoff input is not the expected owned bounded regular file")
        digest = hashlib.sha256()
        size = 0
        while True:
            check_budget()
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise RuntimeError("Handoff input grew beyond its bound")
            digest.update(chunk)
        after = os.fstat(stream.fileno())
        if size != before.st_size or file_identity(before) != file_identity(after) or file_identity(path.lstat()) != file_identity(after):
            raise RuntimeError("Handoff input bytes or pathname identity changed")
        check_budget()
        return {"sha256": digest.hexdigest(), "size": size}


def _recorded_helper_module():
    global _RECORDED_MODULE
    if _RECORDED_MODULE is None:
        # Ordinary host-only source from the authenticated Git restriction archive.
        # Privileged root validation still uses its fixed root-owned program.
        directory = ROOT/'experiments/compatibility/runtime-probe'
        name = '_fleur_recorded_helpers_' + hashlib.sha256(str(directory).encode()).hexdigest()[:16]
        spec = importlib.util.spec_from_file_location(name, directory/'helper_artifacts.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        sys.path.insert(0, str(directory))
        try:
            spec.loader.exec_module(module)
        finally:
            sys.path.pop(0)
        _RECORDED_MODULE = module
    return _RECORDED_MODULE


def recorded_helper_handoff():
    started = time.monotonic()
    budget_seconds(10)
    if type(GUEST_DEADLINE) not in (int, float) or not math.isfinite(GUEST_DEADLINE):
        raise RuntimeError('Recorded helper original guest deadline required')
    deadline = min(GUEST_DEADLINE, started+10)
    contract = _recorded_helper_module()
    metadata = contract.recorded_helper_contract(deadline)
    root = ROOT/'recorded-helpers'
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(directory)
        if not stat.S_ISDIR(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o077:
            raise RuntimeError('Recorded helper handoff custody differs')
        if sorted(os.listdir(directory)) != ['abuse', 'filter.so']:
            raise RuntimeError('Recorded helper handoff entries differ')
        files = {}
        for pin in metadata['helpers']:
            if time.monotonic() >= deadline:
                raise TimeoutError('Recorded helper original handoff deadline expired')
            info = os.stat(pin['name'], dir_fd=directory, follow_symlinks=False)
            if info.st_size != pin['bytes']:
                raise RuntimeError('Recorded helper handoff bytes differ')
            if info.st_mode & 0o077:
                raise RuntimeError('Recorded helper handoff custody differs')
            observed = observed_input(root/pin['name'], pin['bytes'], expected=info, absolute_deadline=deadline)
            if observed != {'size':pin['bytes'], 'sha256':pin['sha256']}:
                raise RuntimeError('Recorded helper handoff bytes differ')
            files[pin['name']] = {**observed, 'identity':[str(value) for value in file_identity(info)]}
        for name, observed in files.items():
            if [str(value) for value in file_identity(os.stat(name, dir_fd=directory, follow_symlinks=False))] != observed['identity']:
                raise RuntimeError('Recorded helper handoff custody changed')
        if file_identity(before) != file_identity(os.fstat(directory)) or file_identity(before) != file_identity(root.lstat()) or time.monotonic() >= deadline:
            raise RuntimeError('Recorded helper handoff custody changed')
        return {'manifestSha256':contract.RECORDED_MANIFEST_SHA256, 'files':files,
                'directoryIdentity':[str(value) for value in file_identity(before)]}
    finally:
        os.close(directory)


def handoff_artifacts():
    records = {}
    root_identity = ROOT.lstat()
    package = ROOT / "package"
    package_identity = package.lstat()
    if not stat.S_ISDIR(root_identity.st_mode) or not stat.S_ISDIR(package_identity.st_mode) or root_identity.st_uid != os.getuid() or package_identity.st_uid != os.getuid():
        raise RuntimeError("Handoff source directories are not owned regular directories")
    paths = {"candidateArchive": (ROOT / "fleur-internal-native-candidate.tgz", 8 * 1024 * 1024), "bunArchive": (ROOT / "bun.zip", 160 * 1024 * 1024), "restrictionArchive": (ROOT / "runtime-probe.tar", 16 * 1024 * 1024), "bunExecutable": (ROOT / "bun", 256 * 1024 * 1024), "guestSource": (Path(__file__), 256 * 1024)}
    for label, (path, limit) in paths.items():
        records[label] = observed_input(path, limit)
    if RECORDED_HELPERS:
        observed = recorded_helper_handoff()
        if 'recordedHelperInputs' in REPORT and observed != REPORT['recordedHelperInputs']:
            raise RuntimeError('Original recorded helper input binding changed')
        records['recordedHelpers'] = observed
    files = []
    total = 0
    entries = 0
    pending = [package]
    while pending:
        budget_seconds(900)
        with os.scandir(pending.pop()) as scanner:
            while True:
                budget_seconds(900)
                try:
                    entry = next(scanner)
                except StopIteration:
                    break
                entries += 1
                if entries > 5000:
                    raise RuntimeError("Candidate source entry bound exceeded")
                budget_seconds(900)
                info = entry.stat(follow_symlinks=False)
                path = Path(entry.path)
                if stat.S_ISDIR(info.st_mode):
                    budget_seconds(900)
                    pending.append(path)
                    continue
                if len(files) >= 5000:
                    raise RuntimeError("Candidate source entry bound exceeded")
                if total + info.st_size > 32 * 1024 * 1024:
                    raise RuntimeError("Candidate source handoff byte bound exceeded")
                observed = observed_input(path, 8 * 1024 * 1024, expected=info)
                total += observed["size"]
                budget_seconds(900)
                files.append({"path": str(path.relative_to(package)), **observed})
    files.sort(key=lambda item: item["path"])
    if file_identity(ROOT.lstat()) != file_identity(root_identity) or file_identity(package.lstat()) != file_identity(package_identity):
        raise RuntimeError("Handoff source directory identity changed")
    records["candidateSources"] = files
    return records


def check_handoff_owned_binding(payload, binding):
    if binding is None:
        if 'ownedGuestBinding' in payload:
            raise RuntimeError("Legacy resume cannot acquire owned fixture authority")
        return
    value = payload.get('ownedGuestBinding')
    if (type(binding) is not OwnedGuestBinding or type(value) is not dict
            or set(value) != set(binding._fields) or type(value.get('uid')) is not int
            or value != binding._asdict()):
        raise RuntimeError("Resume original owned fixture binding changed")


def check_handoff_recorded_mode(payload, recorded):
    if type(payload) is not dict or type(recorded) is not bool or type(payload.get('report', {})) is not dict:
        raise RuntimeError('Original recorded helper mode changed')
    evidence = payload.get('report', {})
    if recorded:
        if payload.get('helperMode') != 'recorded-prebuilt' or evidence.get('helperMode') != 'recorded-prebuilt':
            raise RuntimeError('Original recorded helper mode changed')
    elif 'helperMode' in payload or 'helperMode' in evidence:
        raise RuntimeError('Legacy checkpoint cannot acquire recorded helper mode')


def publish_handoff(nonce, evidence, owned_binding=None):
    payload = {"formatVersion": 1, "phase": "new-login-required", "nonce": nonce, "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "uid": os.getuid(), "guestDeadlineMonotonic": GUEST_DEADLINE, "artifacts": handoff_artifacts(), "report": evidence}
    if owned_binding is not None:
        payload['ownedGuestBinding'] = owned_binding._asdict()
    if RECORDED_HELPERS:payload['helperMode'] = 'recorded-prebuilt'
    check_handoff_owned_binding(payload, owned_binding)
    check_handoff_recorded_mode(payload, RECORDED_HELPERS)
    if not re.fullmatch(r"[a-f0-9-]{36}", payload["bootId"]):
        raise RuntimeError("Guest boot identity is unavailable")
    body = json.dumps(payload, separators=(",", ":")).encode()
    if len(body) > 2 * 1024 * 1024 - 65536:
        raise RuntimeError("Enrollment checkpoint exceeds the bounded report allowance")
    directory = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        observed = os.fstat(directory)
        def check_root():
            current = ROOT.lstat()
            if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (observed.st_dev, observed.st_ino):
                raise RuntimeError("Enrollment checkpoint lab pathname changed")
        if observed.st_uid != os.getuid() or observed.st_mode & 0o077:
            raise RuntimeError("Enrollment checkpoint requires the private owned lab")
        check_root()
        descriptor = os.open("fresh-linux-state.json", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        with os.fdopen(descriptor, "w+b") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
            os.fsync(directory)
            check_root()
            before = os.fstat(stream.fileno())
            stream.seek(0)
            retained = stream.read(2 * 1024 * 1024 + 1)
            after = os.fstat(stream.fileno())
            published = os.stat("fresh-linux-state.json", dir_fd=directory, follow_symlinks=False)
            if (not stat.S_ISREG(after.st_mode) or after.st_uid != os.getuid() or stat.S_IMODE(after.st_mode) != 0o600 or after.st_nlink != 1 or retained != body
                    or file_identity(before) != file_identity(after) or file_identity(published) != file_identity(after)):
                raise RuntimeError("Retained checkpoint bytes or published identity changed")
            check_root()
    finally:
        os.close(directory)
    return {"sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body)}


def enrollment_handoff(nonce, owned_binding=None):
    plan = checked_enrollment_plan(REPORT["reprobe"])
    before = access_observation(plan)
    gid = plan["group"]["gid"]
    if gid in before["accountGroups"] or gid in before["sessionGroups"] or plan["user"]["name"] in before["members"]:
        raise RuntimeError("Fresh enrollment requires the account and session to lack Docker membership")
    unchanged = snapshot()
    REPORT["separateEnrollmentSetup"] = setup_pty("once", expected_prompt=plan)
    if REPORT["separateEnrollmentSetup"]["exitCode"] != 3 or REPORT["separateEnrollmentSetup"]["promptsAnswered"] != 1:
        raise RuntimeError("Separate enrollment did not finish at its new-login boundary")
    REPORT["staleLoginReprobes"] = []
    for _ in range(2):
        observed = command_json("setup")
        envelope = observed["result"]
        REPORT["staleLoginReprobes"].append(observed)
        if observed["exitCode"] != 3 or envelope.get("ok") is not False or object_field(envelope, "error").get("code") != "HUMAN_ACTION_REQUIRED" or object_field(command_data(envelope), "access").get("state") != "new-login-required":
            raise RuntimeError("The original login did not retain its explicit new-login requirement")
    after = access_observation(plan)
    if (snapshot() != unchanged or after["user"] != before["user"] or after["group"] != before["group"] or after["socket"] != before["socket"] or after["sessionGroups"] != before["sessionGroups"]
            or set(after["accountGroups"]) != set(before["accountGroups"]) | {gid} or after["members"] != sorted(before["members"] + [plan["user"]["name"]])):
        raise RuntimeError("Enrollment changed unrelated identity, membership or installed state")
    REPORT["accessHandoff"] = {"plan": plan, "before": before, "after": after}
    pending = dict(REPORT)
    pending["phase"] = "new-login-required"
    checkpoint = publish_handoff(nonce, pending, owned_binding)
    REPORT["phase"] = "new-login-required"
    REPORT["checkpoint"] = checkpoint



def resume_guest(nonce, expected_digest, owned_binding=None):
    global GUEST_DEADLINE
    if not re.fullmatch(r"[a-f0-9]{64}", expected_digest):
        raise RuntimeError("Resume checkpoint digest is invalid")
    directory = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    checkpoint_fd = None
    try:
        root_identity = os.fstat(directory)
        def check_root():
            if file_identity(ROOT.lstat()) != file_identity(os.fstat(directory)):
                raise RuntimeError("Resume lab pathname changed")
        if root_identity.st_uid != os.getuid() or root_identity.st_mode & 0o077:
            raise RuntimeError("Resume requires the private owned lab")
        check_root()
        descriptor = os.open("fresh-linux-state.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or stat.S_IMODE(before.st_mode) != 0o600 or before.st_nlink != 1 or not 0 < before.st_size <= 2 * 1024 * 1024 - 65536:
                raise RuntimeError("Resume checkpoint custody is invalid")
            body = stream.read(2 * 1024 * 1024)
            after = os.fstat(stream.fileno())
            if file_identity(before) != file_identity(after) or file_identity(os.stat("fresh-linux-state.json", dir_fd=directory, follow_symlinks=False)) != file_identity(after) or hashlib.sha256(body).hexdigest() != expected_digest:
                raise RuntimeError("Resume checkpoint bytes or identity changed")
            check_root()
            checkpoint_fd = os.dup(stream.fileno())
        def check_checkpoint():
            budget_seconds(900)
            current = os.fstat(checkpoint_fd)
            retained = os.pread(checkpoint_fd, 2 * 1024 * 1024, 0)
            published = os.stat("fresh-linux-state.json", dir_fd=directory, follow_symlinks=False)
            if file_identity(current) != file_identity(after) or file_identity(os.fstat(checkpoint_fd)) != file_identity(after) or file_identity(published) != file_identity(after) or hashlib.sha256(retained).hexdigest() != expected_digest:
                raise RuntimeError("Resume checkpoint bytes or identity changed")
            check_root()
        payload = json.loads(body)
        deadline = payload.get("guestDeadlineMonotonic")
        evidence = payload.get("report", {})
        if (payload.get("formatVersion") != 1 or payload.get("phase") != "new-login-required" or payload.get("nonce") != nonce or payload.get("bootId") != Path("/proc/sys/kernel/random/boot_id").read_text().strip() or payload.get("uid") != os.getuid()
                or type(deadline) not in (int, float) or not time.monotonic() < deadline <= GUEST_DEADLINE
                or evidence.get("phase") != "new-login-required" or evidence.get("ok") is not False or evidence.get("installationEvidence") != "pending" or evidence.get("runtimeSupport") != "unverified" or evidence.get("humanConsentProof") is not False or not evidence.get("baseline") or evidence.get("runs") != []):
            raise RuntimeError("Resume checkpoint binding or original deadline is invalid")
        check_handoff_owned_binding(payload, owned_binding)
        check_handoff_recorded_mode(payload, RECORDED_HELPERS)
        GUEST_DEADLINE = deadline
        budget_seconds(900)
        verify_owned_binding(owned_binding)
        verify_guest_candidate_target(owned_binding)
        if handoff_artifacts() != payload.get("artifacts"):
            raise RuntimeError("Resume artifact identities changed")
        REPORT.clear()
        REPORT.update(evidence)
        REPORT.pop("phase", None)
        plan = checked_enrollment_plan(REPORT["reprobe"])
        previous = REPORT["accessHandoff"]["after"]
        current = access_observation(plan)
        fresh_snapshot = snapshot()
        # Session group text must change on genuine login; numeric groups above
        # bind the exact membership while every installed-state field stays fixed.
        installed_before = {key: value for key, value in REPORT["afterSetup"].items() if key != "groups"}
        installed_now = {key: value for key, value in fresh_snapshot.items() if key != "groups"}
        if (current["user"] != previous["user"] or current["group"] != previous["group"] or current["socket"] != previous["socket"] or current["members"] != previous["members"]
                or set(current["accountGroups"]) != set(previous["accountGroups"]) or set(current["sessionGroups"]) != set(previous["accountGroups"]) or plan["group"]["gid"] not in current["sessionGroups"] or installed_now != installed_before):
            raise RuntimeError("Fresh ordinary login identity, groups or installed state differs")
        check_root()
        check_checkpoint()
        marker_body = json.dumps({"checkpointSha256": expected_digest, "nonce": nonce}).encode()
        marker = os.open("fresh-linux-resume-started.json", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        with os.fdopen(marker, "w+b") as stream:
            stream.write(marker_body)
            stream.flush()
            os.fsync(stream.fileno())
            os.fsync(directory)
            check_checkpoint()
            before_marker = os.fstat(stream.fileno())
            stream.seek(0)
            retained_marker = stream.read(4097)
            after_marker = os.fstat(stream.fileno())
            published_marker = os.stat("fresh-linux-resume-started.json", dir_fd=directory, follow_symlinks=False)
            if (not stat.S_ISREG(after_marker.st_mode) or after_marker.st_uid != os.getuid() or stat.S_IMODE(after_marker.st_mode) != 0o600 or after_marker.st_nlink != 1 or retained_marker != marker_body
                    or file_identity(before_marker) != file_identity(after_marker) or file_identity(published_marker) != file_identity(after_marker)):
                raise RuntimeError("Resume claim bytes or identity changed")
            check_root()
    finally:
        if checkpoint_fd is not None:
            os.close(checkpoint_fd)
        os.close(directory)
    debian_dependency_preservation("freshLogin", owned_binding)
    REPORT["freshLoginSnapshot"] = fresh_snapshot
    REPORT["accessResume"] = {"checkpointSha256": expected_digest, "sessionGroups": current["sessionGroups"]}
    REPORT["ordinaryUserSetupAfterResume"] = command_json("setup")
    REPORT["ordinaryUserDoctorAfterResume"] = command_json("doctor")
    state = object_field(command_data(REPORT["ordinaryUserDoctorAfterResume"]["result"]), "components")
    if object_field(state, "daemon").get("state") != "ready":
        REPORT["error"] = {"code": "NATIVE_SETUP_INCOMPLETE", "message": "Fresh ordinary login did not establish daemon readiness."}
        return
    finish_ready_guest(state, owned_binding)


def capture_signed_indexes():
    # APT's lock and acquisition directories are metadata, never signed indexes.
    root = "/var/lib/apt/lists"
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    REPORT["signedIndexes"] = []
    REPORT["aptListMetadata"] = []
    def identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    try:
        initial = os.fstat(directory)
        names = []
        with os.scandir(directory) as entries:
            for entry in entries:
                if len(names) >= 1024:
                    raise RuntimeError("APT index entry bound exceeded")
                names.append(entry.name)
        total = 0
        for name in sorted(names):
            budget_seconds(1)
            before = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if name == "lock" or name in ("partial", "auxfiles"):
                expected = stat.S_ISREG if name == "lock" else stat.S_ISDIR
                if not expected(before.st_mode):
                    raise RuntimeError("APT metadata has an unexpected type: " + name)
                REPORT["aptListMetadata"].append({"name": name, "type": "lock" if name == "lock" else "directory",
                                                  "uid": before.st_uid, "gid": before.st_gid, "mode": stat.S_IMODE(before.st_mode)})
                continue
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 64 * 1024 * 1024:
                raise RuntimeError("APT index type or size is unsafe: " + name)
            total += before.st_size
            if total > 512 * 1024 * 1024:
                raise RuntimeError("APT index total byte bound exceeded")
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                if identity(os.fstat(fd)) != identity(before):
                    raise RuntimeError("APT index identity changed: " + name)
                digest = hashlib.sha256()
                size = 0
                while True:
                    budget_seconds(1)
                    chunk = os.read(fd, min(1024 * 1024, before.st_size - size + 1))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > before.st_size:
                        raise RuntimeError("APT index grew during capture: " + name)
                    digest.update(chunk)
                if size != before.st_size or identity(os.fstat(fd)) != identity(before) or identity(os.stat(name, dir_fd=directory, follow_symlinks=False)) != identity(before):
                    raise RuntimeError("APT index changed during capture: " + name)
                REPORT["signedIndexes"].append({"name": name, "sha256": digest.hexdigest(), "size": size})
            finally:
                os.close(fd)
        if identity(os.fstat(directory)) != identity(initial) or identity(os.stat(root, follow_symlinks=False)) != identity(initial):
            raise RuntimeError("APT index directory changed during capture")
    finally:
        os.close(directory)


class OwnedGuestBinding(NamedTuple):
    nonce: str
    bootId: str
    uid: int
    manifestSha256: str


def parse_guest_invocation(arguments):
    resume = len(arguments) >= 3 and arguments[1] == '--resume'
    prefix = 3 if resume else 1
    if len(arguments) == 1 or len(arguments) == 3 and resume:
        return arguments[0], arguments[2] if resume else None, None
    tail = arguments[prefix:]
    if not arguments or not any(value.startswith('--owned-guest-') for value in tail):
        return '', None, None
    if len(tail) != 6 or tail[::2] != ['--owned-guest-boot-id', '--owned-guest-uid', '--owned-guest-manifest-sha256']:
        raise RuntimeError('Complete original owned guest binding required')
    nonce = arguments[0]
    boot_id, uid_text, manifest_sha = tail[1::2]
    if (not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', nonce)
            or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', boot_id)
            or len(uid_text) > 10 or not re.fullmatch(r'[0-9]+', uid_text) or not 0 < int(uid_text) < 2**31
            or not re.fullmatch(r'[a-f0-9]{64}', manifest_sha)):
        raise RuntimeError('Complete canonical original owned guest binding required')
    return nonce, arguments[2] if resume else None, OwnedGuestBinding(nonce, boot_id, int(uid_text), manifest_sha)


def parse_recorded_guest_invocation(arguments):
    recorded = '--recorded-helpers' in arguments
    if recorded:
        if arguments[-1] != '--recorded-helpers' or arguments.count('--recorded-helpers') != 1:
            raise RuntimeError('Exact recorded helper selection required')
        arguments = arguments[:-1]
    nonce, resume, binding = parse_guest_invocation(arguments)
    if recorded and binding is None:
        raise RuntimeError('Recorded helpers require complete original owned binding')
    return nonce, resume, binding, recorded


def verify_owned_binding(binding, *, query=None, absolute_deadline=None):
    if binding is None:
        return None
    if type(binding) is not OwnedGuestBinding or binding.uid != os.getuid() or binding.uid <= 0:
        raise RuntimeError("Original ordinary owned guest binding required")
    started = time.monotonic()
    end = started + 10
    if GUEST_DEADLINE is not None:
        end = min(end, GUEST_DEADLINE)
    if absolute_deadline is not None:
        if type(absolute_deadline) not in (int, float) or not math.isfinite(absolute_deadline):
            raise RuntimeError("Original owned phase deadline required")
        end = min(end, absolute_deadline)
    limit = math.floor((end - time.monotonic()) * 1000) / 1000
    if limit < 0.001:
        raise TimeoutError("Original owned guest validation deadline expired")
    command = query if query is not None else lambda args, timeout, allowed: run(args, timeout, allowed, absolute_deadline=end)
    code, text, _ = command(['/usr/bin/python3', '-I', '/usr/local/lib/fleur-owned-guest.py',
                             '--owned-guest-nonce', binding.nonce, '--budget-seconds', format(limit, '.3f')],
                            timeout=limit, allowed=(0, 4))
    if time.monotonic() >= end:
        raise TimeoutError("Original owned guest validation deadline expired")
    if type(code) is not int or code != 0 or len(text.encode()) > 65536:
        raise RuntimeError("Original owned guest fixture custody could not be revalidated")
    observed = json.loads(text)
    if (type(observed) is not dict or type(observed.get('formatVersion')) is not int or observed.get('formatVersion') != 1
            or observed.get('scope') != 'owned-guest-custody-validation' or observed.get('ok') is not True
            or observed.get('fixtureCustodyValidated') is not True or observed.get('runtimeSupport') != 'unverified'
            or observed.get('runtimeAdmission') is not False or observed.get('humanConsentProof') is not False
            or observed.get('nativeCpuPerformanceProof') is not False
            or type(observed.get('uid')) is not int
            or tuple(observed.get(key) for key in binding._fields) != tuple(binding)):
        raise RuntimeError("Original owned guest fixture binding changed")
    os_release = observed.get('osRelease')
    if (type(os_release) is not dict or set(os_release) != {'id', 'versionId', 'sha256'}
            or (os_release['id'], os_release['versionId']) not in (('ubuntu','24.04'), ('ubuntu','26.04'), ('debian','13'))
            or type(os_release['sha256']) is not str or re.fullmatch(r'[a-f0-9]{64}', os_release['sha256']) is None):
        raise RuntimeError('Original owned guest OS binding is incomplete')
    REPORT['ownedGuestCustody'] = {key: observed[key] for key in ('formatVersion', 'scope', 'ok', *binding._fields,
        'fixtureCustodyValidated', 'runtimeSupport', 'runtimeAdmission', 'humanConsentProof', 'nativeCpuPerformanceProof', 'osRelease')}
    return binding


INTERNAL_CATALOGS = {
    'ubuntu-24.04-amd64-docker-2026-10-19': ('540de9d76fc2aa8c260d1579a68c64ff0f1474b61cd332cfd428785432a56e58', 'ubuntu', '24.04', 'x64'),
    'ubuntu-26.04-amd64-docker-2026-10-19': ('e1d4756d2b9d6ce7dfccff783bb64e50bde09be1c36a8c36f1a2d4577937eb3a', 'ubuntu', '26.04', 'x64'),
    'debian-13-amd64-docker-2026-10-19': ('032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d', 'debian', '13', 'x64'),
}


def checked_internal_candidate():
    started = time.monotonic()
    deadline = started + budget_seconds(10)
    def check_budget():
        if time.monotonic() >= deadline:
            raise TimeoutError('Internal candidate catalog deadline expired')
    check_budget()
    directory = os.open(ROOT/'package', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    records = []
    try:
        check_budget()
        parent = os.fstat(directory)
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o022:
            raise RuntimeError('Internal candidate catalog custody differs')
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise RuntimeError('Internal candidate catalog has duplicate fields')
                value[key] = item
            return value
        def read(name):
            check_budget()
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                check_budget()
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_mode & 0o022 or not 0 < before.st_size <= 65536:
                    raise RuntimeError('Internal candidate catalog custody differs')
                body = bytearray()
                while len(body) <= before.st_size:
                    check_budget()
                    chunk = os.read(fd, min(65536, before.st_size+1-len(body)))
                    if not chunk:
                        break
                    body.extend(chunk)
                check_budget()
                after = os.fstat(fd)
                check_budget()
                named = os.stat(name, dir_fd=directory, follow_symlinks=False)
                check_budget()
                if len(body) != before.st_size or file_identity(before) != file_identity(after) or file_identity(before) != file_identity(named):
                    raise RuntimeError('Internal candidate catalog changed')
                records.append((name, file_identity(before)))
                return bytes(body)
            finally:
                os.close(fd)
        metadata = json.loads(read('internal-native-candidate.json'), object_pairs_hook=unique)
        catalog_id = metadata.get('catalogId') if type(metadata) is dict else None
        if type(catalog_id) is not str or catalog_id not in INTERNAL_CATALOGS:
            raise RuntimeError('Internal candidate target is not source-owned')
        expected_sha, distribution, release, architecture = INTERNAL_CATALOGS[catalog_id]
        raw = read('internal-native-candidate-catalog.json')
        if hashlib.sha256(raw).hexdigest() != expected_sha:
            raise RuntimeError('Internal candidate catalog bytes differ')
        catalog = json.loads(raw, object_pairs_hook=unique)
        fields = ('formatVersion', 'catalogId', 'artifactAuthentication', 'installationEvidence', 'runtimeSupport', 'authentication', 'artifacts', 'limits')
        if (metadata.get('internalArtifact') is not True or metadata.get('catalogSha256') != expected_sha
                or json.dumps(metadata.get('legacyProfileAdmission'), sort_keys=True, allow_nan=False) != json.dumps({'verified':True, 'meaning':'internal-catalog-admission-only'}, sort_keys=True)
                or json.dumps({key:metadata.get(key) for key in fields}, sort_keys=True, allow_nan=False) != json.dumps({key:catalog[key] for key in fields}, sort_keys=True, allow_nan=False)
                or (catalog['profile']['distribution'], catalog['profile']['release'], catalog['profile']['architecture']) != (distribution, release, architecture)):
            raise RuntimeError('Internal candidate catalog metadata differs')
        for name, expected in records:
            check_budget()
            if file_identity(os.stat(name, dir_fd=directory, follow_symlinks=False)) != expected:
                raise RuntimeError('Internal candidate catalog changed')
        check_budget()
        named = (ROOT/'package').lstat()
        check_budget()
        if (named.st_dev, named.st_ino, named.st_mode, named.st_uid) != (parent.st_dev, parent.st_ino, parent.st_mode, parent.st_uid) or time.monotonic() >= deadline:
            raise RuntimeError('Internal candidate catalog custody changed')
        REPORT['executionArtifact'] = {'kind':'internal-candidate', 'catalogId':catalog_id, 'catalogSha256':expected_sha}
        return catalog
    finally:
        os.close(directory)


def legacy_os_release_snapshot():
    started = time.monotonic()
    deadline = started + budget_seconds(10)
    def check_budget():
        if time.monotonic() >= deadline:
            raise TimeoutError('Legacy OS release snapshot deadline expired')
    check_budget()
    # /etc/os-release normally aliases /usr/lib/os-release. Retain the opened
    # regular target and compare its published identity; never block on a FIFO.
    fd = os.open('/etc/os-release', os.O_RDONLY | os.O_NONBLOCK)
    try:
        check_budget()
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_mode & 0o022 or not 0 < before.st_size <= 16384:
            raise RuntimeError('Legacy OS release type or size is unsafe')
        body = bytearray()
        while len(body) <= before.st_size:
            check_budget()
            block = os.read(fd, min(4096, before.st_size+1-len(body)))
            check_budget()
            if not block:
                break
            body.extend(block)
        check_budget()
        after = os.fstat(fd)
        check_budget()
        named = os.stat('/etc/os-release')
        check_budget()
        if len(body) != before.st_size or file_identity(before) != file_identity(after) or file_identity(after) != file_identity(named):
            raise RuntimeError('Legacy OS release snapshot changed')
        return bytes(body).decode()
    finally:
        os.close(fd)


def verify_guest_candidate_target(owned_binding):
    if owned_binding is not None:
        # The original manifest and same protected read already authenticate
        # these bytes. Do not replace that proof with another /etc pathname read.
        observed = REPORT.get('ownedGuestCustody', {}).get('osRelease')
        if (type(observed) is not dict or set(observed) != {'id', 'versionId', 'sha256'}
                or (observed['id'], observed['versionId']) not in (('ubuntu','24.04'), ('ubuntu','26.04'), ('debian','13'))
                or type(observed['sha256']) is not str or re.fullmatch(r'[a-f0-9]{64}', observed['sha256']) is None):
            raise RuntimeError('Original owned guest candidate target OS binding changed')
        fields = {'ID':observed['id'], 'VERSION_ID':observed['versionId']}
        release = observed['versionId']
        os_release = None  # No redundant raw-file observation is claimed.
        os_evidence = {'source':'validated-owned-manifest', **observed}
    else:
        os_release = legacy_os_release_snapshot()
        fields = {}
        for line in os_release.splitlines():
            if '=' in line:
                key, value = line.split('=', 1)
                if key in fields:
                    raise RuntimeError('Guest candidate target OS record is ambiguous')
                fields[key] = value.strip('"')
        release = '24.04'
        if fields.get('ID') != 'ubuntu' or fields.get('VERSION_ID') != release:
            raise RuntimeError('Legacy guest candidate target requires the original Ubuntu24 fixture')
        os_evidence = {'source':'legacy-nonce-only-observation', 'fixtureCustodyValidated':False,
                       'id':fields['ID'], 'versionId':release, 'sha256':hashlib.sha256(os_release.encode()).hexdigest()}
    if (fields.get('ID'), release) not in (('ubuntu','24.04'), ('ubuntu','26.04'), ('debian','13')) or run(['uname', '-m'])[1].strip() != 'x86_64':
        raise RuntimeError('Guest candidate target differs from the closed native tuple')
    try:
        (ROOT/'package/internal-native-candidate.json').lstat()
    except FileNotFoundError:
        if release not in ORDINARY_QUALIFICATIONS or fields.get('ID') != ORDINARY_QUALIFICATIONS[release]['distribution']:
            raise RuntimeError('Ordinary guest candidate target is not admitted')
    else:
        catalog = checked_internal_candidate()
        if (catalog['profile']['distribution'], catalog['profile']['release'], catalog['profile']['architecture']) != (fields['ID'], release, 'x64'):
            raise RuntimeError('Internal candidate target differs from the original guest OS')
    return os_release, os_evidence


ORDINARY_QUALIFICATIONS = {
    '24.04': {'distribution':'ubuntu', 'suite':'noble', 'reportSha256':'75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2',
              'sourceCommit':'a9606d74fd55b252c0aab8432ff72ec513457a5e',
              'artifactCatalogSha256':'540de9d76fc2aa8c260d1579a68c64ff0f1474b61cd332cfd428785432a56e58'},
    '26.04': {'distribution':'ubuntu', 'suite':'resolute', 'reportSha256':'5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07',
              'sourceCommit':'ad3869c6d34e01bebd16a248adeb8c3e53d53d8a',
              'artifactCatalogSha256':'e1d4756d2b9d6ce7dfccff783bb64e50bde09be1c36a8c36f1a2d4577937eb3a'},
    '13': {'distribution':'debian', 'suite':'trixie',
           'reportSha256':'6b4066ed5c199006695d769d07ec5d813fa8cddff1d396a089e1749d6c27231e',
           'sourceCommit':'300cdaf30e1ea4786b096786e458f698984fe038',
           'artifactCatalogSha256':'032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d',
           'profileSha256':'588ab6035cc9ff24d0591cd10a0fe3c066f092f7bdf297610907ce4835289983'},
}


def ordinary_target_release():
    custody = REPORT.get('ownedGuestCustody')
    if custody is None:
        # Legacy nonce-only fixtures remain limited to Ubuntu24 by the OS gate.
        return '24.04'
    os_release = custody.get('osRelease') if type(custody) is dict else None
    if (type(os_release) is not dict or os_release.get('versionId') not in ORDINARY_QUALIFICATIONS
            or os_release.get('id') != ORDINARY_QUALIFICATIONS[os_release['versionId']]['distribution']):
        raise RuntimeError('Original ordinary target OS is unavailable')
    return os_release['versionId']


def checked_ordinary_profile(entry):
    if type(entry) is not dict or set(entry) != {'evidence', 'profile'} or type(entry['profile']) is not dict:
        raise RuntimeError('Compiled ordinary profile evidence differs')
    profile = entry['profile']
    release = profile.get('release')
    if type(release) is not str or release not in ORDINARY_QUALIFICATIONS:
        raise RuntimeError('Compiled ordinary profile target differs')
    qualification = ORDINARY_QUALIFICATIONS[release]
    evidence = {key:qualification[key] for key in ('reportSha256', 'sourceCommit', 'artifactCatalogSha256')}
    if entry['evidence'] != evidence:
        raise RuntimeError('Compiled ordinary profile evidence differs')
    if qualification['distribution'] == 'debian':
        # Pin the entire canonical eight-package profile, including every nested
        # dependency authority, artifact and side effect, to the measured catalog.
        digest = hashlib.sha256(json.dumps(profile, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if digest != qualification['profileSha256']:
            raise RuntimeError('Compiled ordinary Debian dependency closure differs')
        return release, {**profile['packages'], **{name: artifact['version'] for name, artifact in profile['distroDependencies']['artifacts'].items()}}
    suite = qualification['suite']
    expected = {'docker-ce': f'5:29.9.1-1~ubuntu.{release}~{suite}', 'docker-ce-cli': f'5:29.9.1-1~ubuntu.{release}~{suite}',
                'containerd.io': f'2.4.2-2~ubuntu.{release}~{suite}', 'docker-buildx-plugin': f'0.38.0-1~ubuntu.{release}~{suite}',
                'docker-compose-plugin': f'5.6.0-1~ubuntu.{release}~{suite}'}
    if (set(profile) != {'method', 'verified', 'distribution', 'release', 'architecture', 'repositoryFingerprint', 'packages', 'artifacts'}
            or profile['method'] != 'docker-official-apt' or profile['verified'] is not True or profile['distribution'] != 'ubuntu'
            or profile['architecture'] != 'x64'
            or profile['repositoryFingerprint'] != '9DC858229FC7DD38854AE2D88D81803C0EBFCD88' or profile['packages'] != expected
            or type(profile['artifacts']) is not dict or set(profile['artifacts']) != set(expected)):
        raise RuntimeError('Compiled ordinary profile tuple differs')
    for name, version in expected.items():
        item = profile['artifacts'][name]
        if (type(item) is not dict or set(item) != {'name', 'version', 'architecture', 'url', 'sha256', 'size'}
                or item['name'] != name or item['version'] != version or item['architecture'] != 'amd64'
                or type(item['url']) is not str or not item['url'].startswith(f'https://download.docker.com/linux/ubuntu/dists/{suite}/pool/stable/amd64/')
                or type(item['sha256']) is not str or not re.fullmatch(r'[a-f0-9]{64}', item['sha256'])
                or type(item['size']) is not int or item['size'] <= 0):
            raise RuntimeError('Compiled ordinary profile artifact differs')
    return release, expected


def installation_packages():
    marker = ROOT / "package/internal-native-candidate.json"
    try:
        marker.lstat()
    except FileNotFoundError:
        pass
    else:
        # Preserve the existing internal-candidate artifact contract.
        catalog = checked_internal_candidate()
        return [item['name'] + '=' + item['version'] for item in catalog['artifacts']]
    package = json.loads((ROOT / 'package/package.json').read_text())
    if type(package) is not dict or package.get('name') != 'fleur' or 'fleurInternalNativeCandidate' in package:
        raise RuntimeError('Ordinary verification requires the real Fleur package without an internal marker')
    path = ROOT / 'package/src/setup/verified-apt-profiles.json'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= 65536:
            raise RuntimeError('Compiled ordinary profile metadata custody is invalid')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            body = stream.read(65537)
        after = os.fstat(fd)
        if len(body) != before.st_size or file_identity(before) != file_identity(after) or file_identity(path.lstat()) != file_identity(after):
            raise RuntimeError('Compiled ordinary profile metadata changed')
    finally:
        os.close(fd)
    def unique(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise RuntimeError('Compiled ordinary profile contains duplicate fields')
            result[name] = value
        return result
    value = json.loads(body, object_pairs_hook=unique)
    if (type(value) is not dict or set(value) != {'formatVersion', 'entries'} or type(value['formatVersion']) is not int
            or value['formatVersion'] != 1 or type(value['entries']) is not list or not 1 <= len(value['entries']) <= len(ORDINARY_QUALIFICATIONS)):
        raise RuntimeError('Exact compiled ordinary profile record required')
    profiles = {}
    for entry in value['entries']:
        release, packages = checked_ordinary_profile(entry)
        if release in profiles:
            raise RuntimeError('Duplicate compiled ordinary profile target')
        profiles[release] = packages
    release = ordinary_target_release()
    if release not in profiles:
        raise RuntimeError('Compiled ordinary profile differs from the original OS target')
    expected = profiles[release]
    evidence = ORDINARY_QUALIFICATIONS[release]
    REPORT['executionArtifact'] = {'kind': 'ordinary', 'packageName': 'fleur', 'admissionMetadataSha256': hashlib.sha256(body).hexdigest(),
                                  'artifactCatalogSha256': evidence['artifactCatalogSha256']}
    return [name + '=' + version for name, version in expected.items()]


# Fixture-only root actions. This source is never a product installer capability.
DEBIAN_CANARY_ROOT = r"""import importlib.util,json,math,os,re,selectors,shlex,signal,stat,subprocess,sys,time
request=json.loads(sys.argv[1]);binding=request['binding'];phase=request['phase'];end=request['deadline']
if (set(request)!={'binding','phase','deadline'} or set(binding)!={'nonce','bootId','uid','manifestSha256'} or phase not in ('before','afterInstall','freshLogin','afterRuntime','cleanup')
 or os.getuid()!=0 or os.geteuid()!=0 or type(end) not in (int,float) or not math.isfinite(end) or not time.monotonic()<end<=time.monotonic()+30):raise RuntimeError('Fixed owned canary invocation required')
producer='/usr/local/lib/fleur-owned-guest.py'
for path in ('/','/usr','/usr/local','/usr/local/lib',producer):
 info=os.lstat(path)
 if info.st_uid!=0 or info.st_mode&0o022 or stat.S_ISLNK(info.st_mode):raise RuntimeError('Unsafe protected canary validator')
spec=importlib.util.spec_from_file_location('fleur_canary_custody',producer);module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
def custody():
 context=module.validate(binding['nonce'],deadline=end,ordinary_uid=binding['uid'])
 if (context.boot_id,context.uid,context.manifest_sha256)!=(binding['bootId'],binding['uid'],binding['manifestSha256']) or context.os_release[:2]!=('debian','13'):raise RuntimeError('Original Debian canary custody changed')
 return context
custody()
if re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',binding['nonce']) is None:raise RuntimeError('Canonical nonce required')
chain='FL'+binding['nonce'].replace('-','')[:20];comment='fleur-'+binding['nonce'];tool='/usr/sbin/iptables-nft'
def command(args,allowed=(0,)):
 custody();remaining=end-time.monotonic()
 if remaining<=0:raise TimeoutError('Canary deadline expired')
 child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
 selector=None
 try:
  output={child.stdout:bytearray(),child.stderr:bytearray()}
  selector=selectors.DefaultSelector()
  for stream in output:selector.register(stream,selectors.EVENT_READ)
  while selector.get_map():
   if time.monotonic()>=end:raise TimeoutError('Owned canary command deadline expired')
   for key,_ in selector.select(min(0.1,max(0,end-time.monotonic()))):
    part=os.read(key.fileobj.fileno(),8192)
    if not part:selector.unregister(key.fileobj);continue
    bound=1048576 if key.fileobj is child.stdout else 65536
    if len(output[key.fileobj])+len(part)>bound:raise RuntimeError('Owned canary command output exceeded its bound')
    output[key.fileobj].extend(part)
  while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
   if time.monotonic()>=end:raise TimeoutError('Owned canary command deadline expired')
   time.sleep(0.01)
  if time.monotonic()>=end:raise TimeoutError('Owned canary command deadline expired')
 finally:
  # The unreaped leader reserves this PGID until signaling is finished.
  try:
   try:os.killpg(child.pid,signal.SIGKILL)
   except (ProcessLookupError,PermissionError):pass
   child.wait(timeout=5)
   retirement=time.monotonic()+5
   while True:
    try:os.killpg(child.pid,0)
    except ProcessLookupError:break
    except PermissionError:pass
    if time.monotonic()>=retirement:raise RuntimeError('Owned canary command retirement unconfirmed')
    time.sleep(0.02)
  finally:
   try:
    if selector is not None:selector.close()
   finally:
    try:child.stdout.close()
    finally:child.stderr.close()
 if child.returncode not in allowed:raise RuntimeError('Owned canary observation failed')
 return bytes(output[child.stdout]).decode('utf-8')
for directory in ('/usr','/usr/sbin','/usr/bin'):
 info=os.stat(directory)
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('Unsafe firewall tool directory')
selected=os.path.realpath(tool);info=os.stat(selected)
if selected!='/usr/sbin/xtables-nft-multi' or not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('Unexpected firewall tool backend')
if command(['/usr/bin/dpkg-query','--root=/','--admindir=/var/lib/dpkg','--search','--',tool]).strip()!='iptables: '+tool:raise RuntimeError('Firewall tool ownership unavailable')
if command(['/usr/bin/dpkg','--root=/','--admindir=/var/lib/dpkg','--verify','iptables'])!='':raise RuntimeError('Firewall tool package integrity differs')
version=command([tool,'--version']).strip()
if re.fullmatch(r'iptables v[0-9]+\.[0-9]+\.[0-9]+ \(nf_tables\)',version) is None:raise RuntimeError('nf_tables backend required')
properties=['LoadState','ActiveState','SubState','UnitFileState','ExecMainPID','ExecMainStartTimestampMonotonic','ActiveEnterTimestampMonotonic','InactiveExitTimestampMonotonic']
raw=command(['/usr/bin/systemctl','show','nftables.service','--property='+','.join(properties)],(0,1,4));service={}
for line in raw.splitlines():
 key,separator,value=line.partition('=')
 if not separator or key not in properties or key in service:raise RuntimeError('Ambiguous nftables service observation')
 service[key]=value
if set(service)!=set(properties):raise RuntimeError('Incomplete nftables service observation')
expected={'LoadState':'not-found' if phase=='before' else 'loaded','ActiveState':'inactive','SubState':'dead','UnitFileState':'' if phase=='before' else 'disabled','ExecMainPID':'0','ExecMainStartTimestampMonotonic':'0','ActiveEnterTimestampMonotonic':'0','InactiveExitTimestampMonotonic':'0'}
if service!=expected:raise RuntimeError('nftables service executed or its state changed')
def detached():
 lines=command([tool,'--wait','2','-t','filter','-S']).splitlines()
 for line in lines:
  tokens=shlex.split(line)
  if any(tokens[i] in ('-j','-g','--jump','--goto') and tokens[i+1]==chain for i in range(len(tokens)-1)):raise RuntimeError('Owned canary acquired a reference')
 return lines
if phase=='before':
 if any(shlex.split(line)[:2]==['-N',chain] for line in detached()):raise RuntimeError('Owned canary collision')
 command([tool,'--wait','2','-t','filter','-N',chain])
 command([tool,'--wait','2','-t','filter','-A',chain,'-m','comment','--comment',comment,'-j','RETURN'])
detached();canary=command([tool,'--wait','2','-t','filter','-S',chain])
if [shlex.split(line) for line in canary.splitlines()]!=[['-N',chain],['-A',chain,'-m','comment','--comment',comment,'-j','RETURN']]:raise RuntimeError('Original owned canary changed')
if phase=='cleanup':
 command([tool,'--wait','2','-t','filter','-D',chain,'-m','comment','--comment',comment,'-j','RETURN'])
 command([tool,'--wait','2','-t','filter','-X',chain])
 if any(shlex.split(line)[:2]==['-N',chain] for line in detached()):raise RuntimeError('Owned canary cleanup unconfirmed')
custody();print(json.dumps({'binding':binding,'phase':phase,'backend':'nf_tables','tool':tool,'selectedTool':selected,'toolVersion':version,'chain':chain,'canary':canary,'service':service,'cleanup':phase=='cleanup'}))
"""


def debian_dependency_preservation(phase, owned_binding):
    artifact = REPORT.get('executionArtifact', {})
    internal = artifact.get('catalogId') == 'debian-13-amd64-docker-2026-10-19'
    ordinary = (artifact.get('kind') == 'ordinary' and artifact.get('packageName') == 'fleur'
                and artifact.get('artifactCatalogSha256') == ORDINARY_QUALIFICATIONS['13']['artifactCatalogSha256'])
    if not internal and not ordinary:
        return
    if type(owned_binding) is not OwnedGuestBinding:
        raise RuntimeError('Debian dependency canary requires the original owned guest')
    verify_owned_binding(owned_binding)
    if phase not in ('before', 'afterInstall', 'freshLogin', 'afterRuntime', 'cleanup'):
        raise RuntimeError('Fixed canary phase required')
    prior = {'before':[], 'afterInstall':['before'], 'freshLogin':['before','afterInstall'], 'afterRuntime':['before','afterInstall','freshLogin'], 'cleanup':['before','afterInstall','freshLogin','afterRuntime']}[phase]
    existing = REPORT.get('debianDependencyPreservation', {}).get('observations', {})
    if list(existing) != prior or REPORT.get('debianDependencyPreservation', {}).get('cleanup') is True:
        raise RuntimeError('Owned canary phase sequence differs')
    deadline = time.monotonic() + budget_seconds(30)
    request = {'binding': owned_binding._asdict(), 'phase': phase, 'deadline': deadline}
    _, text, _ = run(['/usr/bin/sudo', '--non-interactive', '--', '/usr/bin/python3', '-I', '-c', DEBIAN_CANARY_ROOT, json.dumps(request)], timeout=30, absolute_deadline=deadline)
    if len(text.encode()) > 16384:
        raise RuntimeError('Canary report exceeded its bound')
    frame = json.loads(text)
    chain = 'FL' + owned_binding.nonce.replace('-', '')[:20]
    if (type(frame) is not dict or set(frame) != {'binding','phase','backend','tool','selectedTool','toolVersion','chain','canary','service','cleanup'}
            or frame['binding'] != owned_binding._asdict() or frame['phase'] != phase or frame['backend'] != 'nf_tables'
            or frame['tool'] != '/usr/sbin/iptables-nft' or frame['selectedTool'] != '/usr/sbin/xtables-nft-multi'
            or type(frame['toolVersion']) is not str or re.fullmatch(r'iptables v[0-9]+\.[0-9]+\.[0-9]+ \(nf_tables\)', frame['toolVersion']) is None
            or frame['chain'] != chain or type(frame['canary']) is not str or type(frame['service']) is not dict or frame['cleanup'] is not (phase == 'cleanup')):
        raise RuntimeError('Original canary result binding differs')
    expected_canary = [['-N',chain],['-A',chain,'-m','comment','--comment','fleur-'+owned_binding.nonce,'-j','RETURN']]
    import shlex
    if [shlex.split(line) for line in frame['canary'].splitlines()] != expected_canary:
        raise RuntimeError('Owned detached canary differs')
    expected_service = {'LoadState':'not-found' if phase == 'before' else 'loaded','ActiveState':'inactive','SubState':'dead','UnitFileState':'' if phase == 'before' else 'disabled','ExecMainPID':'0','ExecMainStartTimestampMonotonic':'0','ActiveEnterTimestampMonotonic':'0','InactiveExitTimestampMonotonic':'0'}
    if frame['service'] != expected_service:
        raise RuntimeError('nftables service execution or state differs')
    evidence = REPORT.setdefault('debianDependencyPreservation', {'scope':'owned-disconnected-canary-and-nftables-service-only','backend':'nf_tables','cleanup':False,'observations':{}})
    observations = evidence['observations']
    prior = {'before':[], 'afterInstall':['before'], 'freshLogin':['before','afterInstall'], 'afterRuntime':['before','afterInstall','freshLogin'], 'cleanup':['before','afterInstall','freshLogin','afterRuntime']}[phase]
    if list(observations) != prior:
        raise RuntimeError('Owned canary phase sequence differs')
    if phase != 'before' and any(frame[key] != observations['before'][key] for key in ('binding','backend','tool','selectedTool','toolVersion','chain','canary')):
        raise RuntimeError('Owned canary changed across setup')
    if phase == 'cleanup':
        evidence['cleanup'] = True
    else:
        observations[phase] = frame


def main():
    global GUEST_DEADLINE, RECORDED_HELPERS
    GUEST_DEADLINE = time.monotonic() + 900
    nonce, resume_digest, owned_binding, RECORDED_HELPERS = parse_recorded_guest_invocation(sys.argv[1:])
    if RECORDED_HELPERS:
        REPORT['helperMode'] = 'recorded-prebuilt'
    resume = resume_digest is not None
    if not re.fullmatch(r"[a-f0-9-]{36}", nonce) or Path("/etc/fleur-owned-guest").read_text().strip() != nonce:
        raise RuntimeError("Owned guest identity is absent")
    if os.getuid() == 0 or Path("/proc/1/comm").read_text().strip() != "systemd":
        raise RuntimeError("Ordinary guest account and its own systemd are required")
    if resume:
        resume_guest(nonce, resume_digest, owned_binding)
        return
    verify_owned_binding(owned_binding)
    if RECORDED_HELPERS:
        REPORT['recordedHelperInputs'] = recorded_helper_handoff()
    try:
        (ROOT / "fresh-linux-state.json").lstat()
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError("An existing enrollment checkpoint requires explicit resume; initial authority was refused")
    ordinary_packages = None
    try:
        (ROOT / "package/internal-native-candidate.json").lstat()
    except FileNotFoundError:
        ordinary_packages = installation_packages()
    os_release, os_evidence = verify_guest_candidate_target(owned_binding)
    REPORT["guest"] = {"osRelease": os_release, "osReleaseEvidence": os_evidence, "kernel": run(["uname", "-srmo"])[1],
                       "virtualization": run(["systemd-detect-virt"])[1].strip(), "bun": run([BUN, "--version"])[1].strip()}
    if REPORT["guest"]["virtualization"] not in ("qemu", "kvm") or REPORT["guest"]["bun"] != release_floor():
        raise RuntimeError("Guest virtualization/runtime identity differs")
    baseline = snapshot()
    REPORT["baseline"] = baseline
    if any(re.match(r"(?:docker-ce|docker-ce-cli|containerd\.io|docker-buildx-plugin|docker-compose-plugin)\t", line) for line in baseline["packages"].splitlines()):
        raise RuntimeError("Guest already contains Docker packages; fresh-install proof refused")
    debian_dependency_preservation("before", owned_binding)
    REPORT["doctorBefore"] = command_json("doctor")
    REPORT["noninteractiveSetup"] = command_json("setup")
    if REPORT["noninteractiveSetup"]["exitCode"] != 3 or snapshot() != baseline:
        raise RuntimeError("Noninteractive setup altered baseline or failed to request authority")
    REPORT["deniedSetup"] = setup_pty("deny")
    if REPORT["deniedSetup"]["exitCode"] != 3 or REPORT["deniedSetup"]["promptsAnswered"] != 1 or snapshot() != baseline:
        raise RuntimeError("Denied setup altered baseline or did not preserve authority boundary")
    REPORT["authorizedFixtureSetup"] = setup_pty("once")
    REPORT["afterSetup"] = snapshot()
    debian_dependency_preservation("afterInstall", owned_binding)
    packages = ordinary_packages if ordinary_packages is not None else installation_packages()
    simulation = run(["apt-get", "--simulate", "--no-install-recommends", "--no-remove", "--no-upgrade", "install"] + packages, allowed=(0, 100))
    REPORT["actualDependencySimulation"] = {"exitCode": simulation[0], "stdout": simulation[1], "stderr": simulation[2]}
    capture_signed_indexes()
    REPORT["reprobe"] = command_json("setup")
    REPORT["ordinaryUserDoctor"] = command_json("doctor")
    state = object_field(command_data(REPORT["ordinaryUserDoctor"]["result"]), "components")
    if object_field(state, "daemon").get("state") == "denied":
        reprobe = REPORT["reprobe"]
        envelope = reprobe["result"]
        command_data(envelope)
        if (envelope.get("ok") is False and isinstance(envelope.get("error"), dict)
                and (reprobe["exitCode"], envelope["error"].get("code")) in ((4, "PREREQUISITE_UNAVAILABLE"), (5, "RECOVERY_REQUIRED"))):
            REPORT["error"] = {"code": "NATIVE_SETUP_INCOMPLETE", "message": "Setup did not provide enrollment authority. Inspect the preserved setup and doctor results before resuming."}
            return
        enrollment_handoff(nonce, owned_binding)
        return
    if object_field(state, "daemon").get("state") != "ready":
        REPORT["error"] = {"code": "NATIVE_SETUP_INCOMPLETE", "message": "Inspect actual setup transcript, package state and signed repository evidence. No dependency preinstallation was performed."}
        return
    finish_ready_guest(state, owned_binding)


def finish_ready_guest(state, owned_binding=None):
    # Doctor's complete image identity and nonce checks remain the product boundary.
    # No public image-acquire grant mint is available here; missing authority stays incomplete.
    if object_field(state, "smoke").get("state") != "ready":
        REPORT["smokeAcquisitionPlan"] = command_json("setup")
        observed = REPORT["smokeAcquisitionPlan"]
        envelope = observed["result"]
        plan = object_field(command_data(envelope), "plan")
        checksum = plan.get("checksum", "")
        prior_checksums = {prompt["checksum"] for phase in ("authorizedFixtureSetup", "separateEnrollmentSetup") for prompt in REPORT.get(phase, {}).get("prompts", [])}
        if (observed["exitCode"] != 3 or envelope.get("ok") is not False or object_field(envelope, "error").get("code") != "AUTHORITY_REQUIRED"
                or plan.get("action") != "image-acquire" or plan.get("method") != "docker-digest-pull"
                or object_field(state, "smoke").get("state") != "image-required" or plan.get("image") != state["smoke"].get("image")
                or not re.fullmatch(r"oven/bun@sha256:[a-f0-9]{64}", plan.get("image", "")) or not re.fullmatch(r"[a-f0-9]{64}", checksum) or checksum in prior_checksums):
            raise RuntimeError("Separate smoke image acquisition plan is invalid")
        context = run(["docker", "context", "show"])[1].strip()
        endpoint = json.loads(run(["docker", "context", "inspect", context, "--format", "{{json .Endpoints.docker}}"])[1])["Host"]
        if not isinstance(endpoint, str) or not re.fullmatch(r"unix:///[^\s?#]+", endpoint):
            raise RuntimeError("Smoke acquisition endpoint is not a local Unix socket")
        target = plan["image"] + " via " + endpoint
        if len(target) > 512:
            raise RuntimeError("Smoke acquisition target exceeds its bound")
        REPORT["smokeAcquisitionFixture"] = setup_pty("once", expected_prompt={"action": "image-acquire", "method": "docker-digest-pull", "target": target, "checksum": checksum})
        if REPORT["smokeAcquisitionFixture"]["promptsAnswered"] != 1:
            raise RuntimeError("Separate image acquisition did not present exactly one matching prompt")
        REPORT["ordinaryUserDoctorAfterAcquisition"] = command_json("doctor")
        state = object_field(command_data(REPORT["ordinaryUserDoctorAfterAcquisition"]["result"]), "components")
        if object_field(state, "smoke").get("state") != "ready":
            REPORT["error"] = {"code": "SMOKE_AUTHORITY_REQUIRED", "message": "Separate supported image acquisition did not establish readiness."}
            return
    verify_smoke_and_restrictions(state, owned_binding)


def restriction_invocation(owned_binding):
    if RECORDED_HELPERS and owned_binding is None:
        raise RuntimeError('Recorded helpers require original owned restriction binding')
    args = ["python3", str(ROOT / "experiments/compatibility/runtime-probe/run.py"), "--architecture", "amd64", "--healthy-containerd-exit", "--idle-runtime-stress"]
    if owned_binding is None:
        return args, None
    if type(owned_binding) is not OwnedGuestBinding or type(GUEST_DEADLINE) not in (int, float) or not math.isfinite(GUEST_DEADLINE):
        raise RuntimeError("Original owned restriction binding and deadline required")
    started = time.monotonic()
    end = min(GUEST_DEADLINE, started + 600)
    if end <= started:
        raise TimeoutError("Guest aggregate verification deadline expired")
    args += ['--owned-guest-nonce', owned_binding.nonce, '--owned-guest-boot-id', owned_binding.bootId,
             '--owned-guest-uid', str(owned_binding.uid), '--owned-guest-manifest-sha256', owned_binding.manifestSha256,
             '--owned-guest-deadline', str(end)]
    if RECORDED_HELPERS:
        args += ['--recorded-helper-artifacts', str(ROOT/'recorded-helpers')]
    return args, end


def grant_snapshot():
    budget_seconds(10)
    path = Path.home() / '.local/state/fleur/setup/grants.json'
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1
                or stat.S_IMODE(before.st_mode) & 0o077 or not 0 <= before.st_size <= 1024 * 1024):
            raise RuntimeError('Ready setup grant custody is invalid')
        parts = []
        count = 0
        while True:
            budget_seconds(10)
            part = os.read(fd, min(65536, before.st_size + 1 - count))
            if not part:
                break
            parts.append(part)
            count += len(part)
            if count > before.st_size:
                raise RuntimeError('Ready setup grants changed during read')
        after = os.fstat(fd)
        if count != before.st_size or file_identity(before) != file_identity(after) or file_identity(path.lstat()) != file_identity(after):
            raise RuntimeError('Ready setup grant custody changed')
        return {'identity': file_identity(after), 'sha256': hashlib.sha256(b''.join(parts)).hexdigest()}
    finally:
        os.close(fd)


def admitted_readiness(observed, command):
    if type(observed) is not dict or type(observed.get('exitCode')) is not int or observed['exitCode'] != 0:
        return False
    envelope = observed.get('result')
    if (type(envelope) is not dict or set(envelope) != {'formatVersion', 'command', 'ok', 'data', 'error', 'truncated'}
            or type(envelope['formatVersion']) is not int or envelope['formatVersion'] != 1 or envelope['command'] != command
            or envelope['ok'] is not True or envelope['error'] is not None or envelope['truncated'] is not False
            or type(envelope['data']) is not dict or type(envelope['data'].get('components')) is not dict):
        return False
    components = envelope['data']['components']
    return (all(type(components.get(name)) is dict and components[name].get('state') == 'ready' for name in ('cli', 'daemon', 'compose', 'smoke'))
            and components['smoke'].get('cleanup') is True
            and admitted_ordinary_release(components.get('release'), ordinary_target_release()))


def admitted_ordinary_release(value, release):
    """Doctor's floor admission (#138): the guest's distribution target, its measured row among the rows, every tool admitted, evidence of a measured row."""
    distribution = ORDINARY_QUALIFICATIONS[release]['distribution']
    rows = {f"{distribution}-{other}-x64-docker-29.9.1": qualification['reportSha256'] for other, qualification in ORDINARY_QUALIFICATIONS.items() if qualification['distribution'] == distribution}
    if (type(value) is not dict or set(value) != {'state', 'floor', 'admission', 'measuredRows', 'machineTools', 'evidence'}
            or value['state'] != 'verified' or value['floor'] != f'{distribution}-x64-engine' or value['admission'] not in ('measured', 'above-floor')):
        return False
    measured = value['measuredRows']
    if type(measured) is not list or f'{distribution}-{release}-x64-docker-29.9.1' not in measured or any(type(row) is not str or row not in rows for row in measured):
        return False
    tools = value['machineTools']
    if (type(tools) is not list or [tool.get('tool') if type(tool) is dict else None for tool in tools] != ['release', 'kernel', 'bun', 'cli', 'engine', 'compose', 'containerd', 'runc']
            or any(set(tool) != {'tool', 'status', 'floor', 'detected', 'comparison'} or tool['status'] not in ('verified', 'admitted') for tool in tools)
            or tools[0]['detected'] != release):
        return False
    # Doctor cites the row the host release and server build match exactly, else the target's first row.
    evidence = value['evidence']
    return (type(evidence) is dict and set(evidence) == {'readinessSha256', 'isolationSha256'} and evidence['readinessSha256'] == evidence['isolationSha256']
            and evidence['readinessSha256'] in {rows[f'{distribution}-{release}-x64-docker-29.9.1'], next(iter(rows.values()))})


def observe_ordinary_daemon(docker):
    def object_result(arguments):
        observed = json.loads(run(docker + arguments, timeout=10)[1])
        if type(observed) is not dict:
            raise RuntimeError('Ordinary daemon observation is not an object')
        return observed
    def text(value):
        if type(value) is not str or not re.fullmatch(r'[\x20-\x7e]{1,256}', value):
            raise RuntimeError('Ordinary daemon identity field is invalid')
        return value
    raw_info = object_result(['info', '--format', '{{json .}}'])
    info = {key: text(raw_info.get(key)) for key in ('ServerVersion', 'KernelVersion', 'OSType', 'Architecture', 'Driver', 'CgroupDriver', 'CgroupVersion')}
    for key in ('MemoryLimit', 'SwapLimit', 'CpuCfsPeriod', 'CpuCfsQuota', 'PidsLimit'):
        if type(raw_info.get(key)) is not bool:
            raise RuntimeError('Ordinary daemon capability field is invalid')
        info[key] = raw_info[key]
    allowed_security = {'name=apparmor': 'apparmor', 'name=apparmor,profile=default': 'apparmor',
                        'name=selinux': 'selinux', 'name=cgroupns': 'cgroupns', 'name=rootless': 'rootless',
                        'name=userns': 'userns', 'name=seccomp,profile=builtin': 'seccomp'}
    raw_security = raw_info.get('SecurityOptions')
    security = {'state': 'unavailable', 'category': 'malformed', 'knownOptions': []}
    if type(raw_security) is list and len(raw_security) <= 16:
        known = [entry for entry in raw_security if type(entry) is str and entry in allowed_security]
        security['knownOptions'] = sorted(set(known))
        if any(type(entry) is not str for entry in raw_security):
            security['category'] = 'malformed'
        elif len(known) != len(raw_security):
            security['category'] = 'unknown'
        elif len({allowed_security[entry] for entry in known}) != len(known):
            security['category'] = 'duplicate'
        else:
            info['SecurityOptions'] = list(raw_security)
            security = {'state': 'recorded', 'operatingMode': 'rootless' if 'name=rootless' in known else 'rootful'}
    raw_server = object_result(['version', '--format', '{{json .Server}}'])
    server = {key: text(raw_server.get(key)) for key in ('Version', 'GitCommit', 'KernelVersion', 'Os', 'Arch')}
    platform = raw_server.get('Platform')
    if type(platform) is not dict:
        raise RuntimeError('Ordinary daemon platform is invalid')
    server['Platform'] = {'Name': text(platform.get('Name'))}
    components = raw_server.get('Components')
    if type(components) is not list or len(components) > 32:
        raise RuntimeError('Ordinary daemon component list is invalid')
    selected = {}
    for item in components:
        if type(item) is not dict or item.get('Name') not in ('Engine', 'containerd', 'runc'):
            continue
        name = item['Name']
        if name in selected or type(item.get('Details')) is not dict:
            raise RuntimeError('Ordinary daemon component identity is ambiguous')
        selected[name] = {'Name': name, 'Version': text(item.get('Version')), 'Details': {'GitCommit': text(item['Details'].get('GitCommit'))}}
    if set(selected) != {'Engine', 'containerd', 'runc'}:
        raise RuntimeError('Ordinary daemon component identity is incomplete')
    server['Components'] = [selected[name] for name in ('Engine', 'containerd', 'runc')]
    return {'formatVersion': 1, 'scope': 'ordinary-daemon-readiness-observation', 'runtimeAdmission': False,
            'source': 'ordinary-user-local-docker-cli', 'info': info, 'server': server, 'securityOptionsEvidence': security}


def observe_debian_candidate_daemon(docker):
    def identity():
        value = run(docker + ['info', '--format', '{{.ID}}'], timeout=10)[1].strip()
        if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9:._-]{0,255}', value) is None:
            raise RuntimeError('Candidate daemon identity is unavailable')
        return hashlib.sha256(value.encode()).hexdigest()
    before = identity()
    observed = observe_ordinary_daemon(docker)
    after = identity()
    info, server = observed['info'], observed['server']
    engine = server['Components'][0]
    if (before != after or observed['securityOptionsEvidence']['state'] != 'recorded'
            or info['ServerVersion'] != server['Version'] or info['KernelVersion'] != server['KernelVersion']
            or info['OSType'] != server['Os'] or server['Os'] != 'linux'
            or info['Architecture'] not in ('x86_64', 'amd64') or server['Arch'] != 'amd64'
            or engine['Version'] != server['Version'] or engine['Details']['GitCommit'] != server['GitCommit']):
        raise RuntimeError('Candidate daemon tuple is incoherent or changed')
    info['SecurityOptions'].sort()
    return {**observed, 'scope': 'debian-candidate-daemon-readiness-observation',
            'daemonIdSha256': before, 'restartContinuityProof': False}


def verify_smoke_and_restrictions(state, owned_binding=None):
    context = run(["docker", "context", "show"])[1].strip()
    endpoint = json.loads(run(["docker", "context", "inspect", context, "--format", "{{json .Endpoints.docker}}"])[1])["Host"]
    if not re.fullmatch(r"unix:///[^\s?#]+", endpoint):
        raise RuntimeError("Guest endpoint is not a local Unix socket")
    docker = ["docker", "--host", endpoint]
    if REPORT.get('executionArtifact', {}).get('kind') == 'ordinary':
        REPORT['ordinaryDaemonObservation'] = observe_ordinary_daemon(docker)
        if REPORT['ordinaryDaemonObservation']['securityOptionsEvidence']['state'] != 'recorded':
            raise RuntimeError('Ordinary daemon security option observation is unavailable')
    debian_candidate = REPORT.get('executionArtifact', {}).get('catalogId') == 'debian-13-amd64-docker-2026-10-19'
    if debian_candidate:
        verify_owned_binding(owned_binding)
        REPORT['candidateDaemonObservation'] = {'before': observe_debian_candidate_daemon(docker), 'stable': False}
    image = run([BUN, "-e", "import {smokeImages} from " + json.dumps(str(ROOT / "package/src/setup/profiles.ts")) + ";process.stdout.write(smokeImages.x64)"])[1]
    if not re.fullmatch(r"oven/bun@sha256:[a-f0-9]{64}", image):
        raise RuntimeError("Smoke image is not digest-pinned")
    original = run(docker + ["ps", "--all", "--quiet", "--no-trunc"])[1].splitlines()
    sentinel_nonce = os.urandom(16).hex()
    name = "fleur-guest-unrelated-" + sentinel_nonce
    sentinel = run(docker + ["create", "--name", name, "--label", "dev.fleur.guest-sentinel=" + sentinel_nonce,
                           "--network", "none", "--read-only", "--cap-drop", "ALL", "--pull", "never",
                           image, "/usr/local/bin/bun", "-e", "process.exit(0)"])[1].strip()
    if not re.fullmatch(r"[a-f0-9]{64}", sentinel):
        raise RuntimeError("Sentinel did not return full ownership identity")
    def sentinel_snapshot():
        data = json.loads(run(docker + ["inspect", sentinel])[1])[0]
        if data["Id"] != sentinel or data["Name"] != "/" + name or data["Config"]["Labels"].get("dev.fleur.guest-sentinel") != sentinel_nonce or data["State"]["Running"]:
            raise RuntimeError("Sentinel ownership/state changed; removal refused")
        return json.dumps(data, sort_keys=True)
    before_sentinel = sentinel_snapshot()
    try:
        for _ in range(2):
            before = snapshot()
            ordinary = REPORT.get('executionArtifact', {}).get('kind') == 'ordinary'
            grants_before = grant_snapshot() if ordinary else None
            observed = command_json("doctor")
            envelope = observed.get("result", {})
            components = object_field(command_data(envelope), "components")
            # The internal candidate deliberately remains release-unverified:
            # healthy readiness must retain doctor exit 4 and its exact envelope.
            ready = (observed.get("exitCode") == 4
                     and envelope.get("formatVersion") == 1
                     and envelope.get("command") == "doctor"
                     and envelope.get("ok") is False
                     and envelope.get("truncated") is False
                     and object_field(envelope, "error").get("code") == "PREREQUISITE_UNAVAILABLE"
                     and all(object_field(components, name).get("state") == "ready"
                             for name in ("cli", "daemon", "compose", "smoke"))
                     and object_field(components, "smoke").get("cleanup") is True
                     and object_field(components, "release").get("state") == "unverified")
            if ordinary:
                ready = admitted_readiness(observed, 'doctor')
                if ready:
                    reprobe = command_json('setup')
                    snapshots_equal = snapshot() == before
                    grants_equal = grant_snapshot() == grants_before
                    REPORT.setdefault('readySetupReprobes', []).append({**reprobe, 'snapshotPreserved': snapshots_equal, 'grantsPreserved': grants_equal})
                    if not admitted_readiness(reprobe, 'setup') or not snapshots_equal or not grants_equal:
                        raise RuntimeError('Ordinary ready setup reprobe changed state or requested new authority')
            if not ready or snapshot() != before or sentinel_snapshot() != before_sentinel or run(["docker", "context", "show"])[1].strip() != context:
                raise RuntimeError("Repeat ordinary-user smoke or host state preservation failed")
            REPORT["runs"].append(observed)
        # Advisory identity evidence cannot admit a profile or replace the gate.
        probe_directory = ROOT / "experiments/compatibility/runtime-probe"
        sys.path.insert(0, str(probe_directory))
        try:
            from candidate_identity import observe_candidate_identity
            REPORT["runtimeCandidateObservation"] = observe_candidate_identity(run)
        except (ImportError, OSError, RuntimeError, ValueError):
            REPORT["runtimeCandidateObservation"] = {
                "formatVersion": 1, "scope": "runtime-profile-candidate-observation",
                "accepted": False, "custodyVerified": False, "runtimeSupport": "unverified",
                "outcome": "unavailable", "failureCategory": "observer-unavailable"}
        finally:
            sys.path.pop(0)
        # Execute the existing gate without skipping any GC, idle, resource or deadline assertion.
        if RECORDED_HELPERS and recorded_helper_handoff() != REPORT.get('recordedHelperInputs'):
            raise RuntimeError('Original recorded helper input binding changed')
        probe_args, restriction_deadline = restriction_invocation(owned_binding)
        verify_owned_binding(owned_binding, absolute_deadline=restriction_deadline)
        if restriction_deadline is None:
            code, text, _ = run(probe_args, timeout=600, allowed=(0, 1))
        else:
            code, text, _ = run(probe_args, timeout=600, allowed=(0, 1), absolute_deadline=restriction_deadline)
        REPORT["restrictionProbe"] = {"exitCode": code, "result": json.loads(text)}
        if RECORDED_HELPERS:
            proof = REPORT['restrictionProbe']['result']
            owned_control = proof.get('owned_host_control', {})
            context = proof.get('helper_artifact_context', {})
            if (not _recorded_helper_module().accept_helper_origin(proof, True, restriction_deadline)
                    or proof.get('owned_artifact_disposal_scope_verified') is not True
                    or type(owned_control.get('uid')) is not int or owned_control.get('fixtureCustodyValidated') is not True
                    or owned_control.get('hostControlScope') != 'owned-guest' or owned_control.get('runtimeAdmission') is not False
                    or tuple(owned_control.get(field) for field in owned_binding._fields) != tuple(owned_binding)
                    or context.get('state') != 'retained-for-owned-guest-disposal'
                    or context.get('disposal_scope') != 'owned-full-system-guest-filesystem'
                    or context.get('local_disposal') != 'pending' or context.get('cleanup_confirmed') is not False
                    or context.get('retained') is not True or context.get('ledger_verified') is not True):
                raise RuntimeError('Recorded helper origin or owned disposal scope differs')
        if code != 0 or REPORT["restrictionProbe"]["result"].get("cleanup_complete") is not True or REPORT["restrictionProbe"]["result"].get("bounded_probe_passed") is not True:
            REPORT["error"] = {"code": "RESTRICTION_EVIDENCE_REQUIRED", "message": "Actual guest runtime restriction probe did not pass. Inspect restrictionProbe for the observed exit status and bounded result."}
            return
        if debian_candidate:
            verify_owned_binding(owned_binding)
            observation = REPORT['candidateDaemonObservation']
            observation['after'] = observe_debian_candidate_daemon(docker)
            if observation['before'] != observation['after']:
                raise RuntimeError('Candidate daemon identity or tuple changed during verification')
            observation['stable'] = True
        debian_dependency_preservation("afterRuntime", owned_binding)
        debian_dependency_preservation("cleanup", owned_binding)
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


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        REPORT["ok"] = False
        REPORT["error"] = {"code": "GUEST_VERIFICATION_FAILED", "message": str(error)}
    finally:
        print(json.dumps(REPORT, separators=(",", ":")))
        sys.exit(0 if REPORT["ok"] else 3 if REPORT.get("phase") == "new-login-required" and REPORT.get("checkpoint") and "error" not in REPORT else 4)

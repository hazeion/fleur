"""Disposable external OS/command protocol for the real guest command's main.
No production function is replaced. Native account/services/packages never run.
"""
import glob
import contextlib
import io
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import stat
from unittest.mock import patch

source = Path(__file__).resolve().parents[3] / "scripts/fresh-linux-guest.py"
root = Path(sys.argv[1]).resolve()
scenario = sys.argv[2]
nonce = "12345678-1234-1234-1234-123456789abc"
boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
uid = os.getuid() or 1000
lab = root / "lab"
lab.mkdir(mode=0o700)
tools = root / "tools"
tools.mkdir(mode=0o700)
state_path = root / "protocol-state.json"
state_path.write_text(json.dumps({"installed": False, "enrolled": False, "installPrompts": [], "enrollmentPrompts": [], "staleReprobes": 0, "unexpected": [], "uid": uid, "scenario": scenario}))
metadata = {"formatVersion": 1, "internalArtifact": True, "catalogId": "owned-protocol", "catalogSha256": "c" * 64, "installationEvidence": "pending", "runtimeSupport": "unverified", "provenance": {"ordinaryArchiveSha256": "d" * 64, "sourceFilesSha256": "e" * 64, "sourceFiles": []}, "artifacts": [{"name": name, "version": "fixture-version"} for name in ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"]]}
(lab / "package/bin").mkdir(parents=True)
(lab / "package/bin/fleur.ts").write_text("// Owned protocol fixture, never the real runtime\n")
(lab / "package/internal-native-candidate.json").write_text(json.dumps(metadata))
for name in ["fleur-internal-native-candidate.tgz", "runtime-probe.tar", "bun.zip"]:
    (lab / name).write_bytes(("owned fixture " + name).encode())

TOOL = r'''import json,os,pathlib,sys
root=pathlib.Path(os.environ['FIXTURE_ROOT']);p=root/'protocol-state.json';s=json.loads(p.read_text());name=pathlib.Path(sys.argv[0]).name;args=sys.argv[1:];uid=s['uid'];package_checksum='a'*64;enrollment_checksum='b'*64

def save():p.write_text(json.dumps(s))
def envelope(command,data,code,error):
 print(json.dumps({'formatVersion':1,'command':command,'ok':False,'truncated':False,'data':data,'error':{'code':error}}));save();sys.exit(code)
def plan():
 checksum=package_checksum if s['scenario']=='reused-package-plan' else enrollment_checksum
 result={'action':'docker-access','method':'docker-official-apt','privilege':'root-equivalent daemon access','user':{'name':'fleur','uid':uid},'group':{'name':'docker','gid':997},'endpoint':'unix:///var/run/docker.sock','checksum':checksum,'target':'Add fleur to Docker group 997: root-equivalent daemon access; plan '+checksum}
 if s['scenario']=='plan-method':result['method']='arch-official-pacman'
 return result
def ask(action,target,checksum,enrollment=False):
 if enrollment:
  s.setdefault('enrollmentOffers',[]).append({'action':action,'target':target,'checksum':checksum});save()
  if s['scenario']=='prompt-checksum':checksum='f'*64
 print('Authorize '+action+' using docker-official-apt for '+target+'\nPlan '+checksum+"\nType 'once', 'remember', or 'deny': ",end='',flush=True)
 reply=sys.stdin.readline().strip();s['enrollmentPrompts' if enrollment else 'installPrompts'].append({'action':action,'target':target,'checksum':checksum,'reply':reply});save();return reply
if name=='bun':
 if args==['--version']:print('1.4.3');sys.exit(0)
 command=args[1]
 if command=='doctor':
  ready=s['installed'];envelope(command,{'components':{'cli':{'state':'ready' if ready else 'missing'},'daemon':{'state':'denied' if ready else 'missing'},'compose':{'state':'ready' if ready else 'missing'},'smoke':{'state':'missing'},'release':{'state':'unverified'}}},4,'PREREQUISITE_UNAVAILABLE')
 if command!='setup':raise RuntimeError('Unexpected fake CLI command')
 if '--json' in args:
  if not s['installed']:envelope(command,{'plan':{'action':'install','checksum':package_checksum}},3,'AUTHORITY_REQUIRED')
  if not s['enrolled']:envelope(command,{'plan':plan(),'resumable':True},3,'AUTHORITY_REQUIRED')
  if s['scenario']=='stale-replayed-plan':envelope(command,{'plan':plan()},3,'AUTHORITY_REQUIRED')
  s['staleReprobes']+=1;envelope(command,{'access':{'state':'new-login-required'},'resumable':True},3,'HUMAN_ACTION_REQUIRED')
 if not s['installed']:
  for action in ['repository-configuration','install','configuration','docker-access','service-start','service-enable']:
   if ask(action,'Docker fixture package-side-effect plan',package_checksum)!='once':sys.exit(3)
  s['installed']=True;save();print('Exact verified packages are installed; run doctor');sys.exit(4)
 if not s['enrolled']:
  requested=plan()
  if ask(requested['action'],requested['target'],requested['checksum'],True)!='once':sys.exit(3)
  if s['scenario']=='denied-enrollment-outcome':print('Enrollment authority was refused');sys.exit(3)
  s['enrolled']=True;save();print('Enrollment complete. Start a new login.');sys.exit(3)
 print('Start a new login; membership was not repeated');sys.exit(3)
if name=='uname':print('x86_64' if args==['-m'] else 'Linux 6.8.0-fixture x86_64 GNU/Linux');sys.exit(0)
if name=='systemd-detect-virt':print('qemu');sys.exit(0)
if name=='dpkg-query':
 if '--show' not in args:raise RuntimeError('Unexpected package mutation/query')
 print('base-files\tfixture\tii ')
 if s['installed']:
  for package in ['docker-ce','docker-ce-cli','containerd.io','docker-buildx-plugin','docker-compose-plugin']:print(package+'\tfixture-version\tii ')
 sys.exit(0)
if name=='systemctl':
 if not args or args[0]!='show':raise RuntimeError('No direct service mutation in fixture')
 print('LoadState='+('loaded' if s['installed'] else 'not-found')+'\nActiveState='+('active' if s['installed'] else 'inactive')+'\nUnitFileState='+('enabled' if s['installed'] else 'disabled'));sys.exit(0)
if name=='id':
 if args in (['-un'],['--user','--name'],['--name','--user']):print('fleur')
 elif args in (['-u'],['--user']):print(uid)
 elif args and args[0] in ('--groups','-G'):print(str(uid)+' 27'+(' 997' if s['enrolled'] and ('fleur' in args or s.get('freshSession',False)) else ''))
 else:print('uid='+str(uid)+'(fleur) gid='+str(uid)+'(fleur) groups='+str(uid)+'(fleur),27(sudo)')
 sys.exit(0)
if name=='getent':
 if 'passwd' in args:print('fleur:x:'+str(uid)+':'+str(uid)+':Fixture:'+str(root)+':/bin/bash')
 elif 'group' in args:print('docker:x:997:'+('fleur' if s['enrolled'] else ''))
 else:raise RuntimeError('Unexpected directory lookup')
 sys.exit(0)
if name=='stat':print('1|2|socket|0|997|660');sys.exit(0)
if name=='apt-get':
 if '--simulate' not in args:raise RuntimeError('No direct package mutation in fixture')
 print('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.');sys.exit(0)
s['unexpected'].append({'tool':name,'args':args});save();raise RuntimeError('Unknown fixture command')
'''
for name in ["bun", "uname", "systemd-detect-virt", "dpkg-query", "systemctl", "id", "getent", "apt-get", "stat"]:
    target = lab / name if name == "bun" else tools / name
    target.write_text("#!" + sys.executable + " -S\n" + TOOL)
    target.chmod(0o700)

if scenario == "existing-checkpoint":
    (lab / "fresh-linux-state.json").write_text("foreign checkpoint must survive")

original_scandir = os.scandir
original_rglob = Path.rglob
original_lstat = Path.lstat
enumeration = {"distinctValidDirectories": 0, "yielded": 0, "firstDirectoryMetadataAfterYielded": None, "enumerationCompleted": False}

def bounded_directory(path):
    return path.parent == lab / "package" and path.name.startswith("verification-directory-")

if scenario == "directory-bound":
    import time
    started = time.monotonic()
    inodes = set()
    for index in range(5001):
        directory = lab / "package" / ("verification-directory-%05d" % index)
        directory.mkdir(mode=0o700)
        inodes.add(original_lstat(directory).st_ino)
    enumeration["distinctValidDirectories"] = len(inodes)
    enumeration["creationSeconds"] = time.monotonic() - started

yielded_directories = set()

def directory_yielded(path):
    if bounded_directory(path):
        yielded_directories.add(str(path.relative_to(lab / "package")))
        enumeration["yielded"] = len(yielded_directories)

def rglob(path, pattern, *args, **kwargs):
    for entry in original_rglob(path, pattern, *args, **kwargs):
        if scenario == "directory-bound" and path == lab / "package":
            directory_yielded(entry)
        yield entry
    if scenario == "directory-bound" and path == lab / "package":
        enumeration["enumerationCompleted"] = True

def directory_metadata_observed():
    if enumeration["firstDirectoryMetadataAfterYielded"] is None:
        enumeration["firstDirectoryMetadataAfterYielded"] = enumeration["yielded"]

class DirectoryEntry:
    def __init__(self, entry):
        self.entry = entry
    def __getattr__(self, name):
        return getattr(self.entry, name)
    def stat(self, *, follow_symlinks=True):
        directory_metadata_observed()
        return self.entry.stat(follow_symlinks=follow_symlinks)

class Scan:
    def __init__(self, original):
        self.original = original
    def __iter__(self):
        return self
    def __next__(self):
        try:
            entry = next(self.original)
        except StopIteration:
            enumeration["enumerationCompleted"] = True
            raise
        if bounded_directory(Path(entry.path)):
            directory_yielded(Path(entry.path))
            return DirectoryEntry(entry)
        return entry
    def close(self):
        self.original.close()
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.close()

def scandir(path):
    entries = original_scandir(path)
    if scenario == "directory-bound" and isinstance(path, (str, os.PathLike)) and Path(path) == lab / "package":
        return Scan(entries)
    return entries

def lstat(path, *args, **kwargs):
    if scenario == "directory-bound" and bounded_directory(path):
        directory_metadata_observed()
    return original_lstat(path, *args, **kwargs)

original_open = os.open
original_fsync = os.fsync
original_path_open = Path.open
injected = set()

def record_fault(kind):
    injected.add(kind)
    state = json.loads(state_path.read_text())
    state["custodyFaultInjected"] = kind
    state_path.write_text(json.dumps(state))

def source_fault(path):
    if scenario in ("candidate-source-symlink", "candidate-source-mutation") and "candidate" not in injected and isinstance(path, (str, os.PathLike)) and Path(path) == lab / "package/bin/fleur.ts":
        record_fault("candidate")
        entry = lab / "package/bin/fleur.ts"
        original_size = entry.lstat().st_size
        if scenario == "candidate-source-mutation":
            with original_path_open(entry, "r+b") as stream:
                stream.write(b"X" * original_size)
                stream.flush()
        else:
            entry.rename(root / "original-candidate-entry")
            (root / "foreign-source").write_text("foreign source must survive".ljust(original_size, "!"))
            entry.symlink_to(root / "foreign-source")

def path_open(path, *args, **kwargs):
    source_fault(path)
    return original_path_open(path, *args, **kwargs)

def descriptor_open(path, *args, **kwargs):
    source_fault(path)
    fd = original_open(path, *args, **kwargs)
    if scenario == "resume-checkpoint-change" and "resume-checkpoint" not in injected and isinstance(path, (str, os.PathLike)) and Path(path) == lab / "package/bin/fleur.ts" and (lab / "fresh-linux-state.json").exists():
        record_fault("resume-checkpoint")
        with original_path_open(lab / "fresh-linux-state.json", "r+b") as stream:
            body = stream.read()
            stream.seek(0)
            stream.write(b"X" * len(body))
            stream.flush()
    if scenario == "root-replacement" and "root" not in injected and isinstance(path, (str, os.PathLike)) and Path(path) == lab:
        record_fault("root")
        lab.rename(root / "parked-lab")
        lab.mkdir(mode=0o700)
        (lab / "foreign-marker").write_text("foreign root must survive")
    return fd

def fsync(fd):
    value = original_fsync(fd)
    target = lab / "fresh-linux-state.json"
    if scenario == "checkpoint-byte-mutation" and "checkpoint" not in injected and stat.S_ISREG(os.fstat(fd).st_mode) and target.exists() and os.fstat(fd).st_ino == target.lstat().st_ino:
        record_fault("checkpoint")
        with original_path_open(target, "r+b") as stream:
            body = stream.read(2 * 1024 * 1024 + 1)
            stream.seek(0)
            stream.write(b"X" * len(body))
            stream.flush()
    return value

original_read_text = Path.read_text
original_glob = Path.glob
original_popen = __import__("subprocess").Popen
original_glob_glob = glob.glob
known = {"/etc/fleur-owned-guest": nonce + "\n", "/proc/1/comm": "systemd\n", "/etc/os-release": 'ID=ubuntu\nVERSION_ID="24.04"\n', "/proc/sys/kernel/random/boot_id": boot + "\n"}

def read_text(path, *args, **kwargs):
    return known[str(path)] if str(path) in known else original_read_text(path, *args, **kwargs)

def local_glob(path, pattern, *args, **kwargs):
    return iter(()) if str(path) == "/var/lib/apt/lists" else original_glob(path, pattern, *args, **kwargs)

def popen(args, *positional, **kwargs):
    executable = Path(args[0])
    if executable == lab / "bun":
        return original_popen(args, *positional, **kwargs)
    allowed = tools / executable.name
    if allowed.is_file():
        return original_popen([str(allowed), *args[1:]], *positional, **kwargs)
    state = json.loads(state_path.read_text())
    state["unexpected"].append({"tool": str(executable), "args": args[1:]})
    state_path.write_text(json.dumps(state))
    raise RuntimeError("Fixture refused a physical host command")

os.environ.update(HOME=str(root), FIXTURE_ROOT=str(root), PATH=str(tools) + ":/usr/bin:/bin")
sys.argv = [str(source), nonce]
with patch.object(Path, "rglob", rglob), patch.object(os, "scandir", side_effect=scandir), patch.object(Path, "lstat", lstat), patch.object(Path, "open", path_open), patch.object(os, "open", side_effect=descriptor_open), patch.object(os, "fsync", side_effect=fsync), patch.object(Path, "read_text", read_text), patch.object(Path, "glob", local_glob), patch.object(os, "getuid", return_value=uid), patch("glob.glob", side_effect=lambda pattern: [] if pattern.startswith("/etc/apt/") else original_glob_glob(pattern)), patch("subprocess.Popen", side_effect=popen):
    try:
        if scenario in ("fresh-resume", "resume-stale-session", "resume-wrong-digest", "resume-replay", "resume-checkpoint-change"):
            first_output = io.StringIO()
            with contextlib.redirect_stdout(first_output):
                try:
                    runpy.run_path(str(source), run_name="__main__")
                except SystemExit as first_exit:
                    if first_exit.code != 3:
                        raise RuntimeError("Fixture initial workflow did not reach its genuine handoff")
            initial = json.loads(first_output.getvalue())
            (root / "first-session-report.json").write_text(json.dumps(initial))
            state = json.loads(state_path.read_text())
            state["freshSession"] = scenario != "resume-stale-session"
            state_path.write_text(json.dumps(state))
            sys.argv = [str(source), nonce, "--resume", "0" * 64 if scenario == "resume-wrong-digest" else initial["checkpoint"]["sha256"]]
            if scenario == "resume-replay":
                with contextlib.redirect_stdout(io.StringIO()):
                    try:
                        runpy.run_path(str(source), run_name="__main__")
                    except SystemExit as resume_exit:
                        if resume_exit.code != 4 or not (lab / "fresh-linux-resume-started.json").is_file():
                            raise RuntimeError("Fixture first resume did not claim its once-only boundary")
        runpy.run_path(str(source), run_name="__main__")
    finally:
        if scenario == "directory-bound":
            (root / "enumeration-witness.json").write_text(json.dumps(enumeration))

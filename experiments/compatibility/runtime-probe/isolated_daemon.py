"""Owned VFS counterfactual daemon; never a fallback for the required gate."""
from contextlib import contextmanager
import json
import inspect
import shlex
import math
import os
from pathlib import Path
import platform
import re
import tarfile
import stat
import subprocess
import tempfile
import time
import uuid
import weakref
import owned_mounts

CLEANUP_FAILURE_STAGES = (
    'stop-request', 'supervisor-wait', 'natural-drain', 'forced-retirement',
    'forced-reap', 'normal-proof', 'default-daemon', 'root-removal', 'deadline',
)

def owned_mount_count(contents, root):
    """Count kernel mount points only in the exact fresh data/exec trees."""
    if type(contents) is not str or len(contents.encode('utf-8'))>1048576:
        raise ValueError('owned mount input invalid')
    prefixes=(str(root/'data'),str(root/'exec'))
    count=0
    for line in contents.splitlines():
        fields=line.split()
        if len(fields)<10 or '-' not in fields:
            raise ValueError('owned mount row invalid')
        point=fields[4]
        for escaped,actual in ((r'\040',' '),(r'\011','\t'),(r'\012','\n'),(r'\134','\\')):
            point=point.replace(escaped,actual)
        if any(point==prefix or point.startswith(prefix+'/') for prefix in prefixes):
            count+=1
    return count


MOUNT_COUNT_CODE = 'from pathlib import Path; import sys\n'+inspect.getsource(owned_mount_count)+"\nwith open('/proc/self/mountinfo','r') as stream: data=stream.read(1048577)\nprint(owned_mount_count(data,Path(sys.argv[1])))\n"


MOUNT_PROGRAM = inspect.getsource(owned_mounts) + "\nif sys.argv[1]=='capture': sys.exit(capture_cli(Path(sys.argv[2]),sys.argv[3],json.loads(sys.argv[4])))\nelif sys.argv[1]=='retire': print(retire(Path(sys.argv[2]),sys.argv[3],json.loads(sys.argv[4])))\nelif sys.argv[1]=='remove': remove_roots(Path(sys.argv[2]),sys.argv[3],json.loads(sys.argv[4]),attempt=int(sys.argv[5]))\n"
ROOT_CAPTURE_COMMAND = '/usr/bin/python3 -I -c '+shlex.quote(MOUNT_PROGRAM)+' capture "$base" "$token" "$expected_root"'
MOUNT_RETIRE_COMMAND = '/usr/bin/python3 -I -c '+shlex.quote(MOUNT_PROGRAM)+' retire "$base" "$token" "$mount_snapshot"'
ROOT_REMOVE_COMMAND = '/usr/bin/python3 -I -c '+shlex.quote(MOUNT_PROGRAM)+' remove "$base" "$token" "$mount_snapshot" "${removal_attempt:-1}"'


ROOT_BODY = r'''set -eu
expected_root=$1; base=$2; token=$3; group=$4
case "$token" in fleur-vfs-????????????????????????????????) ;; *) exit 2 ;; esac
[ -d "$base" ] && [ ! -L "$base" ] && [ "$(cat "$base/owner")" = "$token" ] || exit 2
printf '%s' "$PPID" > "$base/supervisor.pid"
mount_snapshot=$(ROOT_CAPTURE_COMMAND_PLACEHOLDER) || exit 2
child=
clean=false
clock_ms() {
    # Linux boot clock avoids spawning another CLI for every budget check.
    IFS=' ' read -r uptime ignored < /proc/uptime || return 1
    seconds=${uptime%.*}; hundredths=${uptime#*.}
    printf '%s\n' "$((seconds*1000+(1$hundredths-100)*10))"
}
ctr_owned() {
    now=$(clock_ms) || return 124
    if [ -z "${retirement_deadline:-}" ]; then retirement_deadline=$((now+${retirement_window_ms:-10000})); fi
    remaining=$((retirement_deadline-now-250))
    [ "$remaining" -gt 0 ] || return 124
    span=$(printf '%s.%03ds' "$((remaining/1000))" "$((remaining%1000))")
    /usr/bin/timeout --signal=TERM --kill-after=.2s "$span" \
      /usr/bin/env CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS=true /usr/bin/ctr "$@"
}
namespace_empty() {
    scope=0
    for namespace in "$token" "$token-plugins"; do
        scope=$((scope+1)); rc=0; command_start=$(date +%s%N)
        ctr_owned --address /run/containerd/containerd.sock \
          --namespace "$namespace" tasks list --quiet > "$base/tasks.tmp" 2>/dev/null || rc=$?
        number=$(wc -l < "$base/tasks.tmp")
        diag 5 "$scope" "$rc" "$number"
        [ "$rc" = 0 ] && [ ! -s "$base/tasks.tmp" ] || return 1
    done
    # Task absence alone cannot prove a detached/new-session shim retired.
    # Inspect only shim-class processes and suppress every argument/path.
    for comm_file in /proc/[0-9]*/comm; do
        [ -f "$comm_file" ] || continue
        IFS= read -r name < "$comm_file" || continue
        case "$name" in containerd-shim*) ;; *) continue ;; esac
        cmdline=${comm_file%/comm}/cmdline
        if tr '\000' '\n' < "$cmdline" > "$base/shim.tmp" 2>/dev/null; then
            if grep -F -x -- "$token" "$base/shim.tmp" >/dev/null || \
               grep -F -x -- "$token-plugins" "$base/shim.tmp" >/dev/null; then diag 7 0 0 1; return 1; fi
        elif [ -e "$cmdline" ]; then diag 8 0 1 1; return 1; fi
    done
    diag 9 0 0 0
}
diag() {
    printf '%s %s %s %s\n' "$1" "$2" "$3" "$4" >> "$base/retirement.facts"
    case "$1" in 1|3|4|5)
        end=$(date +%s%N)
        case "$end${command_start:-}" in ''|*[!0-9]*) return 0 ;; esac
        elapsed=$(((end-command_start)/1000000))
        printf '%s %s %s\n' "$1" "$2" "$elapsed" >> "$base/retirement.times" ;;
    esac
}
retire_namespaces() {
    scope=0
    for namespace in "$token" "$token-plugins"; do
        scope=$((scope+1)); rc=0; command_start=$(date +%s%N)
        ctr_owned --address /run/containerd/containerd.sock \
          --namespace "$namespace" tasks list --quiet > "$base/tasks.tmp" 2>/dev/null || rc=$?
        number=$(wc -l < "$base/tasks.tmp")
        diag 1 "$scope" "$rc" "$number"
        [ "$rc" = 0 ] || continue
        set --
        while IFS= read -r id; do
            case "$id" in ''|*[!0-9a-f]*) return 1 ;; esac
            [ "${#id}" -eq 64 ] && [ "$#" -lt 64 ] || return 1
            set -- "$@" "$id"
        done < "$base/tasks.tmp"
        diag 2 "$scope" 0 "$#"
        for id in "$@"; do
            rc=0; command_start=$(date +%s%N)
            ctr_owned --address /run/containerd/containerd.sock \
              --namespace "$namespace" tasks kill --all --signal SIGKILL "$id" >/dev/null 2>&1 || rc=$?
            diag 3 "$scope" "$rc" 1
        done
        if [ "$#" -gt 0 ]; then
            rc=0; command_start=$(date +%s%N)
            ctr_owned --address /run/containerd/containerd.sock \
              --namespace "$namespace" tasks delete --force "$@" >/dev/null 2>&1 || rc=$?
            diag 4 "$scope" "$rc" "$#"
        fi
    done
    namespace_empty
}
cleanup() {
    [ "$clean" = false ] || return
    clean=true
    if [ -n "$child" ]; then
        if kill -0 "$child" 2>/dev/null; then
            IFS= read -r comm < "/proc/$child/comm" || return 1
            # $! is our directly launched child. PPid also admits its brief
            # pre-exec sh state on early parent EOF, without trusting a PIDfile.
            record=$(cat "/proc/$child/stat") || return 1
            rest=${record##*) }; set -- $rest
            [ "$2" = "$$" ] || return 1
            case "$comm" in dockerd|sh) ;; *) return 1 ;; esac
            kill -TERM "$child" 2>/dev/null || true
            count=0
            while kill -0 "$child" 2>/dev/null && [ "$count" -lt 30 ]; do
                sleep .2; count=$((count+1))
            done
            if kill -0 "$child" 2>/dev/null; then
                kill -KILL "$child"
                wait "$child" 2>/dev/null || true
                # Attempt exact namespace retirement; never infer proof from group death.
                retire_namespaces || true
                return 1
            fi
        fi
        wait "$child" 2>/dev/null || return 1
    fi
    namespace_empty || return 1
    ROOT_REMOVE_COMMAND_PLACEHOLDER
    printf 'stopped\n'
}
trap 'cleanup' EXIT
trap 'exit 124' TERM INT
/usr/bin/dockerd --config-file "$base/config.json" --data-root "$base/data" \
 --exec-root "$base/exec" --pidfile "$base/docker.pid" --host "unix://$base/docker.sock" \
 --group "$group" --storage-driver vfs --bridge none --iptables=false --ip6tables=false \
 --ip-forward=false --ip-masq=false --userland-proxy=false \
 --containerd /run/containerd/containerd.sock --containerd-namespace "$token" --containerd-plugins-namespace "$token-plugins" \
 --label "fleur.compatibility.vfs-owner=$token" >"$base/daemon.log" 2>&1 &
child=$!
IFS= read -r command || true
[ "${command:-}" = stop ] || exit 124
'''


ROOT_BODY = ROOT_BODY.replace('ROOT_CAPTURE_COMMAND_PLACEHOLDER',ROOT_CAPTURE_COMMAND).replace('ROOT_REMOVE_COMMAND_PLACEHOLDER',ROOT_REMOVE_COMMAND)


# Exact same namespace routines for the outer forced-group fallback. Raw task
# identifiers stay in the owned directory and never cross diagnostics output.
RETIRE_BODY = r'''set -eu
LC_ALL=C; export LC_ALL
base=$1; token=$2; retirement_window_ms=${3:-10000}; mount_snapshot=${4:-}
removal_attempt=2
daemon=${5:-}; daemon_started=${6:-}
case "$daemon:$daemon_started" in *[!0-9:]*|:*|*:) exit 2 ;; esac
[ "$daemon" -gt 1 ] && [ "$daemon_started" -gt 0 ] || exit 2
case "$token" in fleur-vfs-????????????????????????????????) ;; *) exit 2 ;; esac
suffix=${token#fleur-vfs-}
case "$suffix" in *[!0-9a-f]*) exit 2 ;; esac
[ -d "$base" ] && [ ! -L "$base" ] && [ "$(cat "$base/owner")" = "$token" ] || exit 2
''' + ROOT_BODY[ROOT_BODY.index('clock_ms()'):ROOT_BODY.index('cleanup()')] + r'''
retire_namespaces
diag 10 0 0 0
if [ -e "/proc/$daemon/stat" ]; then
    record=$(cat "/proc/$daemon/stat") || exit 2
    rest=${record##*) }; set -- $rest
    [ "$#" -ge 20 ] || exit 2
    state=$1; shift 19
    [ "$1" = "$daemon_started" ] || { diag 11 0 0 2; exit 3; }
    if [ "$state" != Z ]; then diag 11 0 0 1; exit 3; fi
fi
diag 11 0 0 0
mounts=0; mount_rc=0
if mounts=$(MOUNT_RETIRE_COMMAND_PLACEHOLDER 2>/dev/null); then :; else mount_rc=$?; mounts=0; fi
diag 13 0 "$mount_rc" "$mounts"
[ "$mount_rc" = 0 ] || exit "$mount_rc"
remove_rc=0
ROOT_REMOVE_COMMAND_PLACEHOLDER 2>"$base/removal.stderr" || remove_rc=$?
diag 14 0 "$remove_rc" "$mounts"
busy=0
if grep -F -- 'Device or resource busy' "$base/removal.stderr" >/dev/null; then busy=1; fi
diag 15 0 "$remove_rc" "$busy"
[ "$remove_rc" = 0 ] || exit "$remove_rc"
diag 12 0 0 0
printf 'retired\n'
'''


RETIRE_BODY = RETIRE_BODY.replace('MOUNT_RETIRE_COMMAND_PLACEHOLDER',MOUNT_RETIRE_COMMAND).replace('ROOT_REMOVE_COMMAND_PLACEHOLDER',ROOT_REMOVE_COMMAND)

def eligible_host():
    expected = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                'RUNNER_OS': 'Linux', 'GITHUB_REPOSITORY': 'hazeion/fleur',
                'GITHUB_WORKFLOW': 'Compatibility experiments',
                'GITHUB_JOB': 'runtime-vfs-counterfactual'}
    return platform.system() == 'Linux' and all(os.environ.get(k) == v for k, v in expected.items())


class IsolatedDaemonError(RuntimeError):
    def __init__(self, message, observations=None):
        self.observations = dict(observations or {})
        suffix = ' '+json.dumps(self.observations,sort_keys=True) if self.observations else ''
        super().__init__(message+suffix)


class DefaultDaemonUnavailable(IsolatedDaemonError):
    """The default daemon CLI exited nonzero: not yet ready, retried only by the readiness wait."""


class Endpoint:
    def __init__(self, root, token, deadline):
        self.root, self.token, self.deadline = root, token, deadline
        self._root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        self._close_root=weakref.finalize(self,os.close,self._root_fd)
        record=os.fstat(self._root_fd)
        self.root_identity=(record.st_dev,record.st_ino,record.st_uid)
        self.cleanup_verified = False
        self.cleanup_observations = {}
        self.forced_probe_verified = False
        self.daemon_identity = None
        self.facts = {}
        self.environment = dict(os.environ)
        for key in ('DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION'):
            self.environment.pop(key, None)
        self.environment['DOCKER_HOST'] = 'unix://' + str(root / 'docker.sock')

    def verify_root(self):
        """The current name must still designate the retained original directory."""
        try:
            current=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:
                record=os.fstat(current)
                if (record.st_dev,record.st_ino,record.st_uid)!=self.root_identity:
                    raise IsolatedDaemonError('initial owned root changed')
            finally:os.close(current)
        except OSError:
            raise IsolatedDaemonError('initial owned root unavailable') from None

    def remove_root(self):
        """Remove top-level artifacts through the original, still-open root."""
        self.verify_root()
        names=os.listdir(self._root_fd)
        # data/exec were already removed under the privileged zero-mount fence.
        # Only top-level artifacts may remain. Never recurse into an unexpected
        # directory, including a mounted one; unlinking a mounted file fails busy.
        if any(stat.S_ISDIR(os.stat(name,dir_fd=self._root_fd,follow_symlinks=False).st_mode) for name in names):
            raise IsolatedDaemonError('unexpected staging directory remains')
        for name in names:os.unlink(name,dir_fd=self._root_fd)
        self.verify_root()
        os.rmdir(self.root)
        if os.fstat(self._root_fd).st_nlink!=0:
            raise IsolatedDaemonError('original root removal unverified')

    def close(self):
        self._close_root()

    def remaining_seconds(self):
        return max(0, self.deadline - time.monotonic())

    def command(self, args, timeout=5):
        remaining = self.remaining_seconds()
        if remaining <= 0:
            raise IsolatedDaemonError('owned daemon budget expired')
        return subprocess.run(['docker', *args], env=self.environment,
                              stdin=subprocess.DEVNULL, capture_output=True,
                              timeout=min(timeout, remaining), check=False)

    def verify(self):
        pid = int((self.root / 'docker.pid').read_text())
        if pid <= 1 or Path('/proc/' + str(pid) + '/comm').read_text().strip() != 'dockerd':
            raise IsolatedDaemonError('owned daemon identity invalid')
        def process_identity():
            proc=Path('/proc/'+str(pid))
            record=(proc/'stat').read_text().rpartition(') ')[2].split()
            if proc.stat().st_uid!=0 or len(record)<20 or not record[19].isdigit() or int(record[19])<=0:
                raise IsolatedDaemonError('owned daemon process identity invalid')
            return pid,int(record[19])
        identity=process_identity()
        args = Path('/proc/' + str(pid) + '/cmdline').read_bytes().split(b'\0')
        for flag, value in (('--data-root', str(self.root/'data')), ('--exec-root', str(self.root/'exec')),
                            ('--pidfile', str(self.root/'docker.pid')), ('--config-file', str(self.root/'config.json')),
                            ('--host', self.environment['DOCKER_HOST']), ('--storage-driver', 'vfs'),
                            ('--containerd', '/run/containerd/containerd.sock'),
                            ('--containerd-namespace', self.token), ('--containerd-plugins-namespace', self.token+'-plugins')):
            encoded = flag.encode()
            if args.count(encoded) != 1 or args[args.index(encoded)+1] != value.encode():
                raise IsolatedDaemonError('owned daemon configuration invalid')
        socket = (self.root/'docker.sock').lstat()
        if not stat.S_ISSOCK(socket.st_mode) or socket.st_uid != 0 or socket.st_gid != os.getgid():
            raise IsolatedDaemonError('owned socket identity invalid')
        result = self.command(['info', '--format', '{{json .}}'])
        if result.returncode or len(result.stdout) > 65536:
            raise IsolatedDaemonError('owned daemon inspection failed')
        info = json.loads(result.stdout)
        version = self.command(['version', '--format', '{{.Server.Version}}'])
        if (version.returncode or version.stdout != b'28.0.4\n' or info.get('Driver') != 'vfs'
                or info.get('DockerRootDir') != str(self.root/'data')
                or 'fleur.compatibility.vfs-owner='+self.token not in info.get('Labels', [])
                or info.get('Containers') != 0):
            raise IsolatedDaemonError('owned VFS prerequisite invalid')
        if process_identity()!=identity:raise IsolatedDaemonError('owned daemon process identity changed')
        self.daemon_identity=identity
        self.facts = {'driver': 'vfs', 'server_version': '28.0.4', 'owned': True,
                      'socket_verified': True, 'data_root_verified': True,
                      'exec_root_verified': True, 'namespace_verified': True,
                      'pid_verified': True, 'config_verified': True}


def retirement_observations(root, returncode, stdout):
    facts = {'cli_returncode':returncode, 'stdout_bytes':len(stdout), 'journal_invalid':False}
    facts['removal_progress'] = []
    facts['removal_progress_invalid'] = False
    found_progress = False
    for attempt in (1, 2):
        descriptor = None
        try:
            descriptor = os.open(root/f'removal-progress-{attempt}.facts', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            found_progress = True
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_nlink != 1
                    or before.st_mode & 0o0777 != 0o644 or before.st_size > 16384):
                raise ValueError('removal progress custody')
            raw = os.read(descriptor, 16385)
            after = os.fstat(descriptor)
            identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid,
                                      value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            if identity(before) != identity(after) or len(raw) != before.st_size:
                raise ValueError('removal progress changed')
            facts['removal_progress'].extend(owned_mounts.parse_removal_progress(raw, attempt))
        except FileNotFoundError:
            pass
        except (OSError, ValueError, UnicodeError):
            facts['removal_progress_invalid'] = True
        finally:
            if descriptor is not None: os.close(descriptor)
    facts['removal_progress_missing'] = not found_progress
    try:
        with (root/'retirement.facts').open('rb') as stream:
            raw=stream.read(8193)
        if len(raw)>8192:
            raise ValueError('journal bound')
        facts['journal_bytes']=len(raw)
        rows=[]
        for line in raw.decode('ascii').splitlines():
            fields=line.split()
            if len(fields)!=4 or any(re.fullmatch(r'-?[0-9]{1,3}',field) is None for field in fields):
                raise ValueError('journal fields')
            stage,namespace,status,count=map(int,fields)
            if not 1<=stage<=15 or not 0<=namespace<=2 or not -255<=status<=255 or not 0<=count<=64 or len(rows)>=192:
                raise ValueError('journal values')
            rows.append((stage,namespace,status,count))
        facts['journal_rows']=len(rows)
        facts['stages']=[list(row) for row in rows]
        if rows:
            facts.update(zip(('last_stage','last_namespace','last_command_returncode','last_count'),rows[-1]))
    except FileNotFoundError:
        facts['journal_missing']=True
    except (OSError,ValueError,UnicodeError):
        facts['journal_invalid']=True
    try:
        with (root/'retirement.times').open('rb') as stream:
            raw=stream.read(8193)
        if len(raw)>8192:
            raise ValueError('timing bound')
        timings=[]
        for line in raw.decode('ascii').splitlines():
            fields=line.split()
            if len(fields)!=3 or any(re.fullmatch(r'[0-9]{1,5}',value) is None for value in fields):
                raise ValueError('timing fields')
            stage,namespace,elapsed=map(int,fields)
            if stage not in (1,3,4,5) or namespace not in (1,2) or not 0<=elapsed<=10000 or len(timings)>=192:
                raise ValueError('timing values')
            timings.append([stage,namespace,elapsed])
        facts['command_elapsed_ms']=timings
    except FileNotFoundError:
        facts['timings_missing']=True
    except (OSError,ValueError,UnicodeError):
        facts['timings_invalid']=True
    return facts


def capture_observations(result,elapsed_ms):
    """Allow only the fixed child diagnostic schema across the report boundary."""
    facts={'cli_returncode':result.returncode,'elapsed_ms':elapsed_ms,
           'stdout_bytes':len(result.stdout or b''),'stderr_bytes':len(result.stderr or b'')}
    if not result.stdout:return facts
    try:
        if len(result.stdout)>2048:raise ValueError('diagnostic bound')
        envelope=json.loads(result.stdout)
        if type(envelope) is not dict or set(envelope)!={'capture_error'}:raise ValueError('envelope')
        error=envelope['capture_error']
        if (type(error) is not dict or not {'phase','category'}<=set(error)
                or set(error)-{'phase','category','errno','layout','layout_invalid'}
                or error['phase'] not in owned_mounts.CAPTURE_PHASES
                or error['category'] not in owned_mounts.CAPTURE_CATEGORIES):raise ValueError('diagnostic')
        if 'errno' in error and (type(error['errno']) is not int or not 0<=error['errno']<=4095):raise ValueError('errno')
        if 'layout_invalid' in error and type(error['layout_invalid']) is not bool:raise ValueError('layout marker')
        if 'layout' in error:
            layout=error['layout']
            if (type(layout) is not dict or set(layout)!=set(owned_mounts.LAYOUT_COUNTS)
                    or any(type(count) is not int or not 0<=count<=65 for count in layout.values())):
                raise ValueError('layout')
        facts['capture_error']=error
    except (ValueError,TypeError,UnicodeError):facts['diagnostic_invalid']=True
    return facts


def _retire_supervisor(endpoint, budget):
    """Escalate only the verified fresh root timeout process group."""
    if type(budget) not in (int,float) or not math.isfinite(budget) or budget<=0:
        raise IsolatedDaemonError('owned retirement budget invalid')
    deadline=time.monotonic()+min(10,budget)
    endpoint.verify_root()
    pid = int((endpoint.root/'supervisor.pid').read_text())
    if pid <= 1 or Path('/proc/'+str(pid)+'/comm').read_text().strip() != 'timeout':
        raise IsolatedDaemonError('owned supervisor identity unavailable')
    record = Path('/proc/'+str(pid)+'/stat').read_text().rpartition(') ')[2].split()
    arguments = Path('/proc/'+str(pid)+'/cmdline').read_bytes().split(b'\0')
    if int(record[2]) != pid or str(endpoint.root).encode() not in arguments or endpoint.token.encode() not in arguments:
        raise IsolatedDaemonError('owned supervisor group invalid')
    capture_window=deadline-time.monotonic()-.3
    if capture_window<=0:
        raise IsolatedDaemonError('owned retirement budget expired')
    capture_started=time.monotonic()
    try:
        captured=subprocess.run(['sudo','-n','/usr/bin/timeout','--signal=TERM','--kill-after=.2s',
                      format(capture_window,'.3f')+'s','/usr/bin/python3','-I','-c',MOUNT_PROGRAM,
                      'capture',str(endpoint.root),endpoint.token,json.dumps(endpoint.root_identity)],stdin=subprocess.DEVNULL,
                      stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                      timeout=max(.001,deadline-time.monotonic()),check=False)
    except subprocess.TimeoutExpired as error:
        failed=subprocess.CompletedProcess([],124,error.stdout or b'',error.stderr or b'')
        observations=capture_observations(failed,int((time.monotonic()-capture_started)*1000))
        observations['parent_timeout']=True
        endpoint.capture_facts=observations
        raise IsolatedDaemonError('owned mount capture timeout',observations) from None
    if captured.returncode or len(captured.stdout)>65536:
        observations=capture_observations(captured,int((time.monotonic()-capture_started)*1000))
        endpoint.capture_facts=observations
        raise IsolatedDaemonError('owned mount capture failed',observations)
    try:
        mount_snapshot=json.loads(captured.stdout)
        if (type(mount_snapshot) is not dict or set(mount_snapshot)!={'root','mounts'}
                or mount_snapshot['root']!=list(endpoint.root_identity)):
            raise ValueError('capture shape')
    except (ValueError,UnicodeError):
        observations=capture_observations(captured,int((time.monotonic()-capture_started)*1000))
        endpoint.capture_facts=observations
        raise IsolatedDaemonError('owned mount capture invalid',observations) from None
    endpoint.verify_root()
    identity=endpoint.daemon_identity
    if (type(identity) is not tuple or len(identity)!=2 or any(type(value) is not int for value in identity)
            or not 1<identity[0]<=2**31-1 or identity[1]<=0):
        raise IsolatedDaemonError('retained owned daemon identity unavailable')
    result = subprocess.run(['sudo','-n','/bin/kill','-KILL','--','-'+str(pid)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=max(.001,min(1,deadline-time.monotonic())), check=False)
    if result.returncode:
        raise IsolatedDaemonError('owned supervisor escalation failed')
    # Shared containerd can own detached shims outside the killed process group.
    window=math.floor((deadline-time.monotonic()-.3)*1000)/1000
    if window<=0:
        raise IsolatedDaemonError('owned retirement budget expired')
    retirement = subprocess.run(['sudo','-n','/usr/bin/timeout','--signal=TERM','--kill-after=.2s',format(window,'.3f')+'s',
                    '/bin/sh','-c',RETIRE_BODY,'fleur-owned-retire',str(endpoint.root),endpoint.token,
                    str(math.floor(window*1000)),json.dumps(mount_snapshot,separators=(',',':')),str(identity[0]),str(identity[1])],
                   stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                   timeout=max(.001,deadline-time.monotonic()),check=False)
    endpoint.retirement_facts = retirement_observations(endpoint.root,retirement.returncode,retirement.stdout)
    return (time.monotonic() < deadline and retirement.returncode == 0
            and retirement.stdout == b'retired\n')


def _default_identity(timeout=5):
    environment = dict(os.environ)
    for key in ('DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION'):
        environment.pop(key, None)
    template = '{"ID":{{json .ID}},"Driver":{{json .Driver}},"DockerRootDir":{{json .DockerRootDir}}}'
    result = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', 'info', '--format', template],
                            env=environment, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        raise DefaultDaemonUnavailable('default daemon identity unavailable')
    if len(result.stdout) > 4096:
        raise IsolatedDaemonError('default daemon identity unavailable')
    identity = json.loads(result.stdout)
    if (type(identity) is not dict or set(identity) != {'ID', 'Driver', 'DockerRootDir'}
            or any(type(value) is not str or not value for value in identity.values())):
        raise IsolatedDaemonError('default daemon identity invalid')
    return identity


# Hosted runners can answer `docker version` while the first `docker info` still
# stalls for several seconds. The baseline read is a readiness wait, not a latency
# requirement: retry under one explicit deadline and fail closed when it expires.
DEFAULT_DAEMON_READY_SECONDS = 30
DEFAULT_DAEMON_ATTEMPT_SECONDS = 5


def wait_for_default_daemon(window, attempt_timeout, interval=.5):
    """Return the default daemon identity once it answers, or fail at the window deadline."""
    if not 0 < attempt_timeout <= window or interval <= 0:
        raise ValueError('default daemon readiness bounds invalid')
    deadline = time.monotonic()+window
    attempts = {'attempts': 0, 'timeouts': 0, 'refusals': 0}
    while True:
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            break
        attempts['attempts'] += 1
        try:
            return _default_identity(timeout=min(attempt_timeout, remaining))
        except subprocess.TimeoutExpired:
            attempts['timeouts'] += 1
        except DefaultDaemonUnavailable:
            attempts['refusals'] += 1
        time.sleep(max(0, min(interval, deadline-time.monotonic())))
    raise IsolatedDaemonError(f'default daemon not ready within {window:g}s readiness deadline',
                              attempts)


@contextmanager
def isolated_vfs_daemon(lifetime=540):
    if not eligible_host() or type(lifetime) is not int or not 45 <= lifetime <= 540:
        raise IsolatedDaemonError('counterfactual host or lifetime invalid')
    parent = Path(os.environ.get('RUNNER_TEMP', ''))
    if not parent.is_absolute() or not parent.is_dir() or parent.is_symlink():
        raise IsolatedDaemonError('counterfactual temporary root invalid')
    baseline = wait_for_default_daemon(DEFAULT_DAEMON_READY_SECONDS, DEFAULT_DAEMON_ATTEMPT_SECONDS)
    root = Path(tempfile.mkdtemp(prefix='fleur-vfs-', dir=parent))
    token = 'fleur-vfs-' + uuid.uuid4().hex
    (root/'owner').write_text(token)
    (root/'config.json').write_text(json.dumps({'features': {'containerd-snapshotter': False}}))
    endpoint = Endpoint(root, token, time.monotonic()+lifetime)
    process = None
    error = None
    try:
        process = subprocess.Popen(['sudo', '-n', '/usr/bin/timeout', '--signal=TERM', '--kill-after=15s',
                                    str(lifetime-15)+'s', '/bin/sh', '-c', ROOT_BODY,
                                    'fleur-owned-vfs', json.dumps(endpoint.root_identity), str(root), token, str(os.getgid())],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'})
        startup = min(time.monotonic()+30, endpoint.deadline-15)
        while time.monotonic() < startup:
            if process.poll() is not None:
                raise IsolatedDaemonError('owned supervisor startup failed')
            if (root/'docker.pid').is_file() and (root/'docker.sock').exists():
                try:
                    endpoint.verify()
                    break
                except (OSError, ValueError, subprocess.SubprocessError, IsolatedDaemonError):
                    pass
            time.sleep(.1)
        else:
            raise IsolatedDaemonError('owned daemon startup deadline')
        yield endpoint
    except BaseException as exc:
        error = exc
        raise
    finally:
        cleanup_error = None
        cleanup_deadline = min(endpoint.deadline, time.monotonic()+15)
        empty = False
        output = b''
        observations=endpoint.cleanup_observations
        observations['empty_inspection']='unavailable'
        retirement_stage='stop-request'
        try:
            if endpoint.facts:
                try:
                    inspection_started=time.monotonic()
                    result = endpoint.command(['ps', '--all', '--quiet'], timeout=1)
                    empty = result.returncode == 0 and result.stdout == b''
                    observations.update(empty_inspection='empty' if empty else 'nonempty' if result.returncode==0 else 'failed',
                        empty_inspection_returncode=result.returncode,empty_inspection_stdout_bytes=len(result.stdout))
                except (OSError, ValueError, subprocess.SubprocessError, IsolatedDaemonError) as inspection_error:
                    observations['empty_inspection']='timeout' if isinstance(inspection_error,subprocess.TimeoutExpired) else 'failed'
                finally:observations['empty_inspection_ms']=round(1000*(time.monotonic()-inspection_started))
            # Inspection can never skip the independently owned stop/reap path.
            if process is not None:
                if process.poll() is None:
                    try:
                        process.stdin.write(b'stop\n'); process.stdin.flush(); process.stdin.close(); process.stdin = None
                    except (BrokenPipeError, OSError):
                        pass
                retirement_stage='supervisor-wait'
                try:
                    output, _ = process.communicate(timeout=max(.1, cleanup_deadline-time.monotonic()-5))
                except subprocess.TimeoutExpired:
                    def collect_natural_completion():
                        nonlocal retirement_stage
                        retirement_stage='natural-drain'
                        remaining=cleanup_deadline-time.monotonic()
                        if remaining<=0:raise IsolatedDaemonError('owned retirement budget expired')
                        observations['natural_completion_after_timeout']=True
                        # Reap and drain the original Popen, not a numeric PID.
                        # Exit alone cannot establish the exact normal receipt.
                        return process.communicate(timeout=min(2,remaining))[0]
                    if process.poll() is not None:
                        output=collect_natural_completion()
                    else:
                        try:
                            retirement_stage='forced-retirement'
                            independently_retired=_retire_supervisor(endpoint, cleanup_deadline-time.monotonic())
                        except (OSError, subprocess.SubprocessError, ValueError, IsolatedDaemonError):
                            # The original supervisor can finish between poll and
                            # the helper's identity check. Never signal a retired PID.
                            if process.poll() is None:raise
                            output=collect_natural_completion()
                        else:
                            retirement_stage='forced-reap'
                            process.wait(timeout=max(.1,min(2,cleanup_deadline-time.monotonic()-2)))
                            # Group death alone is insufficient: forced retirement
                            # still requires independent task/shim/mount/root proof.
                            if not independently_retired:raise IsolatedDaemonError('owned daemon forced retirement')
                            endpoint.forced_probe_verified=True
                retirement_stage='normal-proof'
                observations.update(daemon_returncode=process.returncode,daemon_stdout_bytes=len(output),
                    owned_process_reaped=process.poll() is not None)
                if not endpoint.forced_probe_verified:
                    endpoint.retirement_facts=retirement_observations(root,process.returncode,output)
                retired = endpoint.forced_probe_verified or (empty and process.returncode == 0 and output == b'stopped\n')
                endpoint.cleanup_verified = (retired and process.poll() is not None
                                              and not (root/'data').exists() and not (root/'exec').exists()
                                              and not (root/'docker.pid').exists() and not (root/'docker.sock').exists())
                if not endpoint.cleanup_verified:
                    observations['cleanup_failure_stage']=retirement_stage
        except (OSError, subprocess.SubprocessError, ValueError, IsolatedDaemonError) as retirement_error:
            observations['cleanup_failure_stage']=retirement_stage
            observations['cleanup_exception']='timeout' if isinstance(retirement_error,subprocess.TimeoutExpired) else 'unverified'
            endpoint.cleanup_verified = False
        finally:
            try:
                budget = cleanup_deadline-time.monotonic()
                unchanged = budget > 0 and _default_identity(timeout=min(2,budget)) == baseline
            except (OSError, ValueError, subprocess.SubprocessError, IsolatedDaemonError):
                unchanged = False
            observations.update(data_root_removed=not (root/'data').exists(),exec_root_removed=not (root/'exec').exists(),
                daemon_pidfile_removed=not (root/'docker.pid').exists(),daemon_socket_removed=not (root/'docker.sock').exists(),
                cleanup_deadline_exceeded=time.monotonic()>=cleanup_deadline)
            if not unchanged:observations.setdefault('cleanup_failure_stage','default-daemon')
            if observations['cleanup_deadline_exceeded']:observations.setdefault('cleanup_failure_stage','deadline')
            endpoint.facts['default_daemon_unchanged'] = unchanged
            endpoint.cleanup_verified = endpoint.cleanup_verified and unchanged and time.monotonic() < cleanup_deadline
            if process is not None:
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        stream.close()
            if endpoint.cleanup_verified:
                try:endpoint.remove_root()
                except (OSError,ValueError,IsolatedDaemonError):
                    observations['cleanup_failure_stage']='root-removal'
                    endpoint.cleanup_verified=False
            if not endpoint.cleanup_verified:
                cleanup_error = IsolatedDaemonError('owned daemon cleanup unverified')
        endpoint.close()
        if cleanup_error is not None and error is None:
            raise cleanup_error


def privileged_self_test():
    """Native forced-live-task retirement; a trusted manager fixture only."""
    with isolated_vfs_daemon(lifetime=45) as endpoint:
        source = endpoint.root/'busy.c'
        binary = endpoint.root/'busy'
        archive = endpoint.root/'fixture.tar'
        source.write_text('void _start(void) { for (;;) __asm__ volatile("" ::: "memory"); }\n')
        built = subprocess.run(['/usr/bin/gcc-13','-nostdlib','-static','-no-pie','-fno-stack-protector',
                                '-O2',str(source),'-o',str(binary)],
                               capture_output=True,timeout=min(5,endpoint.remaining_seconds()),check=False)
        if built.returncode:
            raise IsolatedDaemonError('trusted manager fixture compilation failed')
        with tarfile.open(archive,'w') as stream:
            metadata = stream.gettarinfo(str(binary),arcname='busy')
            metadata.uid,metadata.gid,metadata.uname,metadata.gname,metadata.mode = 0,0,'','',0o555
            with binary.open('rb') as contents:
                stream.addfile(metadata,contents)
        imported = endpoint.command(['import',str(archive),endpoint.token+'-fixture'])
        if imported.returncode or re.fullmatch(rb'sha256:[0-9a-f]{64}\n',imported.stdout) is None:
            raise IsolatedDaemonError('trusted manager fixture import failed')
        image = imported.stdout.decode().strip()
        from kernel_docker import KernelPrivateDocker
        from configuration import audit_configuration
        from kernel_network import inspect_kernel_profile
        creator=KernelPrivateDocker(endpoint.environment)
        try:
            container=creator.create_worker(endpoint.token+'-fixture',endpoint.token,image,'manager')
            peer=creator.create_worker(endpoint.token+'-peer',endpoint.token,image,'manager')
            launched=endpoint.command(['start',container])
            if launched.returncode:
                raise IsolatedDaemonError('trusted manager fixture launch failed')
            if endpoint.command(['start',peer]).returncode:
                raise IsolatedDaemonError('trusted manager peer launch failed')
        finally:creator.close()
        inspected = endpoint.command(['inspect',container,'--format','{{json .}}'])
        if inspected.returncode or len(inspected.stdout)>65536:
            raise IsolatedDaemonError('trusted manager fixture inspection failed')
        record = json.loads(inspected.stdout)
        config,host,state = record.get('Config',{}),record.get('HostConfig',{}),record.get('State',{})
        if (record.get('Id') != container or record.get('Image') != image
                or config.get('Labels',{}).get('fleur.compatibility.vfs-owner') != endpoint.token
                or state.get('Running') is not True or record.get('Mounts') != []
                or host.get('NetworkMode') != 'none' or host.get('ReadonlyRootfs') is not True
                or host.get('Memory') != 536870912 or host.get('MemorySwap') != 536870912
                or host.get('NanoCpus') != 1000000000 or host.get('PidsLimit') != 64):
            raise IsolatedDaemonError('trusted manager fixture ownership/profile invalid')
        peer_result=endpoint.command(['inspect',peer,'--format','{{json .}}'])
        if peer_result.returncode or len(peer_result.stdout)>65536:
            raise IsolatedDaemonError('trusted manager peer inspection failed')
        peer_record=json.loads(peer_result.stdout)
        peer_proof=inspect_kernel_profile(peer,peer_record.get('State',{}).get('Pid'),timeout=min(5,endpoint.remaining_seconds()-12))
        audit_configuration(peer_record,endpoint.token,endpoint.token+'-peer',image,
                            owner_label='fleur.compatibility.vfs-owner',kernel_private=True,kernel_proof=peer_proof)
        proof=inspect_kernel_profile(container,state.get('Pid'),timeout=min(5,endpoint.remaining_seconds()-12),
                                    peer={'container_id':peer,'pid':peer_record['State']['Pid']})
        endpoint.facts['pairwise_network_isolation_verified']=True
        audit_configuration(record,endpoint.token,endpoint.token+'-fixture',image,
                            owner_label='fleur.compatibility.vfs-owner',kernel_private=True,kernel_proof=proof)
        endpoint.facts['kernel_private_network_verified']=True
        endpoint.facts['kernel_profile']=proof
        endpoint.facts['forced_live_task_verified'] = True
        endpoint.forced_probe_verified = _retire_supervisor(endpoint,min(10,endpoint.remaining_seconds()-3))
        if not endpoint.forced_probe_verified:
            raise IsolatedDaemonError('forced namespace retirement unverified',getattr(endpoint,'retirement_facts',{}))
    return dict(endpoint.facts,namespace_tasks_retired=True,namespace_shims_retired=True,
                cleanup_verified=endpoint.cleanup_verified)


def privileged_mount_self_test():
    """Actual kernel positive/negative mount checks, before the owned daemon proof."""
    if not eligible_host():
        raise IsolatedDaemonError('native mount test host invalid')
    program=inspect.getsource(owned_mounts)+'\nprint(json.dumps(native_self_test()))\n'
    result=subprocess.run(['sudo','-n','/usr/bin/timeout','--signal=TERM','--kill-after=.2s','15s',
                           '/usr/bin/python3','-I','-c',program],stdin=subprocess.DEVNULL,
                          capture_output=True,timeout=16,check=False)
    if result.returncode or len(result.stdout)>4096:
        raise IsolatedDaemonError('native mount lifecycle proof failed',
                                  {'returncode':result.returncode,'stderr_bytes':len(result.stderr)})
    facts=json.loads(result.stdout)
    if facts!={'ordinary_unmount_verified':True,'busy_mount_rejected':True,
               'replacement_mount_rejected':True,'unknown_mount_rejected':True,
               'unrelated_mount_preserved':True,'anchored_removal_verified':True,
               'symlink_removal_rejected':True,'shared_parent_slave_rejected':True,
               'owned_mounts_remaining':0}:
        raise IsolatedDaemonError('native mount lifecycle proof invalid')
    return facts

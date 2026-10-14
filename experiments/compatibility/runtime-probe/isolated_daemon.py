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
import shutil
import stat
import subprocess
import tempfile
import time
import uuid

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


ROOT_BODY = r'''set -eu
base=$1; token=$2; group=$3
case "$token" in fleur-vfs-????????????????????????????????) ;; *) exit 2 ;; esac
[ -d "$base" ] && [ ! -L "$base" ] && [ "$(cat "$base/owner")" = "$token" ] || exit 2
printf '%s' "$PPID" > "$base/supervisor.pid"
child=
clean=false
namespace_empty() {
    scope=0
    for namespace in "$token" "$token-plugins"; do
        scope=$((scope+1)); rc=0; command_start=$(date +%s%N)
        /usr/bin/timeout 2s /usr/bin/ctr --address /run/containerd/containerd.sock \
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
        /usr/bin/timeout 2s /usr/bin/ctr --address /run/containerd/containerd.sock \
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
            /usr/bin/timeout 2s /usr/bin/ctr --address /run/containerd/containerd.sock \
              --namespace "$namespace" tasks kill --all --signal SIGKILL "$id" >/dev/null 2>&1 || rc=$?
            diag 3 "$scope" "$rc" 1
        done
        if [ "$#" -gt 0 ]; then
            rc=0; command_start=$(date +%s%N)
            /usr/bin/timeout 2s /usr/bin/ctr --address /run/containerd/containerd.sock \
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
    rm -rf -- "$base/data" "$base/exec"
    rm -f -- "$base/docker.sock" "$base/docker.pid" "$base/daemon.log" "$base/tasks.tmp" "$base/shim.tmp"
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


# Exact same namespace routines for the outer forced-group fallback. Raw task
# identifiers stay in the owned directory and never cross diagnostics output.
RETIRE_BODY = r'''set -eu
LC_ALL=C; export LC_ALL
base=$1; token=$2
case "$token" in fleur-vfs-????????????????????????????????) ;; *) exit 2 ;; esac
suffix=${token#fleur-vfs-}
case "$suffix" in *[!0-9a-f]*) exit 2 ;; esac
[ -d "$base" ] && [ ! -L "$base" ] && [ "$(cat "$base/owner")" = "$token" ] || exit 2
''' + ROOT_BODY[ROOT_BODY.index('namespace_empty()'):ROOT_BODY.index('cleanup()')] + r'''
retire_namespaces
diag 10 0 0 0
IFS= read -r daemon < "$base/docker.pid" || [ -n "$daemon" ]
case "$daemon" in ''|*[!0-9]*|0|1) exit 2 ;; esac
if [ -r "/proc/$daemon/stat" ]; then
    record=$(cat "/proc/$daemon/stat")
    rest=${record##*) }; set -- $rest
    if [ "$1" != Z ]; then diag 11 0 0 1; exit 3; fi
fi
diag 11 0 0 0
mounts=0; mount_rc=0
if mounts=$(/usr/bin/python3 -c MOUNT_COUNT_CODE_PLACEHOLDER "$base" 2>/dev/null); then :; else mount_rc=$?; mounts=0; fi
diag 13 0 "$mount_rc" "$mounts"
remove_rc=0
rm -rf -- "$base/data" "$base/exec" 2>"$base/removal.stderr" || remove_rc=$?
diag 14 0 "$remove_rc" "$mounts"
busy=0
if grep -F -- 'Device or resource busy' "$base/removal.stderr" >/dev/null; then busy=1; fi
diag 15 0 "$remove_rc" "$busy"
[ "$remove_rc" = 0 ] || exit "$remove_rc"
rm -f -- "$base/docker.sock" "$base/docker.pid" "$base/daemon.log" "$base/tasks.tmp" "$base/shim.tmp"
diag 12 0 0 0
printf 'retired\n'
'''


RETIRE_BODY = RETIRE_BODY.replace('MOUNT_COUNT_CODE_PLACEHOLDER',shlex.quote(MOUNT_COUNT_CODE))

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


class Endpoint:
    def __init__(self, root, token, deadline):
        self.root, self.token, self.deadline = root, token, deadline
        self.cleanup_verified = False
        self.forced_probe_verified = False
        self.facts = {}
        self.environment = dict(os.environ)
        for key in ('DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION'):
            self.environment.pop(key, None)
        self.environment['DOCKER_HOST'] = 'unix://' + str(root / 'docker.sock')

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
        self.facts = {'driver': 'vfs', 'server_version': '28.0.4', 'owned': True,
                      'socket_verified': True, 'data_root_verified': True,
                      'exec_root_verified': True, 'namespace_verified': True,
                      'pid_verified': True, 'config_verified': True}


def retirement_observations(root, returncode, stdout):
    facts = {'cli_returncode':returncode, 'stdout_bytes':len(stdout), 'journal_invalid':False}
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


def _retire_supervisor(endpoint, budget):
    """Escalate only the verified fresh root timeout process group."""
    if type(budget) not in (int,float) or not math.isfinite(budget) or budget<=0:
        raise IsolatedDaemonError('owned retirement budget invalid')
    deadline=time.monotonic()+min(10,budget)
    pid = int((endpoint.root/'supervisor.pid').read_text())
    if pid <= 1 or Path('/proc/'+str(pid)+'/comm').read_text().strip() != 'timeout':
        raise IsolatedDaemonError('owned supervisor identity unavailable')
    record = Path('/proc/'+str(pid)+'/stat').read_text().rpartition(') ')[2].split()
    arguments = Path('/proc/'+str(pid)+'/cmdline').read_bytes().split(b'\0')
    if int(record[2]) != pid or str(endpoint.root).encode() not in arguments or endpoint.token.encode() not in arguments:
        raise IsolatedDaemonError('owned supervisor group invalid')
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
                    '/bin/sh','-c',RETIRE_BODY,'fleur-owned-retire',str(endpoint.root),endpoint.token],
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
    if result.returncode or len(result.stdout) > 4096:
        raise IsolatedDaemonError('default daemon identity unavailable')
    identity = json.loads(result.stdout)
    if (type(identity) is not dict or set(identity) != {'ID', 'Driver', 'DockerRootDir'}
            or any(type(value) is not str or not value for value in identity.values())):
        raise IsolatedDaemonError('default daemon identity invalid')
    return identity


@contextmanager
def isolated_vfs_daemon(lifetime=540):
    if not eligible_host() or type(lifetime) is not int or not 45 <= lifetime <= 540:
        raise IsolatedDaemonError('counterfactual host or lifetime invalid')
    parent = Path(os.environ.get('RUNNER_TEMP', ''))
    if not parent.is_absolute() or not parent.is_dir() or parent.is_symlink():
        raise IsolatedDaemonError('counterfactual temporary root invalid')
    baseline = _default_identity()
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
                                    'fleur-owned-vfs', str(root), token, str(os.getgid())],
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
        try:
            if endpoint.facts:
                try:
                    result = endpoint.command(['ps', '--all', '--quiet'], timeout=1)
                    empty = result.returncode == 0 and result.stdout == b''
                except (OSError, ValueError, subprocess.SubprocessError, IsolatedDaemonError):
                    pass
            # Inspection can never skip the independently owned stop/reap path.
            if process is not None:
                if process.poll() is None:
                    try:
                        process.stdin.write(b'stop\n'); process.stdin.flush(); process.stdin.close(); process.stdin = None
                    except (BrokenPipeError, OSError):
                        pass
                try:
                    output, _ = process.communicate(timeout=max(.1, cleanup_deadline-time.monotonic()-5))
                except subprocess.TimeoutExpired:
                    _retire_supervisor(endpoint, cleanup_deadline-time.monotonic())
                    process.wait(timeout=max(.1,min(2,cleanup_deadline-time.monotonic()-2)))
                    # Forced group retirement never proves detached task cleanup.
                    raise IsolatedDaemonError('owned daemon forced retirement')
                retired = endpoint.forced_probe_verified or (empty and process.returncode == 0 and output == b'stopped\n')
                endpoint.cleanup_verified = (retired and process.poll() is not None
                                              and not (root/'data').exists() and not (root/'exec').exists()
                                              and not (root/'docker.pid').exists() and not (root/'docker.sock').exists())
        except (OSError, subprocess.SubprocessError, ValueError, IsolatedDaemonError):
            endpoint.cleanup_verified = False
        finally:
            try:
                budget = cleanup_deadline-time.monotonic()
                unchanged = budget > 0 and _default_identity(timeout=min(2,budget)) == baseline
            except (OSError, ValueError, subprocess.SubprocessError, IsolatedDaemonError):
                unchanged = False
            endpoint.facts['default_daemon_unchanged'] = unchanged
            endpoint.cleanup_verified = endpoint.cleanup_verified and unchanged and time.monotonic() < cleanup_deadline
            if process is not None:
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        stream.close()
            if endpoint.cleanup_verified:
                shutil.rmtree(root)
            else:
                cleanup_error = IsolatedDaemonError('owned daemon cleanup unverified')
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
        launched = endpoint.command(['run','--detach','--name',endpoint.token+'-fixture',
                                    '--label','fleur.compatibility.vfs-owner='+endpoint.token,
                                    '--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
                                    '--cpus=1','--memory=512m','--memory-swap=512m','--pids-limit=64',
                                    '--pull=never',image,'/busy'])
        if launched.returncode or re.fullmatch(rb'[0-9a-f]{64}\n',launched.stdout) is None:
            raise IsolatedDaemonError('trusted manager fixture launch failed')
        container = launched.stdout.decode().strip()
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
        endpoint.facts['forced_live_task_verified'] = True
        endpoint.forced_probe_verified = _retire_supervisor(endpoint,min(10,endpoint.remaining_seconds()-3))
        if not endpoint.forced_probe_verified:
            raise IsolatedDaemonError('forced namespace retirement unverified',getattr(endpoint,'retirement_facts',{}))
    return dict(endpoint.facts,namespace_tasks_retired=True,namespace_shims_retired=True,
                cleanup_verified=endpoint.cleanup_verified)

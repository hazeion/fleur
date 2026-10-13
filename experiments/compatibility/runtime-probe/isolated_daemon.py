"""Owned VFS counterfactual daemon; never a fallback for the required gate."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import tempfile
import time
import uuid

ROOT_BODY = r'''set -eu
base=$1; token=$2; group=$3
case "$token" in fleur-vfs-????????????????????????????????) ;; *) exit 2 ;; esac
[ -d "$base" ] && [ ! -L "$base" ] && [ "$(cat "$base/owner")" = "$token" ] || exit 2
printf '%s' "$PPID" > "$base/supervisor.pid"
child=
clean=false
namespace_empty() {
    for namespace in "$token" "$token-plugins"; do
        /usr/bin/timeout 2s /usr/bin/ctr --address /run/containerd/containerd.sock \
          --namespace "$namespace" tasks list --quiet > "$base/tasks.tmp" 2>/dev/null || return 1
        [ ! -s "$base/tasks.tmp" ] || return 1
    done
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
                # A forced daemon stop does not prove detached shim retirement.
                return 1
            fi
        fi
        wait "$child" 2>/dev/null || return 1
    fi
    namespace_empty || return 1
    rm -rf -- "$base/data" "$base/exec"
    rm -f -- "$base/docker.sock" "$base/docker.pid" "$base/daemon.log" "$base/tasks.tmp"
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


def eligible_host():
    expected = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                'RUNNER_OS': 'Linux', 'GITHUB_REPOSITORY': 'hazeion/fleur',
                'GITHUB_WORKFLOW': 'Compatibility experiments',
                'GITHUB_JOB': 'runtime-vfs-counterfactual'}
    return platform.system() == 'Linux' and all(os.environ.get(k) == v for k, v in expected.items())


class IsolatedDaemonError(RuntimeError):
    pass


class Endpoint:
    def __init__(self, root, token, deadline):
        self.root, self.token, self.deadline = root, token, deadline
        self.cleanup_verified = False
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


def _retire_supervisor(endpoint, budget):
    """Escalate only the verified fresh root timeout process group."""
    pid = int((endpoint.root/'supervisor.pid').read_text())
    if pid <= 1 or Path('/proc/'+str(pid)+'/comm').read_text().strip() != 'timeout':
        raise IsolatedDaemonError('owned supervisor identity unavailable')
    record = Path('/proc/'+str(pid)+'/stat').read_text().rpartition(') ')[2].split()
    arguments = Path('/proc/'+str(pid)+'/cmdline').read_bytes().split(b'\0')
    if int(record[2]) != pid or str(endpoint.root).encode() not in arguments or endpoint.token.encode() not in arguments:
        raise IsolatedDaemonError('owned supervisor group invalid')
    result = subprocess.run(['sudo','-n','/bin/kill','-KILL','--','-'+str(pid)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=max(.1,min(1,budget)), check=False)
    if result.returncode:
        raise IsolatedDaemonError('owned supervisor escalation failed')


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
                endpoint.cleanup_verified = (empty and process.returncode == 0 and output == b'stopped\n'
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
    """Actual CI prerequisite/lifecycle proof; returns no raw host paths/IDs."""
    with isolated_vfs_daemon(lifetime=45) as endpoint:
        facts = endpoint.facts
    return dict(facts, cleanup_verified=endpoint.cleanup_verified)

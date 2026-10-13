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
child=
clean=false
cleanup() {
    [ "$clean" = false ] || return
    clean=true
    if [ -n "$child" ]; then
        if kill -0 "$child" 2>/dev/null; then
            IFS= read -r comm < "/proc/$child/comm" || return 1
            [ "$comm" = dockerd ] || return 1
            kill -TERM "$child" 2>/dev/null || true
            count=0
            while kill -0 "$child" 2>/dev/null && [ "$count" -lt 50 ]; do
                sleep .2; count=$((count+1))
            done
            if kill -0 "$child" 2>/dev/null; then kill -KILL "$child"; fi
        fi
        wait "$child" 2>/dev/null || true
    fi
    rm -rf -- "$base/data" "$base/exec"
    rm -f -- "$base/docker.sock" "$base/docker.pid" "$base/daemon.log"
    printf 'stopped\n'
}
trap 'cleanup' EXIT
trap 'exit 124' TERM INT
/usr/bin/dockerd --config-file "$base/config.json" --data-root "$base/data" \
 --exec-root "$base/exec" --pidfile "$base/docker.pid" --host "unix://$base/docker.sock" \
 --group "$group" --storage-driver vfs --bridge none --iptables=false --ip6tables=false \
 --ip-forward=false --ip-masq=false --userland-proxy=false \
 --containerd-namespace "$token" --containerd-plugins-namespace "$token-plugins" \
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


def _default_identity():
    environment = dict(os.environ)
    for key in ('DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION'):
        environment.pop(key, None)
    template = '{"ID":{{json .ID}},"Driver":{{json .Driver}},"DockerRootDir":{{json .DockerRootDir}}}'
    result = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', 'info', '--format', template],
                            env=environment, stdin=subprocess.DEVNULL, capture_output=True, timeout=5, check=False)
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
        try:
            empty = False
            if endpoint.facts:
                result = endpoint.command(['ps', '--all', '--quiet'])
                empty = result.returncode == 0 and result.stdout == b''
            if process is not None:
                if process.poll() is None:
                    try:
                        process.stdin.write(b'stop\n'); process.stdin.flush(); process.stdin.close(); process.stdin = None
                    except (BrokenPipeError, OSError):
                        pass
                output, _ = process.communicate(timeout=min(15, max(.1, endpoint.remaining_seconds())))
                endpoint.cleanup_verified = (empty and process.returncode == 0 and output == b'stopped\n'
                                              and not (root/'data').exists() and not (root/'exec').exists()
                                              and not (root/'docker.pid').exists() and not (root/'docker.sock').exists())
            unchanged = _default_identity() == baseline
            endpoint.facts['default_daemon_unchanged'] = unchanged
            endpoint.cleanup_verified = endpoint.cleanup_verified and unchanged
            if not endpoint.cleanup_verified:
                cleanup_error = IsolatedDaemonError('owned daemon cleanup unverified')
        except (OSError, subprocess.SubprocessError, ValueError):
            cleanup_error = IsolatedDaemonError('owned daemon cleanup unverified')
        finally:
            if process is not None:
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        stream.close()
            if endpoint.cleanup_verified:
                shutil.rmtree(root)
        if cleanup_error is not None and error is None:
            raise cleanup_error


def privileged_self_test():
    """Actual CI prerequisite/lifecycle proof; returns no raw host paths/IDs."""
    with isolated_vfs_daemon(lifetime=45) as endpoint:
        facts = endpoint.facts
    return dict(facts, cleanup_verified=endpoint.cleanup_verified)

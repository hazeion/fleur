"""Bounded read-only candidate evidence, never runtime admission or host authority."""
import hashlib
import json
import re
from pathlib import Path
import stat
import subprocess
import time


def observe_candidate_identity(command):
    """Observe selected identities using the guest's bounded OS-command runner.

    Path/daemon association facts are advisory. Canonical path checks do not
    establish immutable file/executable custody, alias stability, or authority
    against a privileged account. The caller owns process/output deadlines.
    This function creates no trusted control handle and cannot change profile
    eligibility or restriction results.
    """
    report = {'formatVersion': 1, 'scope': 'runtime-profile-candidate-observation',
              'accepted': False, 'runtimeSupport': 'unverified',
              'custodyVerified': False, 'outcome': 'unavailable'}
    deadline = time.monotonic() + 30
    retained = {}
    category = 'paths'

    def identity(info):
        return info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode

    def protected(name, kind, socket=False):
        path = Path(name).resolve(strict=True)
        info = path.stat(follow_symlinks=False)
        if info.st_uid != 0 or info.st_mode & (0o002 if socket else 0o022) or not kind(info.st_mode):
            raise ValueError('path')
        for parent in path.parents:
            value = parent.stat(follow_symlinks=False)
            if value.st_uid != 0 or value.st_mode & 0o022 or not stat.S_ISDIR(value.st_mode):
                raise ValueError('ancestor')
            retained[parent] = identity(value)
        retained[path] = identity(info)
        return path

    def revalidate():
        for path, expected in retained.items():
            if identity(path.stat(follow_symlinks=False)) != expected:
                raise ValueError('changed path')

    def read(path, limit):
        if path.stat().st_size > limit:
            raise ValueError('file bound')
        with path.open('rb') as stream:
            body = stream.read(limit + 1)
        if len(body) > limit:
            raise ValueError('file bound')
        revalidate()
        return body

    def token(value):
        if type(value) is not str or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+_~:/-]{0,127}', value) is None:
            raise ValueError('identity field')
        return value

    def invoke(args):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('observation deadline')
        revalidate()
        code, stdout, stderr = command(args, timeout=min(5, remaining))
        if code != 0 or type(stdout) is not str or len(stdout.encode()) > 65536 or len(stderr.encode()) > 4096:
            raise ValueError('command result')
        revalidate()
        if time.monotonic() >= deadline:
            raise TimeoutError('observation deadline')
        return stdout

    try:
        pidfile = protected('/var/run/docker.pid', stat.S_ISREG)
        raw = read(pidfile, 16).strip()
        if not raw.isdigit() or not 1 < int(raw) <= 2**31 - 1:
            raise ValueError('pid')
        pid = int(raw)
        protected(f'/proc/{pid}', stat.S_ISDIR)
        comm = protected(f'/proc/{pid}/comm', stat.S_ISREG)
        if read(comm, 64) != b'dockerd\n':
            raise ValueError('daemon')
        cmdline = protected(f'/proc/{pid}/cmdline', stat.S_ISREG)
        arguments = [part.decode('utf-8') for part in read(cmdline, 65536).split(b'\0') if part]
        # Reuse the existing strict duplicate-option parser, without admitting
        # any hosted runtime profile or calling its privileged control inspector.
        from configuration import _option
        config_path = _option(arguments, '--config-file') or '/etc/docker/daemon.json'
        if not config_path.startswith('/'):
            raise ValueError('configuration path')
        config = {}
        if Path(config_path).exists():
            config = json.loads(read(protected(config_path, stat.S_ISREG), 65536))
        if type(config) is not dict:
            raise ValueError('configuration shape')
        address = _option(arguments, '--containerd') or config.get('containerd')
        namespace = _option(arguments, '--containerd-namespace') or config.get('containerd-namespace', 'moby')
        if type(address) is not str or not address.startswith('/') or namespace != 'moby':
            raise ValueError('containerd address')
        protected(address, stat.S_ISSOCK, socket=True)
        protected('/var/run/docker.sock', stat.S_ISSOCK, socket=True)
        ctr = protected('/usr/bin/ctr', stat.S_ISREG)
        runc = protected('/usr/bin/runc', stat.S_ISREG)
        docker = ['docker', '--host', 'unix:///var/run/docker.sock']
        category = 'engine-identity'
        default_id = invoke(docker + ['info', '--format', '{{.ID}}']).strip()
        if not default_id or len(default_id) > 256 or any(c.isspace() for c in default_id):
            raise ValueError('daemon id')
        if invoke(['docker', 'info', '--format', '{{.ID}}']).strip() != default_id:
            raise ValueError('daemon association')
        server = json.loads(invoke(docker + ['version', '--format', '{{json .Server}}']))
        if type(server) is not dict or type(server.get('Components')) is not list:
            raise ValueError('engine shape')
        components = []
        for name in ('containerd', 'runc'):
            rows = [row for row in server['Components'] if type(row) is dict and row.get('Name') == name]
            if len(rows) != 1 or type(rows[0].get('Details')) is not dict:
                raise ValueError('component count')
            components.append({'Name': name, 'Version': token(rows[0].get('Version')),
                               'Details': {'GitCommit': token(rows[0]['Details'].get('GitCommit'))}})
        report['engine'] = {'Version': token(server.get('Version')), 'GitCommit': token(server.get('GitCommit')), 'Components': components}
        category = 'ctr-identity'
        prefix = ['/usr/bin/sudo', '-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
                  'CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS=true', '/usr/bin/timeout', '--signal=TERM', '--kill-after=0.2s', '4s']
        detail = invoke(prefix + [str(ctr), '--address', address, '--namespace', namespace, 'version'])
        sections = {}; current = None
        for line in detail.splitlines():
            if not line.strip():
                continue
            if line in ('Client:', 'Server:'):
                if line in sections:
                    raise ValueError('duplicate ctr section')
                current = {}; sections[line] = current
                continue
            if current is None or ':' not in line:
                raise ValueError('ctr shape')
            key, value = line.strip().split(':', 1)
            if key not in ('Version', 'Revision', 'Go version', 'UUID') or key in current:
                raise ValueError('ctr field')
            current[key] = value.strip()
        if set(sections) != {'Client:', 'Server:'}:
            raise ValueError('ctr sections')
        selected = {}
        for label, key in (('Client:', 'client'), ('Server:', 'server')):
            selected[key] = {field: token(sections[label].get(field)) for field in ('Version', 'Revision')}
        report['ctr'] = {**selected, 'binarySha256': hashlib.sha256(read(ctr, 64 * 1024 * 1024)).hexdigest()}
        expected = components[0]
        if any(row['Version'] != expected['Version'] or row['Revision'] != expected['Details']['GitCommit'] for row in selected.values()):
            raise ValueError('ctr disagreement')
        category = 'runc-identity'
        detail = invoke([str(runc), '--version'])
        versions = re.findall(r'^runc version ([^\s]+)$', detail, re.MULTILINE)
        commits = re.findall(r'^commit: ([^\s]+)$', detail, re.MULTILINE)
        if len(versions) != 1 or len(commits) != 1:
            raise ValueError('runc shape')
        report['runc'] = {'version': token(versions[0]), 'commit': token(commits[0]),
                          'binarySha256': hashlib.sha256(read(runc, 64 * 1024 * 1024)).hexdigest()}
        if versions[0] != components[1]['Version'] or commits[0] != components[1]['Details']['GitCommit']:
            raise ValueError('runc disagreement')
        category = 'final-association'
        if invoke(docker + ['info', '--format', '{{.ID}}']).strip() != default_id or invoke(['docker', 'info', '--format', '{{.ID}}']).strip() != default_id:
            raise ValueError('daemon changed')
        revalidate()
        report.update(outcome='observed', pathFactsChecked=True, daemonAssociationObserved=True)
    except (OSError, RuntimeError, ValueError, KeyError, UnicodeError, subprocess.TimeoutExpired) as error:
        report['failureCategory'] = category
        report['timedOut'] = isinstance(error, (TimeoutError, subprocess.TimeoutExpired))
    return report

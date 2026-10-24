"""Private native qualification: completed installation effects, missing parent receipt.

Automated disposable-guest PTY replies are not human or legal consent. This helper
never installs on the host. It requires the existing source-bound guest policy.
"""
import ctypes
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import pty
import re
import select
import signal
import stat
import subprocess
import sys
import time

ROOT = Path.home() / 'lab'
# Execute only the already-reviewed policy bytes, never a second pathname read.
import types
def qualified_source(path, expected, maximum=131072):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o022 or not 0 < info.st_size <= maximum:
            raise RuntimeError('Unsafe imported qualification source')
        chunks = []
        used = 0
        while used <= info.st_size:
            part = os.read(fd, min(65536, info.st_size + 1 - used))
            if not part:
                break
            used += len(part)
            chunks.append(part)
        fields = lambda item: (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        body = b''.join(chunks)
        if used != info.st_size or fields(os.fstat(fd)) != fields(info) or fields(path.lstat()) != fields(info) or hashlib.sha256(body).hexdigest() != expected:
            raise RuntimeError('Imported qualification source differs from its exact reviewed bytes')
        return body
    finally:
        os.close(fd)


policy_path = ROOT / 'fresh-linux-guest.py'
policy_bytes = qualified_source(policy_path, '31a0c0ddd4c71a7a2f0922b266b1f0bdb4e8f48aef4cf03b6a79e8bf6042f6ec')
guest = types.ModuleType('fresh_linux_policy')
guest.__file__ = str(policy_path)
if guest.__name__ in sys.modules:
    raise RuntimeError('Imported guest policy namespace is already occupied')
sys.modules[guest.__name__] = guest
exec(compile(bytes(policy_bytes), str(policy_path), 'exec'), guest.__dict__)



def load_module(filename, name):
    body = qualified_source(ROOT / filename, SOURCE['files'][filename])
    module = types.ModuleType(name)
    module.__file__ = str(ROOT / filename)
    exec(compile(body, module.__file__, 'exec'), module.__dict__)
    return module


def load_qualification_source(expected):
    if not re.fullmatch(r'[a-f0-9]{64}', expected):
        raise RuntimeError('Exact host-held qualification source digest required')
    body = qualified_source(ROOT / 'qualification-source.json', expected)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result: raise RuntimeError('Duplicate qualification source key')
            result[key] = value
        return result
    record = json.loads(body, object_pairs_hook=unique)
    files = {'fresh-linux-guest.py', 'fleur-interrupted-guest.py', 'fleur-transition-owned-reboot.py',
             'fleur-interruption-supervisor-selftest.py', 'fleur-native-inspector-conformance.ts',
             'debian_recovery_contract.py', 'debian-recovery-preservation.py'}
    if (type(record) is not dict or set(record) != {'formatVersion','scope','sourceCommit','ordinaryArchiveSha256','files'}
        or type(record['formatVersion']) is not int or record['formatVersion'] != 1
        or record['scope'] != 'source-owned-debian-interruption-inputs'
        or type(record['sourceCommit']) is not str or not re.fullmatch(r'[a-f0-9]{40}', record['sourceCommit'])
        or type(record['ordinaryArchiveSha256']) is not str or not re.fullmatch(r'[a-f0-9]{64}', record['ordinaryArchiveSha256'])
        or type(record['files']) is not dict or set(record['files']) != files):
        raise RuntimeError('Closed source-owned interruption inputs required')
    for filename, sha in record['files'].items():
        if type(sha) is not str or not re.fullmatch(r'[a-f0-9]{64}', sha): raise RuntimeError('Invalid qualification source digest')
        qualified_source(ROOT / filename, sha)
    qualified_source(ROOT / 'fleur-internal-native-candidate.tgz', record['ordinaryArchiveSha256'], 8*1024*1024)
    return record


def packages_raw():
    return guest.run(['/usr/bin/dpkg-query', '--root=/', '--admindir=/var/lib/dpkg', '--show',
        '--showformat=${binary:Package}\t${Version}\t${db:Status-Status}\t${db:Status-Eflag}\n'], timeout=20)[1]


class ReceiptWindowInterrupted(Exception):
    pass


def bounded_proc(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        parts = []
        used = 0
        while used <= maximum:
            part = os.read(fd, min(65536, maximum + 1 - used))
            if not part:
                break
            used += len(part)
            if used > maximum:
                raise RuntimeError('Process observation exceeded its bounded read')
            parts.append(part)
        return b''.join(parts)
    finally:
        os.close(fd)


def process_identity(pid):
    """A PID alone is never a signal target or descendant identity."""
    root = Path('/proc') / str(pid)
    raw = bounded_proc(root / 'stat', 65536).decode()
    end = raw.rfind(') ')
    if end < 0:
        raise RuntimeError('Malformed bounded process observation')
    fields = raw[end + 2:].split()
    if len(raw) > 65536 or len(fields) < 20 or raw[:raw.find(' ')] != str(pid):
        raise RuntimeError('Malformed bounded process observation')
    argv = bounded_proc(root / 'cmdline', 65536)
    if len(argv) > 65536:
        raise RuntimeError('Process command exceeded bound')
    return {'pid': pid, 'start': fields[19], 'state': fields[0], 'ppid': int(fields[1]),
            'uid': root.stat().st_uid, 'argv': [item.decode() for item in argv.split(b'\0') if item]}


def process_table():
    paths = [path for path in Path('/proc').iterdir() if path.name.isdigit()]
    if len(paths) > 2048:
        raise RuntimeError('Guest process observation exceeded bound')
    rows = {}
    for path in paths:
        try:
            row = process_identity(int(path.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
        rows[row['pid']] = row
    return rows


def descendants(table, leader):
    found = set()
    pending = {leader}
    while pending:
        parents, pending = pending, set()
        for pid, row in table.items():
            if pid not in found and row['ppid'] in parents:
                found.add(pid)
                pending.add(pid)
    if leader in found:
        raise RuntimeError('Process ancestry cycle')
    return found


def read_pending():
    path = Path.home() / '.local/state/fleur/setup/apt-transaction-pending.json'
    file = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(file)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or not 0 < info.st_size <= 1048576:
            raise RuntimeError('Pending marker custody is unsafe')
        body = os.read(file, info.st_size + 1)
        current = path.lstat()
        if len(body) != info.st_size or (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise RuntimeError('Pending marker custody changed')
        value = json.loads(body)
        if value.get('formatVersion') != 2 or value.get('action') != 'install' or value.get('method') != 'docker-official-apt':
            raise RuntimeError('Original package action is not a format2 APT installation')
        return value, {'sha256': hashlib.sha256(body).hexdigest(), 'dev': str(info.st_dev), 'ino': str(info.st_ino), 'size': info.st_size}
    finally:
        os.close(file)


def installation_child(row, marker):
    argv = row['argv']
    if row['uid'] != 0 or not argv or Path(argv[0]).name != 'apt-get' or '--simulate' in argv or '--no-download' not in argv or 'install' not in argv or row['state'] in ('Z', 'X'):
        return False
    root = str(Path.home() / '.local/state/fleur/setup' / marker['artifacts']['root'])
    expected = sorted(root + '/' + entry['path'] for entry in marker['artifacts']['entries']
                      if entry['path'].startswith('archives/') and entry['path'].endswith('.deb') and not entry['directory'])
    actual = sorted(argv[argv.index('install') + 1:])
    return bool(expected) and actual == expected


def same_process(original, current):
    return original['pid'] == current['pid'] and original['start'] == current['start']


def subreaper(value=None):
    library = ctypes.CDLL(None, use_errno=True)
    current = ctypes.c_int()
    if library.prctl(37, ctypes.byref(current), 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'Cannot observe owned supervisor subreaper state')
    original = current.value
    if value is not None:
        if library.prctl(36, ctypes.c_ulong(value), 0, 0, 0) != 0 or library.prctl(37, ctypes.byref(current), 0, 0, 0) != 0 or current.value != value:
            raise OSError(ctypes.get_errno(), 'Cannot establish owned supervisor subreaper state')
    return original


def accumulate(table, leader, observed):
    for pid in descendants(table, leader):
        row = table[pid]
        observed[(pid, row['start'])] = row


def retire_adopted(observed, deadline):
    receipts = []
    while True:
        if time.monotonic() >= deadline:
            raise TimeoutError('Owned privileged descendants did not retire before their observation deadline')
        table = process_table()
        owned = descendants(table, os.getpid())
        for pid in owned:
            row = table[pid]
            observed[(pid, row['start'])] = row
        live = [pid for pid in owned if table[pid]['state'] not in ('Z', 'X')]
        direct = [pid for pid in owned if table[pid]['ppid'] == os.getpid() and table[pid]['state'] == 'Z']
        for pid in direct:
            row = table[pid]
            terminal = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if terminal is None or terminal.si_pid != pid:
                raise RuntimeError('Adopted child terminal identity is uncertain')
            before_reap = process_identity(pid)
            if not same_process(row, before_reap):
                raise RuntimeError('Adopted child identity changed before its accounted reap')
            reaped, status = os.waitpid(pid, 0)
            if reaped != pid:
                raise RuntimeError('Adopted child reap identity differs')
            receipts.append({'pid': pid, 'start': row['start'], 'uid': terminal.si_uid,
                             'code': terminal.si_code, 'status': terminal.si_status, 'waitStatus': status})
        # A completed scan with no children is conclusive only after the reserved CLI
        # was reaped; orphan adoption closes gaps between preceding process scans.
        if not owned:
            return receipts
        if live or direct:
            time.sleep(0.01)
        else:
            time.sleep(0.01)


def interrupt_setup(reply, expected_prompt=None):
    if reply != 'once' or expected_prompt is not None:
        return original_setup_pty(reply, expected_prompt)
    limit = int(guest.budget_seconds(600))
    if descendants(process_table(), os.getpid()):
        raise RuntimeError('Dedicated interruption supervisor is not idle')
    previous_subreaper = subreaper()
    master = slave = None
    child = None
    output = bytearray()
    prompts = []
    observed_children = {}
    selected = None
    evidence = {'kind': 'subreaper-supervised-completed-effects-missing-parent-receipt', 'historicalOutcome': 'unknown', 'humanConsentProof': False}
    deadline = time.monotonic() + guest.budget_seconds(615)
    try:
        subreaper(1)
        master, slave = pty.openpty()
        child = subprocess.Popen([guest.BUN, guest.CLI, 'setup', '--timeout', str(limit)],
                                 stdin=slave, stdout=slave, stderr=slave, start_new_session=True, close_fds=True)
        os.close(slave)
        slave = None
        leader = process_identity(child.pid)
        while not guest.command_exited(child):
            if time.monotonic() >= deadline:
                raise TimeoutError('Native interruption window deadline expired')
            table = process_table()
            current = table.get(child.pid)
            if not current or not same_process(leader, current):
                raise RuntimeError('Owned CLI identity changed')
            owned = descendants(table, child.pid)
            accumulate(table, child.pid, observed_children)
            try:
                marker, fence = read_pending()
            except FileNotFoundError:
                marker = None
            candidates = [table[pid] for pid in owned if marker and installation_child(table[pid], marker)]
            if len(candidates) > 1:
                raise RuntimeError('Ambiguous privileged installation child')
            if candidates:
                selected = candidates[0]
                os.kill(child.pid, signal.SIGSTOP)
                stop_deadline = min(deadline, time.monotonic() + 2)
                while True:
                    stopped = process_identity(child.pid)
                    if not same_process(leader, stopped):
                        raise RuntimeError('Owned CLI changed during stop')
                    if stopped['state'] == 'T':
                        break
                    if time.monotonic() >= stop_deadline:
                        raise TimeoutError('Owned CLI stop was not observed')
                    time.sleep(0.005)
                still_live = process_identity(selected['pid'])
                if not same_process(selected, still_live) or still_live['state'] in ('Z', 'X'):
                    raise RuntimeError('Selected installation did not remain live across parent stop')
                evidence.update({'cli': {'pid': leader['pid'], 'start': leader['start'], 'stopped': True}, 'child': selected,
                                 'originalFence': fence})
                # The child is not ours to reap. Preserve its unknown terminal outcome.
                terminal_deadline = min(deadline, time.monotonic() + 180)
                while True:
                    table = process_table()
                    accumulate(table, child.pid, observed_children)
                    accumulate(table, os.getpid(), observed_children)
                    observed = table.get(selected['pid'])
                    if observed and same_process(selected, observed) and observed['state'] not in ('Z', 'X'):
                        if time.monotonic() >= terminal_deadline:
                            raise TimeoutError('Installation child did not leave the live state while parent was stopped')
                        time.sleep(0.02)
                        continue
                    evidence['childTerminalObservation'] = 'original identity no longer live; exit status unknown'
                    break
                latest_marker, latest_fence = read_pending()
                if latest_fence != fence or latest_marker != marker:
                    raise RuntimeError('Stopped parent did not preserve its original fence')
                # Reap only this owned reserved leader, with no privileged group kill.
                os.kill(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
                if child.returncode != -signal.SIGKILL:
                    raise RuntimeError('Owned CLI interruption was not confirmed')
                evidence['cli']['reapedAfterSigkill'] = True
                evidence['adoptedReapReceipts'] = retire_adopted(observed_children, min(deadline, time.monotonic() + 10))
                evidence['observedDescendants'] = list(observed_children.values())
                evidence['subreaperDescendantsRetired'] = True
                guest.REPORT['interruption'] = evidence
                guest.REPORT['authorizedFixtureSetup'] = {'exitCode': child.returncode, 'promptsAnswered': len(prompts), 'prompts': prompts, 'reply': reply, 'transcript': output.decode(errors='replace')}
                raise ReceiptWindowInterrupted()
            if select.select([master], [], [], 0.01)[0]:
                try:
                    chunk = os.read(master, 8192)
                except OSError:
                    break
                output.extend(chunk)
                if len(output) > 1048576:
                    raise RuntimeError('Interruption PTY output exceeded bound')
                matches = list(re.finditer(r"Authorize ([a-z-]+) using ([a-z-]+) for ([^\r\n]+)\r?\nPlan ([a-f0-9]{64})\r?\nType 'once', 'remember', or 'deny': ", output.decode(errors='replace')))
                while len(prompts) < len(matches):
                    match = matches[len(prompts)]
                    if len(prompts) >= 8 or match[1] not in {'install', 'configuration', 'repository-configuration', 'docker-access', 'service-start', 'service-enable'} or match[2] != 'docker-official-apt':
                        raise RuntimeError('Unexpected native installation authority prompt')
                    prompts.append({'action': match[1], 'method': match[2], 'target': match[3], 'checksum': match[4]})
                    os.write(master, b'once\n')
        raise RuntimeError('Packed CLI ended without the required actual interruption window')
    finally:
        try:
            if child is not None and child.returncode is None:
                if not guest.command_exited(child):
                    os.kill(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
        finally:
            try:
                try:
                    if master is not None:
                        os.close(master)
                finally:
                    if slave is not None:
                        os.close(slave)
            finally:
                # Restoration cannot imply surviving privileged work was cleaned.
                subreaper(previous_subreaper)


original_setup_pty = guest.setup_pty


def state_snapshot(marker, pending_required=True):
    state = Path.home() / '.local/state/fleur/setup'
    files = {}
    for name in ('apt-transaction-pending.json', 'grants.json'):
        path = state / name
        if name == 'apt-transaction-pending.json' and not pending_required:
            continue
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or not 0 < info.st_size <= 1048576:
                raise RuntimeError('Unsafe retained state file')
            parts = []
            used = 0
            while True:
                guest.budget_seconds(1)
                chunk = os.read(fd, min(65536, info.st_size + 1 - used))
                if not chunk:
                    break
                used += len(chunk)
                if used > info.st_size:
                    raise RuntimeError('Retained state file grew')
                parts.append(chunk)
            if used != info.st_size or guest.file_identity(os.fstat(fd)) != guest.file_identity(info) or guest.file_identity(path.lstat()) != guest.file_identity(info):
                raise RuntimeError('Retained state file custody changed')
            body = b''.join(parts)
            files[name] = {'dev': str(info.st_dev), 'ino': str(info.st_ino), 'uid': info.st_uid,
                           'mode': stat.S_IMODE(info.st_mode), 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
        finally:
            os.close(fd)
    artifacts = []
    root = state / marker['artifacts']['root']
    for entry in marker['artifacts']['entries']:
        relative = entry['path']
        if not isinstance(relative, str) or (relative != '.' and any(part in ('', '.', '..') for part in relative.split('/'))) or relative.startswith('/'):
            raise RuntimeError('Unsafe retained artifact path')
        path = root / relative
        info = path.lstat()
        observed = {'path': relative, 'dev': str(info.st_dev), 'ino': str(info.st_ino), 'uid': info.st_uid,
                    'mode': stat.S_IMODE(info.st_mode), 'directory': stat.S_ISDIR(info.st_mode)}
        if stat.S_ISLNK(info.st_mode) or (str(info.st_dev), str(info.st_ino)) != (entry['dev'], entry['ino']):
            raise RuntimeError('Retained artifact identity changed')
        try:
            if entry['directory']:
                observed['children'] = sorted(item.name for item in path.iterdir())
            else:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    held = os.fstat(fd)
                    if not stat.S_ISREG(held.st_mode) or held.st_nlink != 1 or held.st_size != entry['size'] or (held.st_dev, held.st_ino) != (info.st_dev, info.st_ino):
                        raise RuntimeError('Retained regular artifact custody changed')
                    digest = hashlib.sha256()
                    used = 0
                    while True:
                        guest.budget_seconds(1)
                        chunk = os.read(fd, min(65536, entry['size'] + 1 - used))
                        if not chunk:
                            break
                        used += len(chunk)
                        if used > entry['size']:
                            raise RuntimeError('Retained artifact grew')
                        digest.update(chunk)
                    if guest.file_identity(os.fstat(fd)) != guest.file_identity(held) or guest.file_identity(path.lstat()) != guest.file_identity(held) or used != entry['size'] or digest.hexdigest() != entry['sha256']:
                        raise RuntimeError('Retained artifact bytes changed')
                    observed.update({'size': used, 'sha256': digest.hexdigest()})
                finally:
                    os.close(fd)
        except PermissionError:
            if not entry['auxiliary'] or relative not in ('archives/partial', 'local-lists/auxfiles') or not stat.S_ISDIR(info.st_mode):
                raise
            # The ordinary view stays unknown; recovery needs its separate protected inspection proof.
            observed['contents'] = 'unreadable; not inspected or assumed empty'
        artifacts.append(observed)
    return {'files': files, 'artifacts': artifacts}


def exact_packages():
    expected = dict(item.split('=', 1) for item in guest.installation_packages())
    stdout = packages_raw()
    contract.validate_exact_package_effects(guest.REPORT['recoveryOriginalPackageInventory'], stdout, expected)
    return {'exactPackages': expected, 'healthyInventorySha256': hashlib.sha256(stdout.encode()).hexdigest(), 'historicalExitStatus': 'unknown'}



def inspection_pty(plan):
    if (set(plan) != {'action', 'method', 'target', 'checksum'} or plan['action'] != 'recovery-inspect'
            or plan['method'] != 'docker-official-apt' or not re.fullmatch(r'[a-f0-9]{64}', plan['checksum'])):
        raise RuntimeError('Closed read-only inspection plan required')
    limit = int(guest.budget_seconds(600))
    master = slave = None
    child = None
    output = bytearray()
    prompts = []
    try:
        master, slave = pty.openpty()
        child = subprocess.Popen([guest.BUN, guest.CLI, 'setup', '--timeout', str(limit)], stdin=slave, stdout=slave,
                                 stderr=slave, start_new_session=True, close_fds=True)
        os.close(slave)
        slave = None
        parent = process_identity(child.pid)
        deadline = time.monotonic() + guest.budget_seconds(615)
        while not guest.command_exited(child):
            if time.monotonic() >= deadline:
                raise TimeoutError('Bounded inspection fixture PTY deadline expired')
            if not select.select([master], [], [], 0.05)[0]:
                continue
            try:
                chunk = os.read(master, 8192)
            except OSError:
                break
            output.extend(chunk)
            if len(output) > 1048576:
                raise RuntimeError('Inspection fixture transcript exceeded bound')
            matches = list(re.finditer(r"Authorize ([a-z-]+) using ([a-z-]+) for ([^\r\n]+)\r?\nPlan ([a-f0-9]{64})\r?\nType 'once', 'remember', or 'deny': ", output.decode(errors='replace')))
            while len(prompts) < len(matches):
                match = matches[len(prompts)]
                prompt = {'action': match[1], 'method': match[2], 'target': match[3], 'checksum': match[4]}
                if prompts or prompt != plan:
                    raise RuntimeError('No authority supplied to an unexpected recovery action')
                prompts.append(prompt)
                os.write(master, b'once\n')
    finally:
        try:
            if child is not None:
                guest.stop_command_group(child)
        finally:
            try:
                if slave is not None:
                    os.close(slave)
            finally:
                if master is not None:
                    os.close(master)
    if child.returncode not in (0, 4) or len(prompts) != 1:
        raise RuntimeError('Scoped inspection did not complete its separately authorized current-state reprobe: ' + output.decode(errors='replace')[-2048:])
    return {'exitCode': child.returncode, 'promptsAnswered': len(prompts), 'prompts': prompts,
            'reply': 'once', 'parent': {'pid': parent['pid'], 'start': parent['start']},
            'transcript': output.decode(errors='replace'), 'humanConsentProof': False,
            'scope': 'automated-disposable-inspection-consent-fixture'}


def validate_inspection_evidence(inspection, marker, fence, current_boot, plan, authorization, conformance):
    if type(inspection) is not dict or set(inspection) != {'grantId', 'checksum', 'inspectorSha256', 'request', 'observed'}:
        raise RuntimeError('Closed inspected-recovery receipt required')
    if (not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', inspection['grantId']) or inspection['checksum'] != plan['checksum']
            or inspection['inspectorSha256'] != conformance.get('inspectorSha256')):
        raise RuntimeError('Inspection receipt source or separate authority differs')
    request = inspection['request']
    observed = inspection['observed']
    if type(request) is not dict or set(request) != {'formatVersion', 'accountSha256', 'executableSha256', 'directories'} or type(request['formatVersion']) is not int or request['formatVersion'] != 1:
        raise RuntimeError('Closed inspection authority binding required')
    if (type(observed) is not dict or set(observed) != {'formatVersion', 'empty', 'requestSha256', 'accountSha256', 'aptUid', 'directories', 'executionRequest'}
            or type(observed['formatVersion']) is not int or observed['formatVersion'] != 1 or observed['empty'] is not True):
        raise RuntimeError('Successful bounded empty-directory inspection required')
    execution = observed['executionRequest']
    if type(execution) is not dict or set(execution) != {'formatVersion', 'accountSha256', 'parentPid', 'parentStart', 'user', 'executableSha256', 'directories', 'deadlineNs'}:
        raise RuntimeError('Closed live-parent inspection execution binding required')
    if (type(execution['formatVersion']) is not int or execution['formatVersion'] != 1
            or type(execution['parentPid']) is not int or execution['parentPid'] != authorization['parent']['pid']
            or execution['parentStart'] != authorization['parent']['start'] or type(execution['user']) is not int or execution['user'] != os.getuid()
            or not isinstance(execution['deadlineNs'], str) or not re.fullmatch(r'[0-9]{1,20}', execution['deadlineNs'])):
        raise RuntimeError('Inspection did not bind the observed ordinary CLI parent')
    def digest(value):
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    if (observed['requestSha256'] != digest(execution) or observed['accountSha256'] != request['accountSha256']
            or execution['accountSha256'] != request['accountSha256'] or execution['executableSha256'] != request['executableSha256']
            or request['executableSha256'] != guest.handoff_artifacts()['bunExecutable']['sha256']):
        raise RuntimeError('Inspection execution or executable digest differs')
    # Public passwd data is read through a held descriptor; no shadow data is used.
    descriptor = os.open('/etc/passwd', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022 or not 0 < info.st_size <= 1048576:
            raise RuntimeError('Unsafe local account evidence')
        body = bytearray()
        while len(body) <= info.st_size:
            guest.budget_seconds(1)
            chunk = os.read(descriptor, min(65536, info.st_size + 1 - len(body)))
            if not chunk:
                break
            body.extend(chunk)
        if len(body) != info.st_size or guest.file_identity(os.fstat(descriptor)) != guest.file_identity(info) or guest.file_identity(Path('/etc/passwd').lstat()) != guest.file_identity(info):
            raise RuntimeError('Local account evidence changed')
    finally:
        os.close(descriptor)
    if hashlib.sha256(body).hexdigest() != request['accountSha256']:
        raise RuntimeError('Inspection did not use the current protected account database')
    rows = [line.split(':') for line in body.decode().splitlines()]
    apt = [row for row in rows if row[0] == '_apt']
    if len(apt) != 1 or len(apt[0]) != 7 or not re.fullmatch(r'[1-9][0-9]*', apt[0][2]) or type(observed['aptUid']) is not int or observed['aptUid'] != int(apt[0][2]):
        raise RuntimeError('Inspection APT account identity differs')
    paths = ['.', 'archives', 'local-lists', 'archives/partial', 'local-lists/auxfiles']
    if type(request['directories']) is not list or len(request['directories']) != len(paths) or type(execution['directories']) is not list or len(execution['directories']) != len(paths):
        raise RuntimeError('Exactly five fixed retained directory bindings required')
    if observed['directories'] != request['directories']:
        raise RuntimeError('Inspection result differs from its approved current directory state')
    fds = set()
    for index, path in enumerate(paths):
        item = request['directories'][index]
        executed = execution['directories'][index]
        if type(item) is not dict or set(item) != {'path', 'metadata'} or item['path'] != path or type(executed) is not dict or set(executed) != {'path', 'fd', 'metadata'} or executed['path'] != path or executed['metadata'] != item['metadata'] or type(executed['fd']) is not int or executed['fd'] < 0 or executed['fd'] in fds:
            raise RuntimeError('Inspection directory or descriptor schema differs')
        fds.add(executed['fd'])
        info = (Path.home() / '.local/state/fleur/setup' / marker['artifacts']['root'] / path).lstat()
        metadata = {'dev': str(info.st_dev), 'ino': str(info.st_ino), 'uid': info.st_uid, 'gid': info.st_gid,
                    'mode': stat.S_IMODE(info.st_mode), 'nlink': str(info.st_nlink), 'mtimeNs': str(info.st_mtime_ns), 'ctimeNs': str(info.st_ctime_ns)}
        exact_record(item['metadata'], metadata)
        original = next(entry for entry in marker['artifacts']['entries'] if entry['path'] == path)
        if not stat.S_ISDIR(info.st_mode) or (str(info.st_dev), str(info.st_ino), stat.S_IMODE(info.st_mode)) != (original['dev'], original['ino'], original['mode']):
            raise RuntimeError('Inspection did not preserve the original directory identities')
        if index >= 3 and info.st_uid not in (os.getuid(), 0, observed['aptUid']):
            raise RuntimeError('Inspection observed an unexplained auxiliary owner')
    scope = {'action': 'recovery-inspect', 'method': 'docker-official-apt', 'target': plan['target'], 'machine': marker['machine'], 'user': os.getuid(),
             'pendingSha256': fence['sha256'], 'profileChecksum': marker['checksum'], 'bootId': current_boot,
             'inspectorSha256': inspection['inspectorSha256'], 'request': request}
    if digest(scope) != inspection['checksum']:
        raise RuntimeError('Inspection grant checksum does not bind its exact operation and current evidence')


def initial_phase():
    original_arguments = sys.argv[1:]
    guest.GUEST_DEADLINE = time.monotonic() + 45
    _nonce, old_resume, initial_binding, initial_recorded = guest.parse_recorded_guest_invocation(original_arguments)
    if old_resume is not None or initial_binding is None or not initial_recorded:
        raise RuntimeError('Explicit original owned binding required before conformance')
    guest.verify_owned_binding(initial_binding)
    conformance_source = qualified_source(ROOT / 'fleur-interruption-supervisor-selftest.py', '4c0598494e0190ffac4fd97fc187c4478945bdf7130c6ff485e4807bb1396f64')
    own_sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    code, output, _ = guest.run([sys.executable, '-I', '-c', conformance_source.decode(), '--helper-sha256', own_sha, *original_arguments], timeout=35, allowed=(0, 4))
    conformance = json.loads(output)
    if code != 0 or conformance.get('formatVersion') != 1 or conformance.get('scope') != 'owned-interruption-supervisor-conformance' or conformance.get('ok') is not True or conformance.get('humanConsentProof') is not False or conformance.get('runtimeAdmission') is not False or conformance.get('helperSha256') != own_sha or [item.get('case') for item in conformance.get('cases', [])] != ['delayed', 'rapid', 'nested', 'survivor', 'unexpected-direct-child']:
        raise RuntimeError('Actual Linux supervisor conformance did not pass')
    guest.REPORT['interruptionSupervisorConformance'] = conformance
    guest.REPORT['recoveryOriginalPackageInventory'] = packages_raw()
    guest.setup_pty = interrupt_setup
    try:
        guest.main()
    except ReceiptWindowInterrupted:
        pass
    else:
        raise RuntimeError('Initial native phase did not interrupt the missing-receipt window')
    nonce, resume, binding, recorded = guest.parse_recorded_guest_invocation(sys.argv[1:])
    if resume is not None or not recorded or binding is None:
        raise RuntimeError('Original complete owned boot and recorded helpers required')
    guest.verify_owned_binding(binding)
    marker, fence = read_pending()
    if marker.get('bootId') != binding.bootId or marker.get('user') != os.getuid():
        raise RuntimeError('Interrupted action differs from original boot or user')
    guest.REPORT['packageEffectsAfterInterruption'] = exact_packages()
    after_install = guest.snapshot()
    if after_install['groups'] != guest.REPORT['baseline']['groups']:
        raise RuntimeError('Initial installation changed ordinary account groups')
    guest.verify_owned_binding(binding)
    retained_before_inspector = state_snapshot(marker)
    inspector_source = qualified_source(ROOT / 'fleur-native-inspector-conformance.ts', SOURCE['files']['fleur-native-inspector-conformance.ts'])
    code, text, _ = guest.run([guest.BUN, '--config=/dev/null', '--no-env-file', '--no-macros', '--no-install', '-e', inspector_source.decode(), '--',
                               'owned-inspector-conformance', str(Path(guest.CLI).parent.parent), binding.nonce, binding.bootId, str(binding.uid), binding.manifestSha256], timeout=guest.budget_seconds(105), allowed=(0, 5))
    inspector = json.loads(text)
    expected_factory_sha = hashlib.sha256((Path(guest.CLI).parent.parent / 'src/setup/apt-auxiliary.ts').read_bytes()).hexdigest()
    expected_cases = ['empty', 'nonempty', 'inode', 'link', 'account-digest', 'parent-start', 'descriptor', 'lost-completion', 'lost-completion-negative-control']
    if (code != 0 or inspector.get('formatVersion') != 1 or inspector.get('scope') != 'owned-native-apt-inspector-conformance' or inspector.get('ok') is not True
            or inspector.get('sourceSha256') != expected_factory_sha or not re.fullmatch(r'[a-f0-9]{64}', inspector.get('inspectorSha256', ''))
            or inspector.get('runtimeAdmission') is not False or inspector.get('humanConsentProof') is not False or inspector.get('fixturesRetainedForVmDisposal') is not True
            or [case.get('case') for case in inspector.get('cases', [])] != expected_cases
            or tuple(inspector.get('ownedGuestCustody', {}).get(key) for key in ('nonce', 'bootId', 'uid', 'manifestSha256')) != tuple(binding)):
        raise RuntimeError('Actual source-owned read-only inspector conformance failed: ' + text[-2048:])
    guest.verify_owned_binding(binding)
    if state_snapshot(marker) != retained_before_inspector or read_pending()[1] != fence or guest.snapshot() != after_install:
        raise RuntimeError('Inspector conformance altered original product, package, service, source or group state')
    guest.REPORT['inspectorConformance'] = inspector
    guest.capture_signed_indexes()
    guest.REPORT['initialEffectsPreservation'] = {'baselinePackagesPreserved': True, 'exactEightAdditions': True, 'ordinarySessionGroupsPreserved': True}
    # Observe all previously seen process identities, including sudo monitors.
    originals = guest.REPORT['interruption']['observedDescendants']
    deadline = time.monotonic() + guest.budget_seconds(10)
    while True:
        table = process_table()
        live = [row for row in originals if row['pid'] in table and same_process(row, table[row['pid']]) and table[row['pid']]['state'] not in ('Z', 'X')]
        if not live:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError('Previously observed privileged installation work remains live')
        time.sleep(0.02)
    preservation.observe('original', 'afterInterruptedInstall', binding)
    before = state_snapshot(marker)
    doctor = guest.command_json('doctor')
    setup = guest.command_json('setup')
    for outcome in (doctor, setup):
        if outcome['exitCode'] != 5 or outcome['result'].get('ok') is not False or guest.object_field(outcome['result'], 'error').get('code') != 'RECOVERY_REQUIRED':
            raise RuntimeError('Same-boot public command bypassed unresolved native installation')
    if state_snapshot(marker) != before or read_pending()[1] != fence:
        raise RuntimeError('Same-boot reprobes changed retained evidence or authority')
    preservation.observe('original', 'cleanup', binding)
    original_manifest = Path('/etc/fleur-owned-guest.json').read_bytes()
    if hashlib.sha256(original_manifest).hexdigest() != binding.manifestSha256:
        raise RuntimeError('Original root boot manifest changed')
    guest.REPORT.update({'qualificationScope': 'interrupted-native-apt', 'phase': 'reboot-required',
                         'sameBootDoctor': doctor, 'sameBootSetup': setup,
                         'afterInterruptedSetup': guest.snapshot(), 'retainedStateBeforeReboot': before})
    machine_sha = hashlib.sha256(Path('/etc/machine-id').read_bytes()).hexdigest()
    guest.REPORT['interruptionRebootPlan'] = {'nonce': nonce, 'originalBootId': binding.bootId, 'uid': binding.uid, 'originalManifestSha256': binding.manifestSha256, 'machineSha256': machine_sha}
    payload = {'formatVersion': 1, 'scope': 'debian13-interrupted-native-apt-checkpoint',
               'sourceCommit': SOURCE['sourceCommit'], 'qualificationSourceSha256': SOURCE_SHA, 'nonce': nonce,
               'originalBinding': binding._asdict(), 'originalManifestSha256': binding.manifestSha256,
               'machineSha256': machine_sha,
               'artifacts': guest.handoff_artifacts(), 'helperSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'evidence': guest.REPORT}
    body = json.dumps(payload, separators=(',', ':')).encode()
    path = ROOT / 'interrupted-setup-checkpoint.json'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        offset = 0
        while offset < len(body):
            count = os.write(fd, body[offset:])
            if count <= 0:
                raise RuntimeError('Checkpoint publication made no progress')
            offset += count
        os.fsync(fd)
    finally:
        os.close(fd)
    parent = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    guest.REPORT['interruptionCheckpointSha256'] = hashlib.sha256(body).hexdigest()


def read_checkpoint_record(path, maximum, uid, mode):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != uid or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != mode or not 0 < before.st_size <= maximum:
            raise RuntimeError('Unsafe bounded recovery checkpoint record')
        chunks = []
        count = 0
        while True:
            guest.budget_seconds(1)
            part = os.read(fd, min(65536, before.st_size + 1 - count))
            if not part:
                break
            chunks.append(part)
            count += len(part)
            if count > before.st_size:
                raise RuntimeError('Recovery checkpoint record grew')
        if count != before.st_size or guest.file_identity(os.fstat(fd)) != guest.file_identity(before) or guest.file_identity(Path(path).lstat()) != guest.file_identity(before):
            raise RuntimeError('Recovery checkpoint descriptor/name custody changed')
        body = b''.join(chunks)
        return json.loads(body), hashlib.sha256(body).hexdigest(), {'dev': str(before.st_dev), 'ino': str(before.st_ino)}
    finally:
        os.close(fd)



def access_checkpoint_deadline(expected_digest, budget):
    if type(budget) not in (int, float) or not math.isfinite(budget) or not 1 <= budget <= 900:
        raise RuntimeError('Unexpired original host phase budget required')
    if type(expected_digest) is not str or not re.fullmatch(r'[a-f0-9]{64}', expected_digest):
        raise RuntimeError('Exact fresh-login checkpoint digest required')
    payload, actual, _identity = read_checkpoint_record(ROOT / 'fresh-linux-state.json', 2 * 1024 * 1024, os.getuid(), 0o600)
    deadline = payload.get('guestDeadlineMonotonic')
    if actual != expected_digest or type(deadline) not in (int, float) or not math.isfinite(deadline) or not time.monotonic() < deadline <= time.monotonic() + 900:
        raise RuntimeError('Original same-boot access checkpoint deadline is invalid')
    return deadline


def exact_record(actual, expected):
    if type(actual) is not dict or set(actual) != set(expected) or any(type(actual[key]) is not type(value) or actual[key] != value for key, value in expected.items()):
        raise RuntimeError('Closed evidence record differs from its original bindings')


def validate_transition_receipt(receipt, original, binding, machine_sha, archived_identity):
    expected = {'formatVersion': 1, 'scope': 'owned-guest-explicit-reboot-transition', 'ok': True,
                'nonce': original['nonce'], 'uid': binding.uid, 'originalBootId': original['bootId'],
                'currentBootId': binding.bootId, 'originalManifestSha256': original['manifestSha256'],
                'currentManifestSha256': binding.manifestSha256, 'originalManifestIdentity': archived_identity,
                'machineSha256': machine_sha,
                'producerSha256': 'aeab923bf41a4c830ed4752e3501b36262896c25eb4cff118fff9709f81bafc3',
                'helperSha256': SOURCE['files']['fleur-transition-owned-reboot.py'],
                'runtimeAdmission': False, 'humanConsentProof': False, 'historicalTransactionOutcome': 'unknown'}
    exact_record(receipt, expected)
    if type(receipt['originalManifestIdentity']) is not dict or set(receipt['originalManifestIdentity']) != {'dev', 'ino'} or any(type(value) is not str or not re.fullmatch(r'[0-9]+', value) for value in receipt['originalManifestIdentity'].values()):
        raise RuntimeError('Original archived manifest identity is malformed')


def validate_product_receipt(receipt, marker, fence, original_boot, current_boot, inspection_plan=None, authorization=None, conformance=None):
    expected = {'formatVersion': 1, 'operationId': marker['operationId'], 'pendingSha256': fence['sha256'],
                'machine': marker['machine'], 'user': marker['user'], 'checksum': marker['checksum'],
                'originalBootId': original_boot, 'reconciledBootId': current_boot,
                'historicalOutcome': 'unknown', 'artifacts': 'retained'}
    if inspection_plan is None:
        exact_record(receipt, expected)
    else:
        if type(receipt) is not dict or set(receipt) != set(expected) | {'inspection'}:
            raise RuntimeError('Closed inspected-recovery receipt required')
        exact_record({key: value for key, value in receipt.items() if key != 'inspection'}, expected)
        validate_inspection_evidence(receipt['inspection'], marker, fence, current_boot, inspection_plan, authorization, conformance)



RECOVERY_HOST_OBSERVATION = r"""
import { constants } from 'node:fs';
import { lstat,open } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root,budgetText,bindingText]=process.argv.slice(1);
const budget=Number(budgetText), binding=JSON.parse(bindingText);
if (process.argv.length!==4 || !root.startsWith(process.env.HOME+'/lab/') || process.platform!=='linux' || process.arch!=='x64' || process.getuid()<=0 || !Number.isFinite(budget) || budget<=0 || budget>20000) throw Error('Fixed owned read-only observation required');
const deadline=performance.now()+budget;
const remaining=()=>Math.max(0,Math.floor(deadline-performance.now()));
const {productionHost}=await import(pathToFileURL(join(root,'src/setup/host.ts')).href);
const {selectNativeProfile,nativeInstallProfiles}=await import(pathToFileURL(join(root,'src/setup/native.ts')).href);
const {aptHealthArgs,healthyDpkgSnapshot}=await import(pathToFileURL(join(root,'src/setup/apt-health.ts')).href);
const {canonicalAptSnapshot,aptPackageVersions}=await import(pathToFileURL(join(root,'src/setup/apt-dependencies.ts')).href);
const {aptServicePolicy}=await import(pathToFileURL(join(root,'src/setup/apt-service.ts')).href);
const host=productionHost(),identity=await host.host();
const profile=selectNativeProfile(identity,nativeInstallProfiles);
if (identity.system!=='linux' || identity.distribution!=='debian' || identity.release!=='13' || identity.architecture!=='x64' || identity.translated!==false || identity.bootId!==binding.bootId || process.getuid()!==binding.uid || profile?.method!=='docker-official-apt') throw Error('Current compiled Debian profile required');
const result={formatVersion:1,scope:'debian-recovery-readonly-host-observation',readOnly:true,binding,packageLockObservation:await host.aptPackageLocks(remaining()),lockFiles:{},kernelLocks:null,health:null,serviceProvenance:null};
for (const path of ['/var/lib/dpkg/lock','/var/lib/dpkg/lock-frontend','/var/lib/apt/lists/lock','/var/cache/apt/archives/lock','/','/var','/var/cache','/var/cache/apt','/var/cache/apt/archives']) {
 if (!remaining()) throw Error('Read-only observation deadline expired');
 try { const info=await lstat(path,{bigint:true});result.lockFiles[path]={regular:info.isFile()&&!info.isSymbolicLink(),directory:info.isDirectory()&&!info.isSymbolicLink(),dev:String(info.dev),ino:String(info.ino),uid:String(info.uid),gid:String(info.gid),mode:String(info.mode),nlink:String(info.nlink)}; }
 catch(error) { result.lockFiles[path]={errorCode:typeof error?.code==='string'?error.code.slice(0,32):'UNKNOWN'}; }
}
const kernel=await open('/proc/locks',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
try {
 const info=await kernel.stat();if(!info.isFile()||info.uid!==0)throw Error('Unprotected kernel lock observation');
 const bytes=Buffer.alloc(2097153);let used=0;
 while(used<bytes.length){if(!remaining())throw Error('Kernel lock observation deadline expired');const part=await kernel.read(bytes,used,bytes.length-used,used);if(!part.bytesRead)break;used+=part.bytesRead;}
 if(used>2097152)throw Error('Kernel lock observation exceeded bound');
 result.kernelLocks={bytes:used,sha256:Bun.CryptoHasher.hash('sha256',bytes.subarray(0,used),'hex'),prefix:bytes.subarray(0,Math.min(used,16384)).toString('utf8'),prefixTruncated:used>16384};
} finally {await kernel.close();}
const health=await host.run(aptHealthArgs,remaining(),{outputLimitBytes:2097152});
const snapshot=health.status==='completed'&&health.exitCode===0&&!health.terminationUnconfirmed?canonicalAptSnapshot(profile.distroDependencies,healthyDpkgSnapshot(health.stdout)):null;
result.health={status:health.status,exitCode:health.exitCode??null,terminationUnconfirmed:health.terminationUnconfirmed===true,stdoutBytes:Buffer.byteLength(health.stdout),stdoutSha256:Bun.CryptoHasher.hash('sha256',health.stdout,'hex'),parsed:snapshot!==null,rows:snapshot?.size??null,expectedPackages:Object.fromEntries(Object.keys(aptPackageVersions(profile)).map(name=>[name,snapshot?.get(name)??null]))};
try {await aptServicePolicy(profile).provenance(host,remaining);result.serviceProvenance={verified:true};}
catch(error){result.serviceProvenance={verified:false,error:typeof error?.message==='string'?error.message.slice(0,512):'unavailable'};}
if(!remaining())throw Error('Read-only observation deadline expired');
console.log(JSON.stringify(result));
"""


def observe_recovery_host(label, binding):
    if label not in ('beforeReconciliation', 'afterReconciliationRefusal'):
        raise RuntimeError('Fixed read-only reconciliation observation phase required')
    deadline = time.monotonic() + guest.budget_seconds(20)
    guest.verify_owned_binding(binding, absolute_deadline=deadline)
    budget_ms = min(20000, int((deadline - time.monotonic()) * 1000))
    _, text, _ = guest.run([guest.BUN, '--config=/dev/null', '--no-env-file', '--no-macros', '--no-install', '-e',
        RECOVERY_HOST_OBSERVATION, '--', str(Path(guest.CLI).parent.parent), str(budget_ms), json.dumps(binding._asdict())],
        timeout=20, absolute_deadline=deadline)
    if len(text.encode()) > 65536:
        raise RuntimeError('Read-only recovery host observation exceeded bound')
    observation = json.loads(text, object_pairs_hook=bridge.unique_object)
    if (type(observation) is not dict or observation.get('formatVersion') != 1
        or observation.get('scope') != 'debian-recovery-readonly-host-observation' or observation.get('readOnly') is not True
        or observation.get('binding') != binding._asdict()):
        raise RuntimeError('Read-only recovery host observation lost original binding')
    guest.verify_owned_binding(binding, absolute_deadline=deadline)
    records = guest.REPORT.setdefault('recoveryHostObservations', {})
    if label in records:
        raise RuntimeError('Read-only recovery observation phase already recorded')
    records[label] = observation


def resume_phase():
    if len(sys.argv) < 6 or sys.argv[1] != '--resume-interruption' or not re.fullmatch(r'[a-f0-9]{64}', sys.argv[2]):
        raise RuntimeError('Explicit original interruption checkpoint digest required')
    digest = sys.argv[2]
    transition_digest = sys.argv[4]
    if not re.fullmatch(r'[a-f0-9]{64}', transition_digest):
        raise RuntimeError('Authenticated host-held root transition digest required')
    budget = float(sys.argv[3])
    if not 1 <= budget <= 900:
        raise RuntimeError('Unexpired bounded original host phase budget required')
    # The host separately enforces its original aggregate monotonic deadline;
    # this budget must be its remaining time, never a reset of the old phase.
    guest.GUEST_DEADLINE = time.monotonic() + budget
    sys.argv = [sys.argv[0], *sys.argv[5:]]
    nonce, old_resume, binding, recorded = guest.parse_recorded_guest_invocation(sys.argv[1:])
    if old_resume is not None or binding is None or not recorded or os.getuid() == 0:
        raise RuntimeError('New ordinary current-boot binding and recorded helpers required')
    payload, actual, _checkpoint_identity = read_checkpoint_record(ROOT / 'interrupted-setup-checkpoint.json', 2 * 1024 * 1024, os.getuid(), 0o600)
    if actual != digest or set(payload) != {'formatVersion', 'scope', 'sourceCommit', 'qualificationSourceSha256', 'nonce', 'originalBinding', 'originalManifestSha256', 'machineSha256', 'artifacts', 'helperSha256', 'evidence'} or type(payload['formatVersion']) is not int or payload['formatVersion'] != 1 or payload['scope'] != 'debian13-interrupted-native-apt-checkpoint' or payload['nonce'] != nonce or payload['sourceCommit'] != SOURCE['sourceCommit'] or payload['qualificationSourceSha256'] != SOURCE_SHA:
        raise RuntimeError('Original interruption checkpoint source or scope differs')
    original = payload['originalBinding']
    if set(original) != set(guest.OwnedGuestBinding._fields) or original['nonce'] != nonce or original['uid'] != binding.uid or original['bootId'] == binding.bootId or original['manifestSha256'] != payload['originalManifestSha256']:
        raise RuntimeError('Reboot must change only the original kernel binding')
    evidence = payload['evidence']
    if evidence.get('formatVersion') != 1 or evidence.get('phase') != 'reboot-required' or evidence.get('ok') is not False or evidence.get('humanConsentProof') is not False or evidence.get('runtimeSupport') != 'unverified' or 'error' in evidence or evidence.get('interruption', {}).get('subreaperDescendantsRetired') is not True:
        raise RuntimeError('Original interruption evidence is incomplete')
    if payload['helperSha256'] != hashlib.sha256(Path(__file__).read_bytes()).hexdigest() or payload['machineSha256'] != hashlib.sha256(Path('/etc/machine-id').read_bytes()).hexdigest():
        raise RuntimeError('Helper or original machine identity changed')
    receipt, _receipt_sha, _transition_identity = read_checkpoint_record(Path('/etc') / ('fleur-owned-reboot-' + nonce) / 'transition.json', 65536, 0, 0o444)
    if _receipt_sha != transition_digest:
        raise RuntimeError('Root transition receipt differs from the original authenticated host observation')
    original_manifest, original_sha, archived_identity = read_checkpoint_record(Path('/etc') / ('fleur-owned-reboot-' + nonce) / 'original.json', 2048, 0, 0o444)
    if original_sha != original['manifestSha256'] or original_manifest.get('bootId') != original['bootId'] or original_manifest.get('nonce') != nonce or original_manifest.get('uid') != binding.uid:
        raise RuntimeError('Original root boot manifest was not preserved')
    validate_transition_receipt(receipt, original, binding, payload['machineSha256'], archived_identity)
    guest.REPORT.clear()
    guest.REPORT.update(evidence)
    guest.REPORT.pop('phase', None)
    guest.verify_owned_binding(binding)
    preservation.observe('current', 'beforeReconciliation', binding)
    guest.RECORDED_HELPERS = True
    guest.verify_guest_candidate_target(binding)
    if guest.handoff_artifacts() != payload['artifacts']:
        raise RuntimeError('Original packed source or helper inputs changed across reboot')
    guest.REPORT['explicitRebootTransition'] = receipt
    guest.REPORT['interruptionCheckpointSha256'] = digest
    marker, fence = read_pending()
    if marker.get('bootId') != original['bootId'] or fence != guest.REPORT['interruption']['originalFence']:
        raise RuntimeError('Original unresolved product fence changed across reboot')
    before = state_snapshot(marker)
    if before != guest.REPORT['retainedStateBeforeReboot']:
        raise RuntimeError('Product evidence or authority changed across reboot')
    guest.REPORT['packagesAfterReboot'] = exact_packages()
    observe_recovery_host('beforeReconciliation', binding)
    guest.REPORT['doctorBeforeReconciliation'] = guest.command_json('doctor')
    if guest.REPORT['doctorBeforeReconciliation']['exitCode'] != 5 or guest.object_field(guest.REPORT['doctorBeforeReconciliation']['result'], 'error').get('code') != 'RECOVERY_REQUIRED':
        raise RuntimeError('Doctor bypassed unresolved original installation after reboot')
    guest.REPORT['automaticRecovery'] = guest.command_json('setup')
    recovered = guest.REPORT['automaticRecovery']
    if recovered['exitCode'] == 5:
        observe_recovery_host('afterReconciliationRefusal', binding)
        if state_snapshot(marker) != before:
            raise RuntimeError('Refused automatic recovery changed original product evidence')
        guest.REPORT['phase'] = 'manual-recovery-required'
        guest.REPORT['automaticRecoveryQualified'] = False
        guest.REPORT['assistedRecoveryQualified'] = False
        guest.REPORT['error'] = {'code': 'AUTOMATIC_RECOVERY_INCOMPLETE', 'message': 'Native recovery remained blocked; preserve evidence and inspect current artifact/authority state. No fixture administrator restoration was performed.'}
        return
    if recovered['exitCode'] != 3 or recovered['result'].get('error', {}).get('code') != 'AUTHORITY_REQUIRED' or state_snapshot(marker) != before:
        raise RuntimeError('Native ownership transition did not retain its separate read-only inspection authority boundary')
    data = guest.command_data(recovered['result'])
    plan = data.get('plan')
    if (type(plan) is not dict or set(plan) != {'action', 'method', 'target', 'checksum'}
            or plan['action'] != 'recovery-inspect' or plan['method'] != 'docker-official-apt'
            or plan['target'] != 'Read-only retained APT evidence for operation ' + marker['operationId']
            or not re.fullmatch(r'[a-f0-9]{64}', plan['checksum']) or plan['checksum'] in {lease['planChecksum'] for lease in marker['authority']}
            or data.get('resumable') is not True or data.get('grantsCreated') is not False):
        raise RuntimeError('Closed separate inspection authority plan differs from the original operation')
    state = Path.home() / '.local/state/fleur/setup'
    original_grants, _, _ = read_checkpoint_record(state / 'grants.json', 65536, os.getuid(), 0o600)
    if set(original_grants) != {'formatVersion', 'grants'} or type(original_grants['formatVersion']) is not int or original_grants['formatVersion'] != 1 or type(original_grants['grants']) is not list or any(grant.get('action') == 'recovery-inspect' for grant in original_grants['grants']):
        raise RuntimeError('Original authority store is not an untouched initial installation store')
    guest.REPORT['inspectionFixtureAuthorization'] = inspection_pty(plan)
    try:
        (state / 'apt-transaction-pending.json').lstat()
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError('Separately inspected setup did not retire its original active fence')
    reconciliation, _, _ = read_checkpoint_record(state / ('apt-reconciled-' + marker['operationId'] + '.json'), 65536, os.getuid(), 0o600)
    validate_product_receipt(reconciliation, marker, fence, original['bootId'], binding.bootId,
                             plan, guest.REPORT['inspectionFixtureAuthorization'], guest.REPORT['inspectorConformance'])
    current_grants, _, _ = read_checkpoint_record(state / 'grants.json', 65536, os.getuid(), 0o600)
    inspection_id = reconciliation['inspection']['grantId']
    new = [grant for grant in current_grants['grants'] if grant['id'] == inspection_id]
    if len(new) != 1:
        raise RuntimeError('Exactly one separately consumed inspection grant required')
    exact_record(new[0], {'id': inspection_id, 'action': 'recovery-inspect', 'method': 'docker-official-apt', 'target': plan['target'], 'planChecksum': plan['checksum'],
                          'machine': marker['machine'], 'user': os.getuid(), 'mode': 'once', 'revoked': True})
    historical = [grant for grant in current_grants['grants'] if grant['id'] != inspection_id]
    if set(current_grants) != {'formatVersion', 'grants'} or type(current_grants['formatVersion']) is not int or current_grants['formatVersion'] != 1 or json.dumps(historical, sort_keys=True) != json.dumps(original_grants['grants'], sort_keys=True):
        raise RuntimeError('Inspection restored or altered historical authority')
    # The marker is retired and the grant store legitimately gains exactly one
    # new consumed inspection grant. Every retained artifact stays unchanged.
    after = state_snapshot(marker, pending_required=False)
    if after['artifacts'] != before['artifacts'] or set(after['files']) != {'grants.json'}:
        raise RuntimeError('Inspected reconciliation changed retained artifacts or active marker state')
    guest.REPORT['reconciliationReceipt'] = reconciliation
    guest.REPORT['historicalGrantPreservation'] = {'unchanged': True, 'beforeCount': len(historical), 'afterCount': len(current_grants['grants']), 'newOnceInspectionRevoked': True}
    guest.REPORT['retainedStateAfterReconciliation'] = after
    guest.REPORT['automaticRecoveryQualified'] = False
    guest.REPORT['assistedRecoveryQualified'] = True
    guest.REPORT['recoveryQualification'] = 'separately-scoped-read-only-inspection'
    preservation.observe('current', 'afterInspection', binding)
    guest.REPORT['afterSetup'] = guest.snapshot()
    guest.REPORT['reprobe'] = guest.command_json('setup')
    guest.REPORT['ordinaryUserDoctor'] = guest.command_json('doctor')
    components = guest.object_field(guest.command_data(guest.REPORT['ordinaryUserDoctor']['result']), 'components')
    if guest.object_field(components, 'daemon').get('state') == 'denied':
        # This creates a new access checkpoint under the new explicit binding;
        # the old interruption checkpoint never acquires a new boot identity.
        guest.enrollment_handoff(nonce, binding)
        return
    if guest.object_field(components, 'daemon').get('state') != 'ready':
        raise RuntimeError('Reconciled current packages did not establish native daemon readiness')
    guest.finish_ready_guest(components, binding)

if __name__ == '__main__':
    try:
        if len(sys.argv) < 3 or sys.argv[-2] != '--qualification-source':
            raise RuntimeError('Host-held source qualification record required')
        SOURCE_SHA = sys.argv[-1]
        sys.argv = sys.argv[:-2]
        SOURCE = load_qualification_source(SOURCE_SHA)
        contract = load_module('debian_recovery_contract.py', 'debian_recovery_contract')
        bridge = load_module('debian-recovery-preservation.py', 'debian_recovery_preservation')
        preservation = bridge.RecoveryPreservation(guest, contract)
        guest.debian_dependency_preservation = preservation.product_boundary
        guest.REPORT['qualificationSource'] = {**SOURCE, 'sha256': SOURCE_SHA}
        if len(sys.argv) > 1 and sys.argv[1] == '--resume-access':
            if len(sys.argv) < 5 or not re.fullmatch(r'[a-f0-9]{64}', sys.argv[2]):
                raise RuntimeError('Exact access handoff checkpoint required')
            digest, budget = sys.argv[2], float(sys.argv[3])
            guest.GUEST_DEADLINE = access_checkpoint_deadline(digest, budget)
            nonce, resume, binding, recorded = guest.parse_recorded_guest_invocation(sys.argv[4:])
            if resume is not None or binding is None or not recorded or os.getuid() == 0 or Path('/proc/1/comm').read_text().strip() != 'systemd':
                raise RuntimeError('Ordinary owned fresh login required')
            guest.RECORDED_HELPERS = True
            guest.verify_owned_binding(binding)
            guest.resume_guest(nonce, digest, binding)
            if guest.REPORT.get('qualificationSource', {}).get('sha256') != SOURCE_SHA:
                raise RuntimeError('Access handoff changed original source binding')
        elif len(sys.argv) > 1 and sys.argv[1] == "--resume-interruption":
            resume_phase()
        else:
            initial_phase()
    except Exception as error:
        guest.REPORT['ok'] = False
        guest.REPORT['error'] = {'code': 'INTERRUPTION_QUALIFICATION_FAILED', 'message': str(error)}
    finally:
        print(json.dumps(guest.REPORT, separators=(',', ':')))
        sys.exit(0 if guest.REPORT.get('ok') is True else 3 if guest.REPORT.get('phase') in ('reboot-required', 'new-login-required') and 'error' not in guest.REPORT else 4)

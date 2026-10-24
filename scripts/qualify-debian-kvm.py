"""Fixed manual GitHub-hosted Debian 13 qualification. No release admission."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid

REPO = Path(__file__).resolve().parent.parent
SERVICE_FIELDS = ('LoadState', 'ActiveState', 'SubState', 'InvocationID', 'ControlGroup', 'MainPID',
                  'User', 'Group', 'KillMode', 'Delegate', 'RuntimeMaxUSec', 'TimeoutStopUSec',
                  'Result', 'ExecMainCode', 'ExecMainStatus')
PINS = {
    'debian.qcow2': ('https://cloud.debian.org/images/cloud/trixie/20261017-2634/debian-13-genericcloud-amd64-20261017-2634.qcow2',
                     342818816, '87211f082e2983a1c2209a2626f9f6762073a92c6a63a8ce321608ca496c3b02'),
    'bun.zip': ('https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-x64.zip',
                160 * 1024 * 1024, '3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18'),
}


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError('Duplicate input field')
        result[name] = value
    return result


def decode_helpers(raw, pins):
    if not isinstance(raw, str) or len(raw) > 65535:
        raise ValueError('Helper payload unavailable or oversized')
    value = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(value, dict) or set(value) != {'filter.so', 'abuse'} or set(pins) != set(value):
        raise ValueError('Only the fixed helper pair is accepted')
    result = {}
    for name, pin in pins.items():
        encoded = value[name]
        if not isinstance(encoded, str) or len(encoded) != 4 * ((pin['bytes'] + 2) // 3):
            raise ValueError('Helper encoded size differs')
        data = base64.b64decode(encoded, validate=True)
        if base64.b64encode(data).decode('ascii') != encoded or len(data) != pin['bytes'] or hashlib.sha256(data).hexdigest() != pin['sha256']:
            raise ValueError('Helper identity differs')
        result[name] = data
    return result


def accepted_kvm_probe(value):
    return (value.get('system') == 'Linux' and value.get('architecture') == 'x86_64'
            and value.get('effectiveRoot') is False
            and value.get('kvm') == {'apiVersion': 12, 'device': 'observed', 'characterDevice': True})


def admit_runner_image(manifest, actual):
    records = manifest.get('runnerImages')
    if not isinstance(records, list) or not 1 <= len(records) <= 8:
        raise ValueError('Reviewed host image records unavailable')
    versions = set()
    for record in records:
        if (not isinstance(record, dict) or set(record) != {'version', 'inventorySourceCommit', 'inventoryRunId', 'inventoryRunAttempt', 'inventoryReportSha256'}
                or not isinstance(record['version'], str) or not re.fullmatch(r'[0-9]{8}\.[0-9]{1,6}\.[0-9]{1,3}', record['version'])
                or record['version'] in versions or not isinstance(record['inventorySourceCommit'], str) or not re.fullmatch('[a-f0-9]{40}', record['inventorySourceCommit'])
                or not isinstance(record['inventoryRunId'], str) or not re.fullmatch('[0-9]{1,20}', record['inventoryRunId'])
                or type(record['inventoryRunAttempt']) is not int or not 1 <= record['inventoryRunAttempt'] <= 1000
                or not isinstance(record['inventoryReportSha256'], str) or not re.fullmatch('[a-f0-9]{64}', record['inventoryReportSha256'])):
            raise ValueError('Reviewed host image record differs')
        versions.add(record['version'])
    if not isinstance(actual, str) or actual not in versions:
        raise ValueError('Hosted image changed; tool transaction requires review')
    return dict(next(record for record in records if record['version'] == actual))


def admitted_ordinary_round(observed, command):
    if not isinstance(observed, dict) or type(observed.get('exitCode')) is not int or observed['exitCode'] != 0:
        return False
    envelope = observed.get('result')
    if (not isinstance(envelope, dict) or set(envelope) != {'formatVersion', 'command', 'ok', 'data', 'error', 'truncated'}
            or type(envelope['formatVersion']) is not int or envelope['formatVersion'] != 1 or envelope['command'] != command
            or envelope['ok'] is not True or envelope['error'] is not None or envelope['truncated'] is not False
            or not isinstance(envelope['data'], dict) or not isinstance(envelope['data'].get('components'), dict)):
        return False
    components = envelope['data']['components']
    evidence = '6b4066ed5c199006695d769d07ec5d813fa8cddff1d396a089e1749d6c27231e'
    return (all(isinstance(components.get(name), dict) and components[name].get('state') == 'ready' for name in ('cli', 'daemon', 'compose', 'smoke'))
            and components['smoke'].get('cleanup') is True
            and components.get('release') == {'state': 'verified', 'profile': 'debian-13-x64-docker-29.9.1',
                'evidence': {'readinessSha256': evidence, 'isolationSha256': evidence}})


def _accepted_guest(report, source, scope, preservation):
    if not isinstance(report, dict):
        return False
    guest = report.get('guest', {})
    candidate = report.get('candidate', {})
    catalog = '032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d'
    return (report.get('ok') is True and report.get('executed') is True
            and report.get('scope') == scope
            and report.get('installationEvidence') == 'verified-full-system-guest'
            and report.get('fixture', {}).get('id') == 'debian13-amd64'
            and report.get('fixture', {}).get('catalogSha256') == catalog
            and candidate.get('catalogSha256') == catalog
            and candidate.get('internalArtifact') is True
            and report.get('executionArtifact', {}).get('kind') == 'ordinary'
            and guest.get('executionArtifact', {}).get('kind') == 'ordinary'
            and guest.get('executionArtifact', {}).get('packageName') == 'fleur'
            and guest.get('executionArtifact', {}).get('artifactCatalogSha256') == catalog
            and report.get('executionArtifact', {}).get('sha256') == candidate.get('ordinary', {}).get('sha256')
            and re.fullmatch('[a-f0-9]{64}', candidate.get('ordinary', {}).get('sha256', '')) is not None
            and report.get('restrictionSource', {}).get('commit') == source
            and report.get('accelerator') == 'kvm' and report.get('boot', {}).get('accelerator') == 'kvm'
            and report.get('capabilities', {}).get('architecture') == 'x64'
            and report.get('ownedGuestCustody', {}).get('fixtureCustodyValidated') is True
            and guest.get('ok') is True and len(guest.get('runs', [])) == 2
            and all(admitted_ordinary_round(observed, 'doctor') for observed in guest['runs'])
            and len(guest.get('readySetupReprobes', [])) == 2
            and all(admitted_ordinary_round(observed, 'setup') and observed.get('snapshotPreserved') is True and observed.get('grantsPreserved') is True for observed in guest['readySetupReprobes'])
            and preservation
            and guest.get('installationEvidence') == 'verified-full-system-guest'
            and guest.get('sentinelCleanup') is True
            and guest.get('restrictionProbe', {}).get('exitCode') == 0
            and guest.get('restrictionProbe', {}).get('result', {}).get('bounded_probe_passed') is True
            and guest.get('restrictionProbe', {}).get('result', {}).get('cleanup_complete') is True
            and type(report.get('cleanup')) is dict
            and set(report['cleanup']) == {'ownedVmReaped','credentialsRemoved'}
            and all(report['cleanup'][key] is True for key in ('ownedVmReaped','credentialsRemoved'))
            and report.get('artifactDisposal', {}).get('complete') is True
            and report.get('humanConsentProof') is False)


def accepted_guest(report, source):
    if not isinstance(report, dict):
        return False
    preservation = report.get('guest', {}).get('debianDependencyPreservation', {})
    return _accepted_guest(report, source, 'fresh-full-system-guest',
        preservation.get('backend') == 'nf_tables' and preservation.get('cleanup') is True
        and set(preservation.get('observations', {})) == {'before', 'afterInstall', 'freshLogin', 'afterRuntime'})


def accepted_recovery_guest(report, source):
    try:
        if not isinstance(report, dict) or not re.fullmatch('[a-f0-9]{40}', source):
            return False
        guest, record, reboot = report['guest'], report['qualificationSource'], report['interruptionReboot']
        names = {'fresh-linux-guest.py','fleur-interrupted-guest.py','fleur-transition-owned-reboot.py',
                 'fleur-interruption-supervisor-selftest.py','fleur-native-inspector-conformance.ts',
                 'debian_recovery_contract.py','debian-recovery-preservation.py'}
        if (type(record) is not dict or set(record) != {'formatVersion','scope','sourceCommit','ordinaryArchiveSha256','files','sha256'}
                or type(record['formatVersion']) is not int or record['formatVersion'] != 1
                or record['scope'] != 'source-owned-debian-interruption-inputs' or record['sourceCommit'] != source
                or record != guest['qualificationSource'] or record['ordinaryArchiveSha256'] != report['executionArtifact']['sha256']
                or not re.fullmatch('[a-f0-9]{64}', record['ordinaryArchiveSha256'])
                or type(record['files']) is not dict or set(record['files']) != names
                or any(type(value) is not str or not re.fullmatch('[a-f0-9]{64}', value) for value in record['files'].values())
                or hashlib.sha256(json.dumps({key:value for key,value in record.items() if key != 'sha256'},separators=(',',':')).encode()).hexdigest() != record['sha256']
                or guest.get('assistedRecoveryQualified') is not True or guest.get('automaticRecoveryQualified') is not False
                or guest.get('recoveryQualification') != 'separately-scoped-read-only-inspection'):
            return False
        old, current, transition = reboot['originalBinding'], reboot['renewedBinding'], reboot['transition']
        if (any(reboot[key] is not True for key in ('sameContinuouslyHeldQmp','samePinnedSshHostKey','sameOwnedVmProcess'))
                or any(type(reboot[key]) is not dict or set(reboot[key]) != {'sameName','running','sameOverlay'}
                       or any(value is not True for value in reboot[key].values()) for key in ('qmpBefore','qmpAfter'))
                or reboot['beforeOverlay'] != reboot['afterOverlay'] or set(reboot['beforeOverlay']) != {'dev','ino'}
                or any(type(value) is not str or not re.fullmatch('[0-9]{1,24}',value) for value in reboot['beforeOverlay'].values())
                or int(reboot['beforeOverlay']['ino']) <= 0
                or any(transition[key] != value for key,value in {
                    'originalBootId':old['bootId'],'currentBootId':current['bootId'],
                    'originalManifestSha256':old['manifestSha256'],'currentManifestSha256':current['manifestSha256'],
                    'nonce':old['nonce'],'uid':old['uid'],'historicalTransactionOutcome':'unknown',
                    'helperSha256':record['files']['fleur-transition-owned-reboot.py']}.items())
                or transition['runtimeAdmission'] is not False or transition['humanConsentProof'] is not False):
            return False
        spec = importlib.util.spec_from_file_location('fixed_debian_recovery_contract',REPO / 'scripts/debian_recovery_contract.py')
        contract = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(contract)
        contract.validate_two_boot_preservation(old,current,guest['debianRecoveryPreservation'])
        return _accepted_guest(report,source,'debian-interrupted-full-system-guest',True)
    except (KeyError,TypeError,ValueError,AttributeError):
        return False


def qualification_mode(inputs):
    if type(inputs) is not dict or set(inputs) - {'debian_helpers','debian_recovery'}:
        raise ValueError('Unexpected manual inputs')
    value = inputs.get('debian_recovery',False)
    if type(value) is bool:
        recovery = value
    elif type(value) is str and value in ('true','false'):
        recovery = value == 'true'
    else:
        raise ValueError('Canonical recovery selector required')
    if recovery and (type(inputs.get('debian_helpers')) is not str or not inputs['debian_helpers']):
        raise ValueError('Recovery requires the exact recorded helper pair')
    return recovery


def validate_tool_plan(text, manifest):
    proposed, configured = {}, {}
    for line in text.splitlines():
        if line.startswith(('Remv ', 'Purg ')):
            raise ValueError('Host test-tool removal refused')
        if line.startswith(('Inst ', 'Conf ')):
            match = re.fullmatch(r'(Inst|Conf) ([a-z0-9+.-]+) \(([^ ]+) Ubuntu:24.04/(noble(?:-updates)?) \[(amd64|all)\]\)', line)
            if not match:
                raise ValueError('Host test-tool transaction is not the reviewed new-package plan')
            target = proposed if match[1] == 'Inst' else configured
            if match[2] in target:
                raise ValueError('Duplicate host test-tool action')
            target[match[2]] = {'version': match[3], 'suite': match[4], 'architecture': match[5]}
    expected = {entry['name']: {key: entry[key] for key in ('version', 'suite', 'architecture')} for entry in manifest['packages']}
    summary = r'0 upgraded, ' + str(len(expected)) + r' newly installed, 0 to remove and \d+ not upgraded\.'
    if proposed != expected or configured != expected or not any(re.fullmatch(summary, line) for line in text.splitlines()):
        raise ValueError('Host test-tool transaction differs from the frozen inventory')
    return proposed


def package_snapshot():
    data = run(['/usr/bin/dpkg-query', '--show', '--showformat=${binary:Package}\\t${Version}\\t${Architecture}\\t${db:Status-Status}\\t${db:Status-Eflag}\\n']).stdout.decode()
    result = {}
    for line in data.splitlines():
        fields = line.split('\t')
        if len(fields) != 5 or not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*(?::[a-z0-9_-]+)?', fields[0]) or fields[0] in result:
            raise ValueError('Host package inventory malformed')
        result[fields[0]] = dict(zip(('version', 'architecture', 'status', 'error'), fields[1:]))
    if not result:
        raise ValueError('Host package inventory missing')
    return result


def validate_tool_baseline(snapshot, manifest):
    names = {entry['name'] for entry in manifest['packages']}
    seen = set()
    for name, row in snapshot.items():
        base, *qualifier = name.split(':')
        if base not in names:
            continue
        if base in seen or qualifier and qualifier != ['amd64']:
            raise ValueError('Host tool baseline has duplicate or foreign identities')
        seen.add(base)
        if row != {'version': '', 'architecture': '', 'status': 'not-installed', 'error': 'ok'}:
            raise ValueError('Host tools were not absent at baseline')


def validate_package_delta(before, after, manifest):
    expected = {entry['name']: {'version': entry['version'], 'architecture': entry['architecture'], 'status': 'installed', 'error': 'ok'} for entry in manifest['packages']}
    def partition(snapshot):
        selected, unrelated = {}, {}
        for name, row in snapshot.items():
            base, *qualifier = name.split(':')
            if base in expected:
                if base in selected or qualifier and qualifier != ['amd64']:
                    raise ValueError('Host tool inventory has duplicate or foreign identities')
                selected[base] = row
            else:
                unrelated[name] = row
        return selected, unrelated
    validate_tool_baseline(before, manifest)
    prior, unchanged_before = partition(before)
    installed, unchanged_after = partition(after)
    if any(row != {'version': '', 'architecture': '', 'status': 'not-installed', 'error': 'ok'} for row in prior.values()):
        raise ValueError('Host tools were not absent at baseline')
    if installed != expected or unchanged_before != unchanged_after:
        raise ValueError('Actual host package delta differs from reviewed transaction')
    return {'exactAdditions': expected, 'otherPackagesUnchanged': True, 'beforeSha256': hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(), 'afterSha256': hashlib.sha256(json.dumps(after, sort_keys=True).encode()).hexdigest()}


def docker_snapshot():
    def docker(*args):
        return run(['docker', '--host', 'unix:///var/run/docker.sock', *args]).stdout.decode().strip()
    return {'server': json.loads(docker('version', '--format', '{{json .Server}}')),
            'id': docker('info', '--format', '{{.ID}}'),
            'services': run(['/usr/bin/systemctl', 'show', 'docker.service', 'containerd.service', '--property=Id,InvocationID,MainPID,ActiveState,SubState']).stdout.decode(),
            'containers': sorted(docker('ps', '--all', '--quiet', '--no-trunc').splitlines()),
            'images': sorted(set(docker('image', 'ls', '--all', '--quiet', '--no-trunc').splitlines())),
            'volumes': sorted(docker('volume', 'ls', '--quiet').splitlines())}


def bounded_capture(child, timeout, retire):
    limited = threading.Event()
    buffers = [bytearray(), bytearray()]
    def drain(stream, target):
        try:
            while True:
                data = stream.read(65536)
                if not data:
                    break
                room = 8 * 1024 * 1024 - len(target)
                target.extend(data[:max(0, room)])
                if len(data) > room:
                    limited.set()
        finally:
            stream.close()
    readers = [threading.Thread(target=drain, args=(stream, target), daemon=True)
               for stream, target in zip((child.stdout, child.stderr), buffers)]
    for reader in readers:
        reader.start()
    deadline = time.monotonic() + timeout
    cancelled = False
    try:
        while child.poll() is None or any(reader.is_alive() for reader in readers):
            if limited.is_set() or time.monotonic() >= deadline:
                cancelled = True
                retire()
                break
            time.sleep(.05)
    except KeyboardInterrupt:
        cancelled = True
        retire()
    code = child.wait(timeout=55)
    for reader in readers:
        reader.join(timeout=5)
    if any(reader.is_alive() for reader in readers):
        raise RuntimeError('Command pipes did not retire')
    return code, bytes(buffers[0]), bytes(buffers[1]), cancelled, limited.is_set()


def run(args, timeout=30, allowed=(0,)):
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True)
    def retire():
        # These direct commands are read-only queries or fixed systemd control.
        # Privileged package transactions run inside a separately bound service.
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
    code, out, error, cancelled, limited = bounded_capture(child, timeout, retire)
    if cancelled or limited or code not in allowed:
        failure = RuntimeError('Fixed host command failed: ' + Path(args[0]).name)
        failure.diagnostic = {'executable': Path(args[0]).name, 'exitCode': code, 'cancelled': cancelled, 'outputLimited': limited, 'stderr': error.decode(errors='replace')[-2048:]}
        raise failure
    return subprocess.CompletedProcess(args, code, out, error)


def service_state(unit):
    result = run(['sudo', '-n', '/usr/bin/systemctl', 'show', unit,
                  '--property=' + ','.join(SERVICE_FIELDS)], allowed=(0, 1))
    pairs = [line.split('=', 1) for line in result.stdout.decode().splitlines()]
    if any(len(pair) != 2 or pair[0] not in SERVICE_FIELDS for pair in pairs):
        raise RuntimeError('Service metadata malformed')
    value = unique_object(pairs)
    absent = (value.get('LoadState') == 'not-found' and value.get('ActiveState') == 'inactive'
              and value.get('SubState') == 'dead' and value.get('MainPID', '0') == '0'
              and value.get('ControlGroup', '') == '' and value.get('InvocationID', '') in ('', '0' * 32))
    if result.returncode != 0 and not absent or not value.get('LoadState') or value.get('LoadState') == 'not-found' and not absent:
        raise RuntimeError('Service state unavailable')
    return value


def binding_failure(current, fields):
    """Fixed metadata only; never include command, environment or caller text."""
    enums = {'LoadState': {'loaded', 'not-found', 'masked', 'error', 'bad-setting', 'merged', 'stub'},
             'ActiveState': {'active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating', 'maintenance', 'refreshing'},
             'SubState': {'dead', 'start-pre', 'start', 'start-post', 'running', 'exited', 'reload', 'reload-signal', 'reload-notify', 'stop', 'stop-watchdog', 'stop-sigterm', 'stop-sigkill', 'stop-post', 'final-watchdog', 'final-sigterm', 'final-sigkill', 'failed', 'auto-restart', 'auto-restart-queued', 'cleaning'},
             'KillMode': {'control-group', 'mixed', 'process', 'none'}, 'Delegate': {'yes', 'no'},
             'Result': {'success', 'resources', 'timeout', 'exit-code', 'signal', 'core-dump', 'watchdog', 'start-limit-hit', 'oom-kill', 'exec-condition', 'protocol', 'assert', 'dependency', 'skip'}}
    observed = {}
    for name in SERVICE_FIELDS:
        value = current.get(name)
        if name in enums:
            observed[name] = value if isinstance(value, str) and value in enums[name] else 'invalid'
        elif name in ('MainPID', 'User', 'Group', 'ExecMainCode', 'ExecMainStatus'):
            observed[name] = int(value) if isinstance(value, str) and re.fullmatch(r'[0-9]{1,10}', value) else 'invalid'
        elif name == 'InvocationID':
            observed[name] = hashlib.sha256(value.encode()).hexdigest() if isinstance(value, str) and re.fullmatch('[a-f0-9]{32}', value) else 'invalid'
        elif name == 'ControlGroup':
            observed[name] = 'present' if isinstance(value, str) and re.fullmatch(r'/system.slice/fleur-debian-ci-[a-f0-9]{32}\.service', value) else 'invalid'
        else:
            observed[name] = value if isinstance(value, str) and re.fullmatch(r'[0-9]{1,8}(?:min|s)(?: [0-9]{1,8}s)?', value) else 'invalid'
    failure = RuntimeError('Service binding differs from fixed containment contract')
    failure.diagnostic = {'stage': 'service-start', 'mismatchedFields': fields, 'observed': observed}
    return failure


class Service:
    """Nonce service and retained initial cgroup identity; no process-name cleanup."""
    def __init__(self, root, uid, gid, command, environment, budget=1500):
        self.root, self.uid, self.gid = root, uid, gid
        self.unit = 'fleur-debian-ci-' + uuid.uuid4().hex + '.service'
        self.group = Path('/sys/fs/cgroup/system.slice') / self.unit
        self.bound = None
        self.child = None
        self.gate = root / ('gate-' + uuid.uuid4().hex)
        self.output = root / ('output-' + uuid.uuid4().hex)
        self.error = root / ('error-' + uuid.uuid4().hex)
        self.terminal = root / ('terminal-' + uuid.uuid4().hex)
        self.command, self.environment, self.budget = command, environment, budget
        self.cancelled = False
        self.stopRequested = False
        self.stopCommands = 0
        self.waited = False

    def launch(self, release=True):
        if service_state(self.unit).get('LoadState') != 'not-found' or self.group.exists():
            raise RuntimeError('Nonce service already exists or cannot be observed')
        args = ['sudo', '-n', '/usr/bin/systemd-run', '--quiet', '--wait', '--pipe', '--collect',
                '--unit=' + self.unit, '--service-type=exec', '--expand-environment=no',
                '--uid=' + str(self.uid), '--gid=' + str(self.gid), '--working-directory=' + str(REPO),
                '--property=Restart=no', '--property=Delegate=no', '--property=KillMode=control-group',
                '--property=SendSIGKILL=yes', '--property=KillSignal=SIGINT',
                '--property=RuntimeMaxSec=' + str(self.budget), '--property=TimeoutStopSec=45']
        stop_command = '/usr/bin/python3 -I ' + str(Path(__file__).resolve()) + ' --terminal-receipt ' + str(self.terminal)
        if not re.fullmatch(r'[A-Za-z0-9_./ -]+', stop_command):
            raise RuntimeError('Fixed stop receipt cannot be represented safely')
        args.append('--property=ExecStopPost=' + stop_command)
        for key, value in self.environment.items():
            args.append('--setenv=' + key + '=' + value)
        args += ['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--gated-child', str(self.gate), *self.command]
        self.out = self.output.open('xb', buffering=0)
        self.err = self.error.open('xb', buffering=0)
        self.child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 20
        current = {}
        while time.monotonic() < deadline:
            current = service_state(self.unit)
            if current.get('MainPID', '0') != '0':
                expected = {'LoadState': 'loaded', 'User': str(self.uid), 'Group': str(self.gid),
                            'KillMode': 'control-group', 'Delegate': 'no', 'TimeoutStopUSec': '45s',
                            'ControlGroup': '/system.slice/' + self.unit}
                mismatches = [name for name, value in expected.items() if current.get(name) != value]
                durations = {str(self.budget) + 's'}
                if self.budget % 60 == 0:
                    durations.add(str(self.budget // 60) + 'min')
                if current.get('RuntimeMaxUSec') not in durations:
                    mismatches.append('RuntimeMaxUSec')
                if not re.fullmatch('[a-f0-9]{32}', current.get('InvocationID', '')):
                    mismatches.append('InvocationID')
                if not re.fullmatch('[1-9][0-9]{0,9}', current.get('MainPID', '')):
                    mismatches.append('MainPID')
                if self.bound:
                    mismatches.extend(name for name in ('InvocationID', 'MainPID') if current.get(name) != self.bound[name])
                if mismatches:
                    raise binding_failure(current, mismatches)
                group_stat = self.group.lstat()
                if not stat.S_ISDIR(group_stat.st_mode) or group_stat.st_uid != 0 or self.group.is_symlink():
                    raise RuntimeError('Service cgroup is not root managed')
                pid = int(current['MainPID'])
                if Path('/proc', str(pid), 'cgroup').read_text().strip() != '0::/system.slice/' + self.unit:
                    raise RuntimeError('Initial child is outside bound cgroup')
                # Retain cleanup authority during Type=exec startup, but do not
                # release execution until that same invocation is fully active.
                if self.bound is None:
                    self.bound = current
                if current.get('ActiveState') == 'active':
                    if self.cancelled:
                        raise binding_failure(current, ['cancelled'])
                    if release:
                        with self.gate.open('xb'):
                            pass
                    return
                if current.get('ActiveState') != 'activating':
                    raise binding_failure(current, ['ActiveState'])
            if self.child.poll() is not None:
                break
            time.sleep(.05)
        raise binding_failure(current, ['startupDeadline'])

    def stop(self):
        self.stopRequested = True
        self.cancelled = True
        current = service_state(self.unit)
        if self.bound and current.get('InvocationID') == self.bound['InvocationID']:
            result = run(['sudo', '-n', '/usr/bin/systemctl', 'stop', '--no-block', self.unit], allowed=(0, 5))
            # --collect may retire this exact invocation between show and stop.
            # The status alone never proves absence; retain both independent checks.
            if result.returncode == 5 and (service_state(self.unit).get('LoadState') != 'not-found' or self.group.exists()):
                raise RuntimeError('Collected service disposal unconfirmed')
            self.stopCommands += 1
        elif current.get('LoadState') != 'not-found' or self.group.exists():
            raise RuntimeError('Service invocation custody lost')

    def wait(self):
        if not self.child:
            raise RuntimeError('Service was not started')
        def retire():
            self.cancelled = True
            self.stop()
        code, output, error, cancelled, limited = bounded_capture(self.child, self.budget + 60, retire)
        self.cancelled = self.cancelled or cancelled or limited
        self.out.write(output)
        self.err.write(error)
        self.out.close()
        self.err.close()
        deadline = time.monotonic() + 10
        while self.group.exists() and time.monotonic() < deadline:
            time.sleep(.05)
        current = service_state(self.unit)
        absent = not self.group.exists() and current.get('LoadState') == 'not-found'
        if not absent:
            raise RuntimeError('Bound service cgroup disposal unconfirmed')
        receipt_stat = self.terminal.lstat()
        if not stat.S_ISREG(receipt_stat.st_mode) or receipt_stat.st_uid != self.uid or receipt_stat.st_nlink != 1 or receipt_stat.st_size > 4096 or receipt_stat.st_mode & 0o022:
            raise RuntimeError('Terminal service receipt custody differs')
        terminal = json.loads(self.terminal.read_text(), object_pairs_hook=unique_object)
        if terminal.get('invocationId') != self.bound['InvocationID'] or terminal.get('cgroup') != '0::/system.slice/' + self.unit or terminal.get('uid') != self.uid:
            raise RuntimeError('Terminal receipt differs from initial service binding')
        self.waited = True
        return {'terminal': terminal, 'exitCode': code, 'cancelled': self.cancelled, 'stopRequested': self.stopRequested, 'stopCommands': self.stopCommands, 'invocationId': self.bound['InvocationID'] if self.bound else None,
                'controlGroup': '/system.slice/' + self.unit, 'cgroupAbsent': True, 'unitCollected': True}


def gated_child():
    gate = Path(sys.argv[2])
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if gate.exists():
            os.execv(sys.argv[3], sys.argv[3:])
        time.sleep(.02)
    raise SystemExit(4)


def retire_services(services):
    complete = True
    for service in services:
        if service.child and not service.waited:
            try:
                if service.child.poll() is None:
                    service.stop()
                service.wait()
            except BaseException:
                complete = False
        if service.group.exists():
            complete = False
    return complete


def main():
    report = {'formatVersion': 1, 'scope': 'manual-native-debian13-kvm', 'ok': False,
              'runtimeAdmission': False, 'humanConsentProof': False}
    root = None
    services = []
    interrupted = False
    def cancel(_number, _frame):
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            raise KeyboardInterrupt('Qualification cancelled')
    previous = {number: signal.signal(number, cancel) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        import platform
        import grp
        import fcntl
        if (sys.argv[1:] != ['--run'] or platform.system() != 'Linux' or platform.machine() != 'x86_64'
                or os.getuid() == 0 or os.environ.get('GITHUB_ACTIONS') != 'true'
                or os.environ.get('GITHUB_REPOSITORY') != 'hazeion/fleur'
                or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
                or os.environ.get('FLEUR_RUNNER_ENVIRONMENT') != 'github-hosted'
                or os.environ.get('GITHUB_JOB') != 'existing-docker'
                or not re.fullmatch(r'\d+', os.environ.get('GITHUB_RUN_ID', ''))
                or not re.fullmatch(r'\d+', os.environ.get('GITHUB_RUN_ATTEMPT', ''))
                or not re.fullmatch('[a-f0-9]{40}', os.environ.get('GITHUB_SHA', ''))):
            raise ValueError('Fixed hosted runner context unavailable')
        if run(['git', 'rev-parse', 'HEAD']).stdout.decode().strip() != os.environ['GITHUB_SHA'] or run(['git', 'diff', '--exit-code', 'HEAD']).stdout:
            raise ValueError('Source identity differs')
        release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
        if release.get('ID') != 'ubuntu' or release.get('VERSION_ID', '').strip('"') != '24.04' or Path('/proc/1/comm').read_text().strip() != 'systemd' or not Path('/sys/fs/cgroup/cgroup.controllers').is_file():
            raise ValueError('Native Ubuntu systemd/cgroup2 unavailable')
        with Path(os.environ['GITHUB_EVENT_PATH']).open('rb') as event_file:
            event_bytes = event_file.read(256 * 1024 + 1)
        if len(event_bytes) > 256 * 1024:
            raise ValueError('Event exceeds bounded input')
        event = json.loads(event_bytes, object_pairs_hook=unique_object)
        recovery = qualification_mode(event.get('inputs', {}))
        report['case'] = 'interrupted-recovery' if recovery else 'fresh-installation'
        origin = json.loads((REPO / 'experiments/compatibility/runtime-probe/recorded-helper-origin.json').read_text())
        helpers = decode_helpers(event['inputs']['debian_helpers'], {entry['name']: entry for entry in origin['helpers']})
        # Refuse unavailable device/group instead of changing permissions or falling back to emulation.
        device = os.lstat('/dev/kvm')
        gid = grp.getgrnam('kvm').gr_gid
        if not stat.S_ISCHR(device.st_mode) or device.st_uid != 0 or device.st_gid != gid:
            raise ValueError('Existing KVM device custody unavailable')
        observed = run(['sudo', '-n', '/usr/bin/python3', '-I', str(REPO / 'scripts/observe-native-virtualization.py')])
        if json.loads(observed.stdout).get('kvm', {}).get('apiVersion') != 12:
            raise ValueError('Existing KVM access unavailable')
        report['context'] = {key: os.environ[key] for key in ('GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')}
        report['kvm'] = json.loads(observed.stdout)
        root = Path(tempfile.mkdtemp(prefix='fleur-kvm-'))
        report['scratchRemoved'] = False
        helper_dir = root / 'helpers'
        helper_dir.mkdir(mode=0o700)
        for name, data in helpers.items():
            with (helper_dir / name).open('xb') as output:
                output.write(data)
            (helper_dir / name).chmod(0o600)
        bun = Path(os.environ['FLEUR_PINNED_BUN']).resolve(strict=True)
        if not bun.is_file() or run([str(bun), '--version']).stdout != b'1.4.3\n':
            raise ValueError('Pinned Bun unavailable')
        env = {'PATH': str(bun.parent) + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
               'HOME': str(root), 'TMPDIR': str(root), 'FLEUR_OWNED_DISPOSABLE_HOST': 'yes', 'FLEUR_GUEST_ACCELERATOR': 'kvm'}
        report['containment'] = []
        # Actual service/cgroup seam: a detached descendant outlives its immediate parent.
        for kind in ('normal', 'stop', 'timeout', 'before-start'):
            marker = root / ('detached-' + kind)
            program = ('import os,time,pathlib; pid=os.fork(); '
                       'os.setsid() if pid==0 else None; '
                       f'pathlib.Path({str(marker)!r}).write_text(str(os.getpid())) if pid==0 else None; '
                       'time.sleep(120) if pid==0 else time.sleep(' + ('120' if kind == 'timeout' else '1') + ')')
            service = Service(root, os.getuid(), gid, ['/usr/bin/python3', '-I', '-c', program], env, 2 if kind == 'timeout' else 60)
            services.append(service)
            service.launch(release=kind != 'before-start')
            if kind == 'before-start':
                service.stop()
                service.stop()
                result = service.wait()
                if marker.exists() or not result['cancelled'] or result['stopCommands'] < 1:
                    raise RuntimeError('Cancelled gate released a child')
                report['containment'].append({'case': kind, **result})
                continue
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            if not marker.exists():
                raise RuntimeError('Detached child not observed')
            pid = int(marker.read_text())
            if Path('/proc', str(pid), 'cgroup').read_text().strip() != '0::/system.slice/' + service.unit:
                raise RuntimeError('Detached child escaped service cgroup')
            if kind == 'stop':
                service.stop()
                service.stop()
            result = service.wait()
            if kind == 'normal' and (result['exitCode'] != 0 or result['terminal'].get('result') != 'success') or kind == 'stop' and (result['stopCommands'] < 1 or not result['cancelled']) or kind == 'timeout' and result['terminal'].get('result') != 'timeout':
                raise RuntimeError('Containment termination classification differs')
            report['containment'].append({'case': kind, **result})
        # Hosted sudo policy may allow root while denying a direct run-as-group.
        # The root-managed service establishes the existing KVM group for the
        # ordinary runner, and must prove that exact identity's device access.
        probe = Service(root, os.getuid(), gid, ['/usr/bin/python3', '-I', str(REPO / 'scripts/observe-native-virtualization.py')], env, 60)
        services.append(probe)
        probe.launch()
        probe_result = probe.wait()
        report['ordinaryKvmService'] = probe_result
        report['ordinaryKvmObservation'] = json.loads(probe.output.read_text())
        if probe_result['exitCode'] != 0 or probe_result['cancelled'] or probe_result['terminal'].get('result') != 'success' or not accepted_kvm_probe(report['ordinaryKvmObservation']):
            raise RuntimeError('Ordinary bound-service KVM access unavailable')
        before = docker_snapshot()
        manifest = json.loads((REPO / 'scripts/native-kvm-host-tools.json').read_text())
        report['hostImageAdmission'] = admit_runner_image(manifest, os.environ.get('ImageVersion'))
        packages = [entry['name'] + '=' + entry['version'] for entry in manifest['packages']]
        apt_options = ['--no-install-recommends', '--no-remove', '--no-upgrade', *packages]
        simulation = run(['/usr/bin/apt-get', '--simulate', 'install', *apt_options])
        report['hostToolPlan'] = validate_tool_plan(simulation.stdout.decode(), manifest)
        report['hostToolRepositoryPolicy'] = run(['/usr/bin/apt-cache', 'policy', *[entry['name'] for entry in manifest['packages']]]).stdout.decode()
        package_before = package_snapshot()
        validate_tool_baseline(package_before, manifest)
        args = ['/usr/bin/apt-get', 'install', '--yes', *apt_options]
        service = Service(root, 0, 0, args, {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(root), 'DEBIAN_FRONTEND': 'noninteractive'}, 240)
        services.append(service)
        service.launch()
        result = service.wait()
        report['hostToolsPreparation'] = {'command': args, 'service': result, 'stdout': service.output.read_text(), 'stderr': service.error.read_text()}
        if result['exitCode'] != 0 or result['cancelled'] or result['terminal'].get('result') != 'success':
            raise RuntimeError('Host test-tool transaction failed')
        package_after = package_snapshot()
        report['hostPackageDelta'] = validate_package_delta(package_before, package_after, manifest)
        report['hostPackageSnapshots'] = {'before': package_before, 'after': package_after}
        after = docker_snapshot()
        report['hostDockerPreservation'] = {'before': before, 'after': after, 'unchanged': before == after}
        if before != after:
            raise RuntimeError('Host Docker state changed during host test-tool preparation')
        report['hostTools'] = run(['dpkg-query', '--show', '--showformat=${Package}\t${Version}\t${db:Status-Status}\n', 'qemu-system-x86', 'qemu-utils', 'cloud-image-utils']).stdout.decode()
        for name, (url, limit, digest) in PINS.items():
            path = root / name
            run(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '180', '--max-filesize', str(limit), '--output', str(path), url], timeout=190)
            size = path.stat().st_size
            if size <= 0 or size > limit or name == 'debian.qcow2' and size != limit or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise ValueError('Fixed verification download identity differs')
        service = Service(root, os.getuid(), gid, [str(bun), str(REPO / ('scripts/verify-debian-recovery.ts' if recovery else 'scripts/verify-fresh-linux.ts')), '--run', '--image', str(root / 'debian.qcow2'), '--candidate', 'ordinary-source-owned', '--bun-archive', str(root / 'bun.zip'), '--recorded-helper-artifacts', str(helper_dir), '--fixture', 'debian13-amd64'], env)
        services.append(service)
        service.launch()
        report['service'] = service.wait()
        report['guestVerifier'] = json.loads(service.output.read_text())
        report['serviceStderr'] = service.error.read_text()[-16384:]
        if report['service']['exitCode'] != 0 or report['service']['cancelled'] or report['service']['terminal'].get('result') != 'success' or not (accepted_recovery_guest if recovery else accepted_guest)(report['guestVerifier'], os.environ['GITHUB_SHA']):
            raise RuntimeError('Native guest qualification failed')
        report['ok'] = True
    except BaseException as error:
        report['error'] = {'type': type(error).__name__, 'message': str(error), **({'diagnostic': error.diagnostic} if hasattr(error, 'diagnostic') else {})}
    finally:
        complete = retire_services(services)
        report['interrupted'] = interrupted
        report['allServiceCgroupsAbsent'] = complete
        if root and complete:
            import shutil
            try:
                shutil.rmtree(root)
                report['scratchRemoved'] = not root.exists()
            except OSError:
                report['scratchRemoved'] = False
                report['cleanupError'] = 'Owned scratch removal failed'
        if interrupted or not complete or root and not report.get('scratchRemoved'):
            report['ok'] = False
        for number, handler in previous.items():
            signal.signal(number, handler)
        print(json.dumps(report))
    return 0 if report['ok'] else 4


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--terminal-receipt':
        receipt = {'invocationId': os.environ.get('INVOCATION_ID'), 'result': os.environ.get('SERVICE_RESULT'),
                   'exitCode': os.environ.get('EXIT_CODE'), 'exitStatus': os.environ.get('EXIT_STATUS'),
                   'cgroup': Path('/proc/self/cgroup').read_text().strip(), 'uid': os.getuid()}
        fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            os.write(fd, json.dumps(receipt).encode())
            os.fsync(fd)
        finally:
            os.close(fd)
    elif len(sys.argv) >= 4 and sys.argv[1] == '--gated-child':
        gated_child()
    else:
        raise SystemExit(main())

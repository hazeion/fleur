"""Closed evidence contracts for the fixed Debian 13 interrupted-APT verifier.

Verification fixtures only. These records never authorize product actions or
claim continuity of volatile firewall rules across a kernel reboot.
"""
import hashlib
import re
import shlex
from types import MappingProxyType

PACKAGE_VERSIONS = MappingProxyType({
    'docker-ce': '5:29.9.1-1~debian.13~trixie',
    'docker-ce-cli': '5:29.9.1-1~debian.13~trixie',
    'containerd.io': '2.4.2-2~debian.13~trixie',
    'docker-buildx-plugin': '0.38.0-1~debian.13~trixie',
    'docker-compose-plugin': '5.6.0-1~debian.13~trixie',
    'libjansson4': '2.14-2+b3', 'libnftables1': '1.1.3-1', 'nftables': '1.1.3-1',
})
NATIVE_ALIASES = frozenset(('libjansson4', 'libnftables1'))
CONFIGURATION_PATH = '/etc/nftables.conf'
UNIT_PATH = '/usr/lib/systemd/system/nftables.service'
HELPER_PATHS = frozenset((
    '/var/lib/systemd/deb-systemd-helper-enabled/nftables.service.dsh-also',
    '/var/lib/systemd/deb-systemd-helper-enabled/multi-user.target.wants/nftables.service',
    '/var/lib/systemd/deb-systemd-helper-masked/nftables.service',
    '/etc/systemd/system/nftables.service',
    '/etc/systemd/system/multi-user.target.wants/nftables.service',
    '/run/systemd/system/nftables.service',
    '/run/systemd/system/multi-user.target.wants/nftables.service',
))
PHASES = MappingProxyType({
    'original': ('beforeInstall', 'afterInterruptedInstall', 'cleanup'),
    'current': ('beforeReconciliation', 'afterInspection', 'freshLogin', 'afterRuntime', 'cleanup'),
})
ROOT_PHASE = MappingProxyType({
    'beforeInstall': 'before', 'afterInterruptedInstall': 'afterInstall',
    'beforeReconciliation': 'before', 'afterInspection': 'afterInstall',
    'freshLogin': 'freshLogin', 'afterRuntime': 'afterRuntime', 'cleanup': 'cleanup',
})


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _closed(value, fields):
    return type(value) is dict and set(value) == set(fields)


def _hex(value, count):
    return type(value) is str and re.fullmatch('[a-f0-9]{' + str(count) + '}', value) is not None


def _binding(value):
    _require(_closed(value, ('nonce', 'bootId', 'uid', 'manifestSha256')), 'Closed recovery binding required')
    _require(type(value['nonce']) is str and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', value['nonce']) is not None,
             'Canonical recovery nonce required')
    _require(type(value['bootId']) is str and re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', value['bootId']) is not None,
             'Canonical recovery boot identity required')
    _require(type(value['uid']) is int and 0 < value['uid'] <= 2147483647 and _hex(value['manifestSha256'], 64),
             'Ordinary recovery UID and manifest required')


def canary_chain(binding):
    _binding(binding)
    return 'FL' + hashlib.sha256((binding['nonce'] + ':' + binding['bootId']).encode('ascii')).hexdigest()[:20]


def _decimal(value):
    return type(value) is str and re.fullmatch(r'(0|[1-9][0-9]{0,22})', value) is not None


def _file_entry(value, helper=False):
    _require(_closed(value, ('kind', 'uid', 'gid', 'mode', 'nlink', 'dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'sha256')),
             'Closed recovery configuration metadata required')
    _require(value['kind'] == 'file', 'Unexpected configuration entry type')
    for field in ('uid', 'gid', 'mode', 'nlink', 'size'):
        _require(type(value[field]) is int, 'Integer configuration metadata required')
    _require(value['uid'] == 0 and value['gid'] == 0 and value['nlink'] == 1, 'Protected single-link configuration required')
    if helper:
        _require((0 <= value['mode'] <= 0o777 and value['mode'] & 0o022 == 0),
                 'Unsafe systemd helper entry mode')
    else:
        _require(value['mode'] == 0o644, 'Exact installed configuration mode required')
    _require((0 if helper else 1) <= value['size'] <= 1048576 and _hex(value['sha256'], 64), 'Bounded configuration bytes required')
    for field in ('dev', 'ino', 'mtimeNs', 'ctimeNs'):
        _require(_decimal(value[field]), 'Canonical configuration identity required')
    _require(value['ino'] != '0', 'Configuration inode required')


def _configuration(value, installed):
    _require(_closed(value, ('files', 'helperFiles', 'unit')) and _closed(value['files'], (CONFIGURATION_PATH, UNIT_PATH)),
             'Closed fixed configuration scope required')
    for entry in value['files'].values():
        if installed:
            _file_entry(entry)
        else:
            _require(entry is None, 'Original fresh configuration must be absent')
    expected_unit = {'FragmentPath': UNIT_PATH if installed else '', 'DropInPaths': '', 'Transient': 'no'}
    _require(value['unit'] == expected_unit and _closed(value['unit'], expected_unit), 'Unexpected nftables fragment or drop-in state')
    helpers = value['helperFiles']
    _require(type(helpers) is list and len(helpers) <= len(HELPER_PATHS), 'Bounded fixed systemd helper state required')
    paths = []
    for item in helpers:
        _require(_closed(item, ('path', 'entry')) and type(item['path']) is str and item['path'] in HELPER_PATHS,
                 'Unknown systemd helper configuration path')
        paths.append(item['path'])
        _file_entry(item['entry'], helper=True)
    _require(paths == sorted(set(paths)), 'Unique sorted helper observations required')
    if not installed:
        _require(not helpers, 'Original fresh helper state must be absent')


def _frame(frame, owner, phase, installed):
    fields = ('binding', 'phase', 'backend', 'tool', 'selectedTool', 'toolVersion', 'chain', 'canary', 'service',
              'cleanup', 'configuration', 'observedAtMonotonicNs')
    _require(_closed(frame, fields), 'Closed recovery canary frame required')
    _binding(frame['binding'])
    _require(frame['binding'] == owner and frame['phase'] == ROOT_PHASE[phase], 'Recovery canary phase or binding differs')
    _require(frame['backend'] == 'nf_tables' and frame['tool'] == '/usr/sbin/iptables-nft'
             and frame['selectedTool'] == '/usr/sbin/xtables-nft-multi', 'Exact nf_tables backend required')
    _require(type(frame['toolVersion']) is str and re.fullmatch(r'iptables v[0-9]+\.[0-9]+\.[0-9]+ \(nf_tables\)', frame['toolVersion']) is not None,
             'Bounded firewall version required')
    chain = canary_chain(owner)
    _require(frame['chain'] == chain and type(frame['canary']) is str and len(frame['canary']) <= 4096, 'Boot-owned canary identity differs')
    try:
        rules = [shlex.split(line) for line in frame['canary'].splitlines()]
    except ValueError as error:
        raise ValueError('Malformed owned canary rules') from error
    _require(rules == [['-N', chain], ['-A', chain, '-m', 'comment', '--comment', 'fleur-' + owner['nonce'], '-j', 'RETURN']],
             'Owned detached canary differs')
    expected_service = {'LoadState': 'loaded' if installed else 'not-found', 'ActiveState': 'inactive', 'SubState': 'dead',
                        'UnitFileState': 'disabled' if installed else '', 'ExecMainPID': '0', 'ExecMainStartTimestampMonotonic': '0',
                        'InactiveExitTimestampMonotonic': '0', 'ActiveEnterTimestampMonotonic': '0'}
    _require(_closed(frame['service'], expected_service) and frame['service'] == expected_service, 'nftables execution or service state differs')
    _require(frame['cleanup'] is (phase == 'cleanup'), 'Confirmed canary cleanup state required')
    _require(type(frame['observedAtMonotonicNs']) is int and 0 < frame['observedAtMonotonicNs'] < 2**63,
             'Bounded actual monotonic observation required')
    _configuration(frame['configuration'], installed)


def _ledger(value, stage, owner):
    _require(_closed(value, ('scope', 'stage', 'binding', 'observations')) and value['scope'] == 'debian-recovery-owned-canary-v1'
             and value['stage'] == stage and value['binding'] == owner, 'Closed boot-specific recovery ledger required')
    _binding(value['binding'])
    observations = value['observations']
    _require(type(observations) is dict and tuple(observations) == PHASES[stage], 'Recovery canary phase sequence differs')
    previous = 0
    original = None
    for phase, frame in observations.items():
        _frame(frame, owner, phase, installed=not (stage == 'original' and phase == 'beforeInstall'))
        _require(frame['observedAtMonotonicNs'] > previous, 'Recovery phase replay or time reversal')
        previous = frame['observedAtMonotonicNs']
        if original is not None:
            for field in ('binding', 'backend', 'tool', 'selectedTool', 'toolVersion', 'chain', 'canary'):
                _require(frame[field] == original[field], 'Owned canary changed within a boot')
        else:
            original = frame
        if stage == 'current' or phase == 'cleanup':
            first_installed = observations[PHASES[stage][0 if stage == 'current' else 1]]
            _require(frame['configuration'] == first_installed['configuration'], 'Installed configuration changed within a boot')


def validate_canary_frame(stage, binding, phase, frame):
    _require(type(stage) is str and stage in PHASES and type(phase) is str and phase in PHASES[stage],
             'Fixed recovery canary phase required')
    _binding(binding)
    _frame(frame, binding, phase, installed=not (stage == 'original' and phase == 'beforeInstall'))


def validate_boot_ledger(binding, stage, ledger):
    _binding(binding)
    _require(type(stage) is str and stage in PHASES, 'Fixed recovery boot stage required')
    _ledger(ledger, stage, binding)


def validate_two_boot_preservation(original_binding, current_binding, report):
    _binding(original_binding)
    _binding(current_binding)
    _require(original_binding['nonce'] == current_binding['nonce'] and original_binding['uid'] == current_binding['uid']
             and original_binding['bootId'] != current_binding['bootId']
             and original_binding['manifestSha256'] != current_binding['manifestSha256'], 'Same guest and two distinct protected boots required')
    _require(_closed(report, ('scope', 'original', 'current', 'historicalKernelRulesContinuity'))
             and report['scope'] == 'debian-recovery-two-boot-preservation' and report['historicalKernelRulesContinuity'] is False,
             'Closed two-boot preservation scope required')
    _ledger(report['original'], 'original', original_binding)
    _ledger(report['current'], 'current', current_binding)
    before = report['original']['observations']['cleanup']
    after = report['current']['observations']['beforeReconciliation']
    _require(before['configuration'] == after['configuration'] and before['service'] == after['service']
             and before['toolVersion'] == after['toolVersion'], 'Package configuration or service changed across reboot')


def _version(value):
    # https://www.debian.org/doc/debian-policy/ch-controlfields.html#version
    # Debian Policy 5.6.12; this fixed qualification also requires the recommended
    # leading digit. Splitting at the last hyphen keeps upstream hyphens distinct
    # from the nonempty Debian revision. A character allowlist alone is unsafe.
    if type(value) is not str or not 1 <= len(value) <= 128 or value.count(':') > 1:
        return False
    if ':' in value:
        epoch, value = value.split(':', 1)
        if re.fullmatch(r'[0-9]+', epoch) is None:
            return False
    if '-' in value:
        upstream, revision = value.rsplit('-', 1)
        if re.fullmatch(r'[A-Za-z0-9+.~]+', revision) is None:
            return False
    else:
        upstream = value
    return re.fullmatch(r'[0-9][A-Za-z0-9.+~\-]*', upstream) is not None


def _package_rows(text):
    _require(type(text) is str and 0 < len(text.encode()) <= 2097152, 'Bounded complete package inventory required')
    rows = {}
    for line in text.removesuffix('\n').split('\n'):
        fields = line.split('\t')
        _require(len(fields) == 4, 'Closed dpkg row required')
        name, version, state, error = fields
        _require(re.fullmatch(r'[a-z0-9][a-z0-9+.-]*(?::[a-z0-9_-]+)?', name) is not None, 'Canonical package identity required')
        base, separator, architecture = name.partition(':')
        if base in PACKAGE_VERSIONS and separator:
            _require(base in NATIVE_ALIASES and architecture == 'amd64', 'Foreign or undeclared package alias')
            name = base
        _require(name not in rows and error == 'ok' and state in ('installed', 'config-files', 'not-installed'), 'Unhealthy or duplicate package inventory')
        _require((state == 'not-installed' and version == '') or (state != 'not-installed' and _version(version)), 'Retained or malformed package version')
        rows[name] = (version, state, error)
    return rows


def validate_exact_package_effects(before_text, after_text, expected_versions):
    _require(type(expected_versions) is dict and expected_versions == PACKAGE_VERSIONS, 'Exact authenticated eight-package closure required')
    before, after = _package_rows(before_text), _package_rows(after_text)
    for name, version in PACKAGE_VERSIONS.items():
        _require(name not in before or before[name] == ('', 'not-installed', 'ok'), 'Expected package was not genuinely absent')
        _require(after.get(name) == (version, 'installed', 'ok'), 'Exact configured package effect required')
    unrelated = {name: row for name, row in before.items() if name not in PACKAGE_VERSIONS}
    _require({name: row for name, row in after.items() if name not in PACKAGE_VERSIONS} == unrelated,
             'Original unrelated package inventory changed')

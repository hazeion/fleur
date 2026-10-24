"""Independent requirements for Debian recovery evidence; no native execution."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

_spec = importlib.util.spec_from_file_location('debian_recovery_contract', Path(__file__).with_name('debian_recovery_contract.py'))
contract = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(contract)

VERSIONS = {
    'docker-ce': '5:29.9.1-1~debian.13~trixie',
    'docker-ce-cli': '5:29.9.1-1~debian.13~trixie',
    'containerd.io': '2.4.2-2~debian.13~trixie',
    'docker-buildx-plugin': '0.38.0-1~debian.13~trixie',
    'docker-compose-plugin': '5.6.0-1~debian.13~trixie',
    'libjansson4': '2.14-2+b3', 'libnftables1': '1.1.3-1', 'nftables': '1.1.3-1',
}
ORIGINAL_PHASES = ('beforeInstall', 'afterInterruptedInstall', 'cleanup')
CURRENT_PHASES = ('beforeReconciliation', 'afterInspection', 'freshLogin', 'afterRuntime', 'cleanup')
ROOT_PHASE = {'beforeInstall': 'before', 'afterInterruptedInstall': 'afterInstall',
              'beforeReconciliation': 'before', 'afterInspection': 'afterInstall',
              'freshLogin': 'freshLogin', 'afterRuntime': 'afterRuntime', 'cleanup': 'cleanup'}
UNIT = '/usr/lib/systemd/system/nftables.service'


def binding(boot='22222222-2222-4222-8222-222222222222', manifest='a'):
    return {'nonce': '11111111-1111-4111-8111-111111111111', 'bootId': boot,
            'uid': 1000, 'manifestSha256': manifest * 64}


def file_entry(inode):
    return {'kind': 'file', 'uid': 0, 'gid': 0, 'mode': 420, 'nlink': 1,
            'dev': '2049', 'ino': str(inode), 'size': 512,
            'mtimeNs': '1792000000000000000', 'ctimeNs': '1792000000000000000', 'sha256': 'c' * 64}


def configuration(installed):
    return {'files': {'/etc/nftables.conf': {**file_entry(100), 'mode': 0o755} if installed else None,
                      UNIT: file_entry(101) if installed else None},
            'helperFiles': [], 'unit': {'FragmentPath': UNIT if installed else '', 'DropInPaths': '', 'Transient': 'no'}}


def frame(owner, phase, installed, instant):
    chain = 'FL' + hashlib.sha256((owner['nonce'] + ':' + owner['bootId']).encode()).hexdigest()[:20]
    return {'binding': copy.deepcopy(owner), 'phase': ROOT_PHASE[phase], 'backend': 'nf_tables',
            'tool': '/usr/sbin/iptables-nft', 'selectedTool': '/usr/sbin/xtables-nft-multi',
            'toolVersion': 'iptables v1.8.11 (nf_tables)', 'chain': chain,
            'canary': '-N ' + chain + '\n-A ' + chain + ' -m comment --comment fleur-' + owner['nonce'] + ' -j RETURN\n',
            'service': {'LoadState': 'loaded' if installed else 'not-found', 'ActiveState': 'inactive',
                        'SubState': 'dead', 'UnitFileState': 'disabled' if installed else '',
                        'ExecMainPID': '0', 'ExecMainStartTimestampMonotonic': '0',
                        'InactiveExitTimestampMonotonic': '0', 'ActiveEnterTimestampMonotonic': '0'},
            'cleanup': phase == 'cleanup', 'configuration': configuration(installed),
            'observedAtMonotonicNs': instant}


def preservation_fixture():
    old = binding()
    new = binding('33333333-3333-4333-8333-333333333333', 'b')
    def ledger(stage, owner, phases):
        return {'scope': 'debian-recovery-owned-canary-v1', 'stage': stage,
                'binding': copy.deepcopy(owner), 'observations': {
                    phase: frame(owner, phase, stage == 'current' or index > 0, (index + 1) * 100)
                    for index, phase in enumerate(phases)}}
    return old, new, {'scope': 'debian-recovery-two-boot-preservation',
                      'original': ledger('original', old, ORIGINAL_PHASES),
                      'current': ledger('current', new, CURRENT_PHASES),
                      'historicalKernelRulesContinuity': False}


class TwoBootPreservationRequirements(unittest.TestCase):
    def reject(self, mutate):
        old, new, report = preservation_fixture()
        mutate(old, new, report)
        saved = copy.deepcopy((old, new, report))
        with self.assertRaises(ValueError):
            contract.validate_two_boot_preservation(old, new, report)
        self.assertEqual((old, new, report), saved, 'Validation must not repair or rebind evidence')

    def test_exact_two_boot_evidence_is_accepted_without_mutation(self):
        old, new, report = preservation_fixture()
        saved = copy.deepcopy((old, new, report))
        self.assertIsNone(contract.validate_two_boot_preservation(old, new, report))
        self.assertEqual((old, new, report), saved)
        self.assertNotEqual(report['original']['observations']['cleanup']['chain'],
                            report['current']['observations']['beforeReconciliation']['chain'])

    def test_report_and_ledgers_have_closed_scopes_and_shapes(self):
        mutations = [lambda o,n,r: r.update(extra=True), lambda o,n,r: r.update(scope='generic'),
                     lambda o,n,r: r.update(historicalKernelRulesContinuity=True),
                     lambda o,n,r: r.pop('historicalKernelRulesContinuity'),
                     lambda o,n,r: r.update(historicalKernelRulesContinuity=0)]
        for side in ('original', 'current'):
            mutations.extend([lambda o,n,r,s=side: r[s].update(extra=True),
                              lambda o,n,r,s=side: r[s].update(scope='other'),
                              lambda o,n,r,s=side: r[s].update(stage='current' if s == 'original' else 'original')])
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index): self.reject(mutate)

    def test_binding_requires_same_owned_guest_and_distinct_real_boot_and_manifest(self):
        mutations = [lambda o,n,r: n.update(bootId=o['bootId']),
                     lambda o,n,r: n.update(manifestSha256=o['manifestSha256']),
                     lambda o,n,r: n.update(nonce='44444444-4444-4444-8444-444444444444'),
                     lambda o,n,r: n.update(uid=1001), lambda o,n,r: n.update(uid=True),
                     lambda o,n,r: n.update(bootId='not-a-boot-id'),
                     lambda o,n,r: r['original']['binding'].update(bootId=n['bootId']),
                     lambda o,n,r: r['current']['observations']['afterInspection']['binding'].update(manifestSha256=o['manifestSha256']),
                     lambda o,n,r: r['current']['observations']['freshLogin']['binding'].update(extra='unbound')]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index): self.reject(mutate)

    def test_each_required_phase_is_present_once_in_order(self):
        for side, phases in [('original', ORIGINAL_PHASES), ('current', CURRENT_PHASES)]:
            for phase in phases:
                with self.subTest(side=side, missing=phase):
                    self.reject(lambda o,n,r,s=side,p=phase: r[s]['observations'].pop(p))
            with self.subTest(side=side, order='reversed'):
                self.reject(lambda o,n,r,s=side: r[s].update(observations=dict(reversed(list(r[s]['observations'].items())))))
            with self.subTest(side=side, extra=True):
                self.reject(lambda o,n,r,s=side: r[s]['observations'].update(unrecognized={}))

    def test_root_frames_reject_drift_or_extra_fields(self):
        changes = [('phase', 'freshLogin'), ('backend', 'legacy'), ('tool', '/usr/sbin/iptables-legacy'),
                   ('selectedTool', '/tmp/iptables'), ('toolVersion', 'iptables v1.8.11 (legacy)'),
                   ('chain', 'FL' + '0' * 20), ('canary', '-N unowned\n'), ('extra', 'private')]
        for key, value in changes:
            with self.subTest(field=key):
                self.reject(lambda o,n,r,k=key,v=value: r['original']['observations']['afterInterruptedInstall'].update({k:v}))
        self.reject(lambda o,n,r: r['current']['observations']['afterInspection'].update(
            canary=r['current']['observations']['afterInspection']['canary'].replace('RETURN', 'ACCEPT')))

    def test_cleanup_and_monotonic_observations_are_not_inferred(self):
        for side, phases in [('original', ORIGINAL_PHASES), ('current', CURRENT_PHASES)]:
            for phase in phases:
                with self.subTest(side=side, phase=phase):
                    self.reject(lambda o,n,r,s=side,p=phase: r[s]['observations'][p].update(cleanup=p != 'cleanup'))
            for instant in (100, 0, -1, True, '200'):
                with self.subTest(side=side, instant=instant):
                    self.reject(lambda o,n,r,s=side,p=phases[1],v=instant: r[s]['observations'][p].update(observedAtMonotonicNs=v))

    def test_nftables_service_stays_inactive_disabled_and_never_executes(self):
        for field, value in [('LoadState', 'not-found'), ('ActiveState', 'active'), ('SubState', 'running'),
                             ('UnitFileState', 'enabled'), ('ExecMainPID', '123'),
                             ('ExecMainStartTimestampMonotonic', '1'), ('InactiveExitTimestampMonotonic', '1'),
                             ('ActiveEnterTimestampMonotonic', '1'), ('extra', 'unmeasured')]:
            with self.subTest(field=field):
                self.reject(lambda o,n,r,k=field,v=value: r['current']['observations']['beforeReconciliation']['service'].update({k:v}))
        self.reject(lambda o,n,r: r['original']['observations']['beforeInstall']['service'].update(LoadState='loaded'))

    def test_initial_configuration_is_absent_and_installed_configuration_is_preserved(self):
        self.reject(lambda o,n,r: r['original']['observations']['beforeInstall']['configuration']['files'].update({'/etc/nftables.conf':file_entry(100)}))
        for side, phase in [('original','afterInterruptedInstall'), ('current','beforeReconciliation'), ('current','afterInspection'), ('current','freshLogin'), ('current','afterRuntime'), ('current','cleanup')]:
            for key in ('sha256', 'ino', 'mtimeNs', 'ctimeNs'):
                with self.subTest(side=side, phase=phase, field=key):
                    self.reject(lambda o,n,r,s=side,p=phase,k=key: r[s]['observations'][p]['configuration']['files']['/etc/nftables.conf'].update({k:'d'*64 if k=='sha256' else '999'}))
        for value in (None, {'kind':'symlink'}, {'kind':'file','extra':True}):
            with self.subTest(replacement=value):
                self.reject(lambda o,n,r,v=value: r['current']['observations']['afterInspection']['configuration']['files'].update({UNIT:v}))
        for field, value in [('uid',1000),('gid',1000),('mode',438),('nlink',2),('nlink',True),
                             ('size',0),('size',1048577),('size',True),('dev','private/path'),('ino','-1'),('sha256','invalid')]:
            with self.subTest(file_field=field,value=value):
                self.reject(lambda o,n,r,k=field,v=value: r['current']['observations']['afterInspection']['configuration']['files'][UNIT].update({k:v}))
        for field, value in [('FragmentPath','/tmp/nftables.service'),('DropInPaths','/etc/systemd/system/override.conf'),('Transient','yes'),('extra','hidden')]:
            with self.subTest(unit_field=field):
                self.reject(lambda o,n,r,k=field,v=value: r['current']['observations']['beforeReconciliation']['configuration']['unit'].update({k:v}))
        self.reject(lambda o,n,r: r['current']['observations']['afterInspection']['configuration'].update(extra=True))

    def test_configuration_modes_match_each_exact_authenticated_debian_artifact_path(self):
        old,new,report=preservation_fixture()
        # Pinned nftables 1.1.3-1 data.tar stores its executable configuration
        # as0755 and the service as0644. Neither mode is an interchangeable option.
        self.assertIsNone(contract.validate_two_boot_preservation(old,new,report))
        for path,wrong_mode in [('/etc/nftables.conf',0o644),(UNIT,0o755)]:
            def change_all(o,n,r):
                for side in ('original','current'):
                    for phase,item in r[side]['observations'].items():
                        if side!='original' or phase!='beforeInstall':
                            item['configuration']['files'][path]['mode']=wrong_mode
            with self.subTest(path=path,wrong_mode=wrong_mode):self.reject(change_all)

    def test_consistently_unsafe_file_metadata_is_not_mistaken_for_preservation(self):
        def change_all(report, field, value):
            for side in ('original', 'current'):
                for phase, item in report[side]['observations'].items():
                    if side == 'original' and phase == 'beforeInstall':
                        continue
                    item['configuration']['files'][UNIT][field] = value
        for field, value in [('kind','symlink'),('uid',1000),('gid',1000),('mode',438),
                             ('nlink',2),('nlink',True),('size',0),('size',1048577),
                             ('size',True),('dev','private/path'),('ino','-1'),
                             ('mtimeNs','invalid'),('ctimeNs','invalid'),('sha256','invalid'),('extra',True)]:
            with self.subTest(field=field, value=value):
                self.reject(lambda o,n,r,k=field,v=value: change_all(r,k,v))
        for field, value in [('FragmentPath',UNIT),('DropInPaths','/etc/override.conf'),('Transient','yes')]:
            with self.subTest(initial_unit=field):
                self.reject(lambda o,n,r,k=field,v=value: r['original']['observations']['beforeInstall']['configuration']['unit'].update({k:v}))


    def test_boolean_uid_cannot_alias_uid_one_in_nested_evidence(self):
        old, new, report = preservation_fixture()
        for owner in (old, new): owner['uid'] = 1
        for side in ('original', 'current'):
            report[side]['binding']['uid'] = 1
            for item in report[side]['observations'].values(): item['binding']['uid'] = 1
        self.assertIsNone(contract.validate_two_boot_preservation(old, new, report))
        for side in ('original', 'current'):
            for target in ['ledger', *report[side]['observations']]:
                with self.subTest(side=side, target=target):
                    changed = copy.deepcopy(report)
                    value = changed[side] if target == 'ledger' else changed[side]['observations'][target]
                    value['binding']['uid'] = True
                    with self.assertRaises(ValueError):
                        contract.validate_two_boot_preservation(old, new, changed)

    def test_fixed_helper_metadata_is_validated_even_when_consistently_preserved(self):
        path = '/var/lib/systemd/deb-systemd-helper-enabled/nftables.service.dsh-also'
        def with_helpers(report, entries):
            for side in ('original', 'current'):
                for phase, item in report[side]['observations'].items():
                    if side != 'original' or phase != 'beforeInstall':
                        item['configuration']['helperFiles'] = copy.deepcopy(entries)
        old, new, report = preservation_fixture()
        entries = [{'path': path, 'entry': file_entry(300)}]
        with_helpers(report, entries)
        self.assertIsNone(contract.validate_two_boot_preservation(old, new, report))
        symlink = copy.deepcopy(entries)
        symlink[0]['entry'].update(kind='symlink', mode=0o777)
        # The verification bridge deliberately supports protected regular files
        # only. It must refuse helpers it cannot attest without following links.
        cases = [symlink, entries + copy.deepcopy(entries), [{'path': '/tmp/unowned-helper', 'entry': file_entry(300)}]]
        for key, value in [('uid', 1000), ('gid', 1000), ('mode', 0o666), ('mode', 0o4755),
                           ('nlink', 2), ('nlink', True), ('size', 1048577), ('ino', '0'),
                           ('sha256', 'not-a-hash'), ('extra', True)]:
            bad = copy.deepcopy(entries)
            bad[0]['entry'][key] = value
            cases.append(bad)
        bad_symlink = copy.deepcopy(symlink)
        bad_symlink[0]['entry']['mode'] = 0o755
        cases.append(bad_symlink)
        for index, bad in enumerate(cases):
            with self.subTest(case=index):
                self.reject(lambda o,n,r,e=bad: with_helpers(r, e))


class ExactPackageEffectsRequirements(unittest.TestCase):
    def setUp(self):
        self.before = 'base-files\t13.8+deb13u7\tinstalled\tok\nlibc6:amd64\t2.41-12\tinstalled\tok\nunused\t\tnot-installed\tok\n'
        self.new = ''.join(name+'\t'+version+'\tinstalled\tok\n' for name,version in VERSIONS.items())
        self.after = self.before + self.new

    def check(self, before, after, expected=None):
        saved = copy.deepcopy(VERSIONS if expected is None else expected)
        expected = copy.deepcopy(saved)
        self.assertIsNone(contract.validate_exact_package_effects(before, after, expected))
        self.assertEqual(expected, saved)

    def test_exact_eight_additions_preserve_all_original_rows(self):
        self.check(self.before, self.after)
        aliased = self.after.replace('libjansson4\t','libjansson4:amd64\t').replace('libnftables1\t','libnftables1:amd64\t')
        self.check(self.before, aliased)

    def test_expected_empty_absent_records_can_become_exact_installed_packages(self):
        before = self.before + 'nftables\t\tnot-installed\tok\nlibjansson4:amd64\t\tnot-installed\tok\n'
        self.check(before, self.after)
        self.check(before, self.after.replace('libjansson4\t', 'libjansson4:amd64\t'))

    def test_fresh_effects_cannot_be_claimed_over_prior_expected_package_state(self):
        for row in ('nftables\t1.1.3-1\tinstalled\tok\n',
                    'nftables\t1.1.3-1\tconfig-files\tok\n',
                    'nftables\t1.1.3-1\tnot-installed\tok\n',
                    'nftables\t\tnot-installed\treinstreq\n',
                    'libjansson4:arm64\t\tnot-installed\tok\n',
                    'nftables:amd64\t\tnot-installed\tok\n'):
            with self.subTest(row=row), self.assertRaises(ValueError):
                contract.validate_exact_package_effects(self.before+row, self.after, VERSIONS)

    def test_expected_versions_are_the_closed_authenticated_eight_package_map(self):
        source = Path(__file__).with_name('native-candidate-debian13-amd64.json').read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest(), '032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d')
        self.assertEqual({item['name']:item['version'] for item in json.loads(source)['artifacts']}, VERSIONS)
        wrong_version = {**VERSIONS, 'nftables':'1.1.3-2'}
        cases = [{key:value for key,value in VERSIONS.items() if key != 'nftables'},
                 {**VERSIONS, 'unapproved':'1'}, wrong_version, {**VERSIONS, 'nftables':True}]
        for expected in cases:
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                contract.validate_exact_package_effects(self.before, self.after, expected)
        with self.assertRaises(ValueError):
            contract.validate_exact_package_effects(self.before, self.after.replace('nftables\t1.1.3-1', 'nftables\t1.1.3-2'), wrong_version)

    def test_unrelated_binary_names_and_absent_rows_are_preserved_verbatim(self):
        for after in (self.after.replace('libc6:amd64\t','libc6\t'), self.after.replace('unused\t\tnot-installed\tok\n',''),
                      self.after.replace('unused\t\tnot-installed\tok','unused\t1\tconfig-files\tok')):
            with self.subTest(after=after), self.assertRaises(ValueError):
                contract.validate_exact_package_effects(self.before, after, VERSIONS)

    def test_missing_extra_foreign_and_duplicate_identities_refuse(self):
        cases = [self.after.replace('nftables\t1.1.3-1\tinstalled\tok\n',''),
                 self.after+'unapproved\t1\tinstalled\tok\n',
                 self.after.replace('libjansson4\t','libjansson4:arm64\t'),
                 self.after.replace('nftables\t','nftables:amd64\t'),
                 self.after+'libjansson4:amd64\t2.14-2+b3\tinstalled\tok\n',
                 self.after+'libnftables1\t1.1.3-1\tinstalled\tok\n']
        for after in cases:
            with self.subTest(after=after), self.assertRaises(ValueError):
                contract.validate_exact_package_effects(self.before, after, VERSIONS)
        with self.assertRaises(ValueError):
            contract.validate_exact_package_effects(self.before+self.before, self.after, VERSIONS)

    def test_legitimate_native_epoch_revision_and_binary_nmu_versions_are_preserved(self):
        # Exercise actual inventory consumption, not only the private grammar helper.
        for version in ('1', '20261024', '1.2.3+really1.2.2~rc1', '2:1.2.3',
                        '0:1.2.3-1', '1.2-beta-3', '1.2.3-1~deb13u2',
                        '2.14-2+b3', '1.2+dfsg-0.1~exp1',
                        '5:29.9.1-1~debian.13~trixie'):
            row = 'unrelated-version\t' + version + '\tinstalled\tok\n'
            with self.subTest(version=version):
                self.check(self.before + row, self.after + row)

    def test_unchanged_unrelated_versions_still_require_debian_version_syntax(self):
        # Debian Policy 5.6.12: integer epoch, nonempty upstream/revision,
        # and no underscore in either version component.
        for version in ('1_bad', '1-', '1:', '1a:2', '1::2'):
            row = 'unrelated-version\t' + version + '\tinstalled\tok\n'
            with self.subTest(version=version), self.assertRaises(ValueError):
                contract.validate_exact_package_effects(self.before + row, self.after + row, VERSIONS)

    def test_partial_error_retained_and_changed_version_rows_refuse(self):
        for status in ('unpacked','half-configured','config-files','not-installed'):
            with self.subTest(status=status), self.assertRaises(ValueError):
                contract.validate_exact_package_effects(self.before, self.after.replace('nftables\t1.1.3-1\tinstalled\tok','nftables\t1.1.3-1\t'+status+'\tok'), VERSIONS)
        for after in (self.after.replace('libc6:amd64\t2.41-12','libc6:amd64\t2.41-13'),
                      self.after.replace('nftables\t1.1.3-1','nftables\t1.1.3-2'),
                      self.after.replace('\tinstalled\tok','\tinstalled\treinstreq',1),
                      self.after+'malformed\n'):
            with self.subTest(after=after), self.assertRaises(ValueError):
                contract.validate_exact_package_effects(self.before, after, VERSIONS)
        for bad in ('pkg\t\tnot-installed\treinstreq\n','pkg\t1\tnot-installed\tok\n','pkg\t\tconfig-files\tok\n'):
            with self.subTest(before=bad), self.assertRaises(ValueError):
                contract.validate_exact_package_effects(self.before+bad,self.after+bad,VERSIONS)


if __name__ == '__main__':
    unittest.main()

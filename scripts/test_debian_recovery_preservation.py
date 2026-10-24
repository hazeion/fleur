"""Independent bridge requirements. Root responses are fixtures, never native proof."""
import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace
from typing import NamedTuple
import unittest

HERE = Path(__file__).parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load('independent_recovery_preservation_bridge', HERE / 'debian-recovery-preservation.py')
fixtures = load('independent_recovery_requirement_fixtures', HERE / 'test_debian_recovery_contract.py')
contract = fixtures.contract


def original_root():
    # Importing fresh-linux-guest would run its invocation policy. Read just the
    # literal producer from its AST, without executing any guest entry point.
    tree = ast.parse((HERE / 'fresh-linux-guest.py').read_text())
    values = [ast.literal_eval(node.value) for node in tree.body
              if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'DEBIAN_CANARY_ROOT' for t in node.targets)]
    if len(values) != 1 or type(values[0]) is not str:
        raise AssertionError('Exactly one literal root producer required')
    return values[0]


class OwnedBinding(NamedTuple):
    nonce: str
    bootId: str
    uid: int
    manifestSha256: str


class BridgeRequirements(unittest.TestCase):
    def setUp(self):
        old, new, self.expected = fixtures.preservation_fixture()
        self.old, self.new = OwnedBinding(**old), OwnedBinding(**new)
        self.calls = []
        self.verifications = []
        self.responses = []
        self.guest = SimpleNamespace(DEBIAN_CANARY_ROOT=original_root(), OwnedGuestBinding=OwnedBinding,
                                     REPORT={}, verify_owned_binding=self.verifications.append,
                                     budget_seconds=lambda maximum: maximum, run=self.run_root)
        self.subject = bridge.RecoveryPreservation(self.guest, contract)

    def run_root(self, argv, *, timeout, absolute_deadline):
        self.calls.append((argv, timeout, absolute_deadline))
        self.assertEqual(argv[:6], ['/usr/bin/sudo', '--non-interactive', '--', '/usr/bin/python3', '-I', '-c'])
        self.assertEqual(timeout, 30)
        request = json.loads(argv[-1])
        self.assertEqual(set(request), {'binding', 'phase', 'deadline'})
        self.assertEqual(request['deadline'], absolute_deadline)
        self.assertGreater(absolute_deadline, time.monotonic())
        self.assertLessEqual(absolute_deadline, time.monotonic() + 30)
        response = self.responses.pop(0)
        return 0, response if isinstance(response, str) else json.dumps(response), ''

    def observe(self, stage, phase, mutate=None):
        response = copy.deepcopy(self.expected[stage]['observations'][phase])
        if mutate is not None:
            mutate(response)
        self.responses.append(response)
        self.subject.observe(stage, phase, self.old if stage == 'original' else self.new)
        self.assertEqual(len(self.responses), 0)

    def complete_original(self):
        for phase in contract.PHASES['original']:
            self.observe('original', phase)

    def test_generated_sources_compile_and_retain_original_command_custody(self):
        source = original_root()
        for stage in ('original', 'current'):
            with self.subTest(stage=stage):
                generated = bridge.root_source(self.guest, stage)
                compile(generated, '<generated-recovery-root>', 'exec')
                self.assertIn('CURRENT_BOOT=' + repr(stage == 'current'), generated)
                self.assertIn("hashlib.sha256((binding['nonce']+':'+binding['bootId']).encode('ascii'))", generated)
                # The complete process runner, custody validator and detached-chain
                # observation are byte-identical; test more than marker presence.
                original_command = source[source.index('def command('):source.index("for directory in ('/usr'")]
                self.assertIn(original_command, generated)
                detached = source[source.index('def detached():'):source.index("custody();print(json.dumps(")]
                self.assertIn(detached, generated)

    def test_generated_configuration_reader_demands_exact_mode_for_each_pinned_path(self):
        import hashlib
        import stat
        for stage in ('original','current'):
            tree=ast.parse(bridge.root_source(self.guest,stage))
            reader=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='configuration_entry')
            for path,expected in [('/etc/nftables.conf',0o755),('/usr/lib/systemd/system/nftables.service',0o644)]:
                calls=[]
                def protected_read(actual,maximum,exact_mode,*,deadline):
                    calls.append((actual,maximum,exact_mode,deadline))
                    return b'abc',((actual,(2049,100,stat.S_IFREG|expected,0,0,1,3,10,10)),)
                namespace={'custody':lambda:None,'absent':lambda p:False,'module':SimpleNamespace(protected_read=protected_read),
                           'end':1234,'stat':stat,'hashlib':hashlib}
                exec(compile(ast.Module(body=[reader],type_ignores=[]),'<generated-root-reader>','exec'),namespace)
                result=namespace['configuration_entry'](path)
                with self.subTest(stage=stage,path=path):
                    self.assertEqual(calls,[(path,1048576,expected,1234)])
                    self.assertEqual(result['mode'],expected)

    def test_unknown_stage_or_changed_literal_shape_refuses_generation(self):
        for stage in ('', 'renewed', None):
            with self.subTest(stage=stage), self.assertRaises(RuntimeError):
                bridge.root_source(self.guest, stage)
        for needle in ("chain='FL'+binding['nonce'].replace('-','')[:20]", "'not-found' if phase=='before' else 'loaded'",
                       "'' if phase=='before' else 'disabled'", 'custody();print(json.dumps(', "'cleanup':phase=='cleanup'"):
            for source in (self.guest.DEBIAN_CANARY_ROOT.replace(needle, '<changed>', 1), self.guest.DEBIAN_CANARY_ROOT + '\n' + needle):
                with self.subTest(needle=needle), self.assertRaises(RuntimeError):
                    bridge.root_source(SimpleNamespace(DEBIAN_CANARY_ROOT=source), 'original')

    def test_generated_root_refuses_nonroot_before_loading_protected_producer(self):
        if os.getuid() == 0 or os.geteuid() == 0:
            self.fail('This harmless refusal test requires the ordinary reviewer account')
        request = {'binding': self.old._asdict(), 'phase': 'before', 'deadline': time.monotonic() + 10}
        child = subprocess.run([sys.executable, '-I', '-c', bridge.root_source(self.guest, 'original'), json.dumps(request)],
                               capture_output=True, text=True, timeout=5, check=False)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('Fixed owned canary invocation required', child.stderr)
        self.assertNotIn('Unsafe protected canary validator', child.stderr)
        self.assertEqual(child.stdout, '')

    def test_exact_sequence_preserves_original_ledger_and_exposes_no_rule_continuity_claim(self):
        self.complete_original()
        frozen = copy.deepcopy(self.guest.REPORT['debianRecoveryPreservation']['original'])
        for phase in contract.PHASES['current']:
            self.observe('current', phase)
            self.assertEqual(self.guest.REPORT['debianRecoveryPreservation']['original'], frozen)
        actual = self.guest.REPORT['debianRecoveryPreservation']
        self.assertEqual(actual, self.expected)
        self.assertIsNone(contract.validate_two_boot_preservation(self.old._asdict(), self.new._asdict(), actual))
        self.assertEqual(len(self.calls), 8)
        self.assertEqual([json.loads(call[0][-1])['phase'] for call in self.calls],
                         ['before', 'afterInstall', 'cleanup', 'before', 'afterInstall', 'freshLogin', 'afterRuntime', 'cleanup'])

    def test_bad_phase_binding_and_out_of_order_requests_make_no_root_rpc(self):
        cases = [('original', 'afterInterruptedInstall', self.old), ('original', 'cleanup', self.old),
                 ('current', 'beforeReconciliation', self.new), ('other', 'beforeInstall', self.old),
                 ('original', 'before', self.old), ('original', 'beforeInstall', self.old._asdict())]
        for stage, phase, owner in cases:
            with self.subTest(stage=stage, phase=phase), self.assertRaises((RuntimeError, ValueError)):
                self.subject.observe(stage, phase, owner)
            self.assertEqual(self.calls, [])
        self.observe('original', 'beforeInstall')
        for phase in ('beforeInstall', 'cleanup'):
            with self.subTest(replay=phase), self.assertRaises(RuntimeError):
                self.subject.observe('original', phase, self.old)
            self.assertEqual(len(self.calls), 1)

    def test_original_cleanup_is_required_before_any_current_root_command(self):
        self.observe('original', 'beforeInstall')
        self.observe('original', 'afterInterruptedInstall')
        with self.assertRaises(ValueError):
            self.subject.observe('current', 'beforeReconciliation', self.new)
        self.assertEqual(len(self.calls), 2)
        self.observe('original', 'cleanup')
        for replacement in (self.old, self.new._replace(nonce='44444444-4444-4444-8444-444444444444'),
                            self.new._replace(uid=1001), self.new._replace(manifestSha256=self.old.manifestSha256)):
            with self.subTest(owner=replacement), self.assertRaises(RuntimeError):
                self.subject.observe('current', 'beforeReconciliation', replacement)
            self.assertEqual(len(self.calls), 3)

    def test_historical_ledger_cannot_be_extended_after_current_boot_started(self):
        self.complete_original()
        self.observe('current', 'beforeReconciliation')
        frozen = copy.deepcopy(self.guest.REPORT)
        with self.assertRaises(RuntimeError):
            self.subject.observe('original', 'cleanup', self.old)
        self.assertEqual(self.guest.REPORT, frozen)
        self.assertEqual(len(self.calls), 4)

    def test_root_frame_faults_are_not_appended_as_evidence(self):
        mutations = [lambda f:f.update(backend='legacy'), lambda f:f.update(extra='unreviewed'),
                     lambda f:f.update(cleanup=True), lambda f:f.update(phase='afterInstall'),
                     lambda f:f['binding'].update(uid=True), lambda f:f['service'].update(ExecMainPID='123'),
                     lambda f:f.update(chain='FL'+'0'*20), lambda f:f.update(canary=f['canary'].replace('RETURN','ACCEPT'))]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                self.setUp()
                with self.assertRaises(ValueError):
                    self.observe('original', 'beforeInstall', mutate)
                self.assertEqual(self.guest.REPORT['debianRecoveryPreservation']['original']['observations'], {})

    def test_time_canary_and_configuration_drift_refuse_before_phase_append(self):
        changes = [lambda f:f.update(observedAtMonotonicNs=100),
                   lambda f:f.update(toolVersion='iptables v1.8.12 (nf_tables)'),
                   lambda f:f['configuration']['files']['/etc/nftables.conf'].update(sha256='d'*64)]
        for mutate in changes:
            with self.subTest(mutation=mutate):
                self.setUp()
                self.complete_original()
                self.observe('current', 'beforeReconciliation')
                with self.assertRaises(RuntimeError):
                    self.observe('current', 'afterInspection', mutate)
                self.assertEqual(tuple(self.guest.REPORT['debianRecoveryPreservation']['current']['observations']), ('beforeReconciliation',))

    def test_configuration_drift_across_boots_refuses_first_current_frame(self):
        self.complete_original()
        with self.assertRaises(RuntimeError):
            self.observe('current', 'beforeReconciliation', lambda f:f['configuration']['files']['/etc/nftables.conf'].update(ino='999'))
        self.assertEqual(self.guest.REPORT['debianRecoveryPreservation']['current']['observations'], {})

    def test_duplicate_json_and_oversized_root_output_are_refused(self):
        for text in ('{"binding":{},"binding":{}}', 'x' * 16385):
            with self.subTest(text_length=len(text)):
                self.setUp()
                self.responses.append(text)
                with self.assertRaises((ValueError, RuntimeError)):
                    self.subject.observe('original', 'beforeInstall', self.old)
                self.assertEqual(self.guest.REPORT['debianRecoveryPreservation']['original']['observations'], {})

    def test_renewed_product_boundaries_keep_semantic_ledger_labels(self):
        self.complete_original()
        self.observe('current', 'beforeReconciliation')
        self.observe('current', 'afterInspection')
        for phase in ('freshLogin', 'afterRuntime', 'cleanup'):
            self.responses.append(copy.deepcopy(self.expected['current']['observations'][phase]))
            self.subject.product_boundary(phase, self.new)
        self.assertEqual(self.guest.REPORT['debianRecoveryPreservation'], self.expected)

    def test_remaining_guest_budget_is_forwarded_as_absolute_root_deadline(self):
        self.guest.budget_seconds = lambda maximum: 7
        started = time.monotonic()
        self.observe('original', 'beforeInstall')
        argv, timeout, deadline = self.calls[-1]
        self.assertGreaterEqual(deadline, started + 7)
        self.assertLessEqual(deadline, time.monotonic() + 7)
        self.assertEqual(json.loads(argv[-1])['deadline'], deadline)
        self.assertEqual(timeout, 30)

    def test_product_boundary_cannot_mislabel_normal_completion_as_interruption(self):
        with self.assertRaises(RuntimeError):
            self.subject.product_boundary('afterInstall', self.old)
        self.assertEqual(self.calls, [])
        self.responses.append(copy.deepcopy(self.expected['original']['observations']['beforeInstall']))
        self.subject.product_boundary('before', self.old)
        self.assertEqual(tuple(self.guest.REPORT['debianRecoveryPreservation']['original']['observations']), ('beforeInstall',))
        # A generic product cleanup before reboot must not target the old boot.
        with self.assertRaises(ValueError):
            self.subject.product_boundary('cleanup', self.old)
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    unittest.main()

"""Input and terminal-gate requirements for the manual native verifier wrapper."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('qualification', Path(__file__).with_name('qualify-debian-kvm.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InputContract(unittest.TestCase):
    def setUp(self):
        self.data = {'filter.so': b'filter', 'abuse': b'abuse'}
        self.pins = {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in self.data.items()}
        self.encoded = {name: base64.b64encode(data).decode() for name, data in self.data.items()}

    def test_exact_pair(self):
        self.assertEqual(module.decode_helpers(json.dumps(self.encoded), self.pins), self.data)

    def test_rejects_names_sizes_bytes_and_noncanonical_input(self):
        cases = [None, 'x' * 65536, '[]', '{}', '{"filter.so":"x","filter.so":"y","abuse":"z"}']
        for field, value in [('filter.so', 'not-base64'), ('filter.so', base64.b64encode(b'alter!').decode()), ('abuse', self.encoded['abuse'] + '\n')]:
            changed = dict(self.encoded)
            changed[field] = value
            cases.append(json.dumps(changed))
        changed = dict(self.encoded)
        changed['../other'] = changed.pop('abuse')
        cases.append(json.dumps(changed))
        for value in cases:
            with self.subTest(value=str(value)[:80]), self.assertRaises((ValueError, TypeError)):
                module.decode_helpers(value, self.pins)

    def test_terminal_gate_requires_real_guest_disposal(self):
        source = 'a' * 40
        catalog = '032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d'
        proof = {'ok': True, 'executed': True, 'scope': 'fresh-full-system-guest', 'installationEvidence': 'verified-full-system-guest',
                 'fixture': {'id': 'debian13-amd64', 'catalogSha256': catalog}, 'capabilities': {'architecture': 'x64'},
                 'candidate': {'catalogSha256': catalog, 'internalArtifact': True, 'candidate': {'sha256': 'b' * 64}},
                 'executionArtifact': {'kind': 'internal-candidate', 'sha256': 'b' * 64},
                 'restrictionSource': {'commit': source}, 'accelerator': 'kvm', 'boot': {'accelerator': 'kvm'},
                 'ownedGuestCustody': {'fixtureCustodyValidated': True},
                 'guest': {'ok': True, 'runs': [{}, {}], 'installationEvidence': 'verified-full-system-guest', 'sentinelCleanup': True,
                           'restrictionProbe': {'exitCode': 0, 'result': {'bounded_probe_passed': True, 'cleanup_complete': True}}},
                 'cleanup': {'ownedVmReaped': True, 'credentialsRemoved': True},
                 'artifactDisposal': {'complete': True}, 'humanConsentProof': False}
        self.assertTrue(module.accepted_guest(proof, source))
        for field in proof:
            invalid = dict(proof)
            invalid.pop(field)
            with self.subTest(field=field):
                self.assertFalse(module.accepted_guest(invalid, source))
        for field, value in [('accelerator', 'tcg'), ('restrictionSource', {'commit': 'c' * 40}), ('guest', {'ok': True, 'runs': [{}, {}]}), ('ok', False), ('installationEvidence', 'pending'), ('cleanup', {'ownedVmReaped': True, 'credentialsRemoved': False}), ('artifactDisposal', {'complete': False}), ('humanConsentProof', True)]:
            with self.subTest(field=field):
                self.assertFalse(module.accepted_guest({**proof, field: value}, source))

    def test_output_limit_retires_command_before_later_side_effect(self):
        import tempfile
        import sys
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'marker'
            program = "import os,time,pathlib; os.write(1,b'x'*(9*1024*1024)); time.sleep(3); pathlib.Path(" + repr(str(marker)) + ").write_text('late')"
            with self.assertRaises(RuntimeError):
                module.run([sys.executable, '-I', '-c', program], timeout=10)
            self.assertFalse(marker.exists(), 'Output budget must retire the child before it continues')

    def test_frozen_tool_plan_refuses_upgrades_removals_and_changed_closure(self):
        manifest = {'packages': [{'name': 'qemu-utils', 'version': '1:8.2.2', 'suite': 'noble-updates', 'architecture': 'amd64'}]}
        text = '0 upgraded, 1 newly installed, 0 to remove and 6 not upgraded.\nInst qemu-utils (1:8.2.2 Ubuntu:24.04/noble-updates [amd64])\nConf qemu-utils (1:8.2.2 Ubuntu:24.04/noble-updates [amd64])\n'
        self.assertEqual(set(module.validate_tool_plan(text, manifest)), {'qemu-utils'})
        cases = [text.replace('0 upgraded', '1 upgraded'), text + 'Remv docker-ce [5:28.0.4]\n',
                 text.replace('1:8.2.2', '1:8.2.3'), text.replace('Inst qemu-utils (', 'Inst qemu-utils [old] ('),
                 text + 'Inst extra (1 Ubuntu:24.04/noble [amd64])\n', text.replace('Conf qemu-utils', 'Conf other')]
        for invalid in cases:
            with self.subTest(input=invalid), self.assertRaises(ValueError):
                module.validate_tool_plan(invalid, manifest)

    def test_host_tool_baseline_refuses_retained_or_foreign_state_before_preparation(self):
        manifest = {'packages': [{'name': 'tool'}]}
        absent = {'version': '', 'architecture': '', 'status': 'not-installed', 'error': 'ok'}
        module.validate_tool_baseline({}, manifest)
        module.validate_tool_baseline({'tool': absent}, manifest)
        cases = [{'tool': {**absent, 'status': 'config-files', 'version': '1', 'architecture': 'amd64'}},
                 {'tool': {**absent, 'version': '1'}}, {'tool:i386': absent},
                 {'tool': absent, 'tool:amd64': absent}]
        for snapshot in cases:
            with self.subTest(snapshot=snapshot), self.assertRaises(ValueError):
                module.validate_tool_baseline(snapshot, manifest)

    def test_actual_package_delta_is_exact_and_preserves_unrelated_packages(self):
        manifest = {'packages': [{'name': 'tool', 'version': '1', 'architecture': 'amd64'}]}
        base = {'old': {'version': '2', 'architecture': 'amd64', 'status': 'installed', 'error': 'ok'}}
        after = {**base, 'tool:amd64': {'version': '1', 'architecture': 'amd64', 'status': 'installed', 'error': 'ok'}}
        self.assertTrue(module.validate_package_delta(base, after, manifest)['otherPackagesUnchanged'])
        cases = [{**after, 'extra': base['old']}, {**after, 'old': {**base['old'], 'version': '3'}},
                 {**after, 'tool:amd64': {**after['tool:amd64'], 'error': 'reinstreq'}},
                 {**after, 'tool:i386': {**after['tool:amd64'], 'architecture': 'i386'}},
                 {**after, 'tool:amd64': {**after['tool:amd64'], 'version': 'other'}}]
        for invalid in cases:
            with self.subTest(delta=invalid), self.assertRaises(ValueError):
                module.validate_package_delta(base, invalid, manifest)
        with self.assertRaises(ValueError):
            module.validate_package_delta(after, after, manifest)

    def test_host_query_failure_retains_bounded_diagnostic_without_payload_arguments(self):
        import sys
        with self.assertRaises(RuntimeError) as caught:
            module.run([sys.executable, '-I', '-c', "import sys; sys.stderr.write('fixed permission refusal'); sys.exit(7)"])
        diagnostic = caught.exception.diagnostic
        self.assertEqual(diagnostic['exitCode'], 7)
        self.assertEqual(diagnostic['stderr'], 'fixed permission refusal')
        self.assertNotIn('arguments', diagnostic)

    def test_kvm_probe_requires_actual_ordinary_native_access(self):
        proof = {'system': 'Linux', 'architecture': 'x86_64', 'effectiveRoot': False,
                 'kvm': {'apiVersion': 12, 'device': 'observed', 'characterDevice': True}}
        self.assertTrue(module.accepted_kvm_probe(proof))
        for changed in ({**proof, 'effectiveRoot': True}, {**proof, 'architecture': 'aarch64'},
                        {**proof, 'kvm': {'device': 'permission-denied'}}, {**proof, 'kvm': {'apiVersion': 12}}):
            self.assertFalse(module.accepted_kvm_probe(changed))

    def test_not_found_is_the_only_nonzero_service_observation(self):
        from unittest.mock import patch
        class Result:
            returncode = 1
            stdout = b'LoadState=not-found\nActiveState=inactive\nSubState=dead\n'
        with patch.object(module, 'run', return_value=Result()):
            self.assertEqual(module.service_state('fixed.service')['LoadState'], 'not-found')
            Result.stdout = b'LoadState=loaded\n'
            with self.assertRaises(RuntimeError):
                module.service_state('fixed.service')
            Result.stdout = b''
            with self.assertRaises(RuntimeError):
                module.service_state('fixed.service')


if __name__ == '__main__':
    unittest.main()

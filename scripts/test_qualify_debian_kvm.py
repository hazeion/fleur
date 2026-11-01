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
    def test_workout_proof_is_a_separate_case_with_the_fixed_helper_pair(self):
        self.assertEqual(module.qualification_case({'debian_helpers':'pair','workout_proof':True}), 'workout-production')
        for inputs in ({'workout_proof':True}, {'debian_helpers':'pair','workout_proof':True,'debian_recovery':True}, {'workout_proof':True,'arch_boot_observation':True}):
            with self.subTest(inputs=inputs), self.assertRaises(ValueError): module.qualification_case(inputs)

    def launch_fixture(self, directory, budget=60):
        from types import SimpleNamespace
        service = module.Service(Path(directory), 1001, 108, [], {}, budget)
        service.group = SimpleNamespace(exists=lambda: False, lstat=lambda: SimpleNamespace(st_mode=0o40755, st_uid=0), is_symlink=lambda: False)
        current = {'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running',
                   'MainPID': '123', 'User': '1001', 'Group': '108', 'KillMode': 'control-group',
                   'Delegate': 'no', 'RuntimeMaxUSec': str(budget)+'s', 'TimeoutStopUSec': '45s',
                   'ControlGroup': '/system.slice/'+service.unit, 'InvocationID': 'a'*32}
        return service, current

    def launch_with(self, service, observations, cgroup=None):
        from types import SimpleNamespace
        from unittest.mock import patch
        def observe(unit):
            self.assertFalse(service.gate.exists(), 'Startup observation must precede execution release')
            return next(observations)
        try:
            with patch.object(module, 'service_state', side_effect=observe), patch.object(module.subprocess, 'Popen', return_value=SimpleNamespace(poll=lambda: None)), patch.object(Path, 'read_text', return_value=cgroup if cgroup is not None else '0::/system.slice/'+service.unit), patch.object(module.time, 'sleep'):
                service.launch()
        finally:
            for name in ('out', 'err'):
                stream = getattr(service, name, None)
                if stream: stream.close()

    def test_startup_waits_for_active_before_releasing_exact_bound_invocation(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            service, active = self.launch_fixture(directory)
            starting = {**active, 'ActiveState': 'activating', 'SubState': 'start'}
            self.launch_with(service, iter([{'LoadState':'not-found'}, starting, active]))
            self.assertTrue(service.gate.exists())
            self.assertEqual(service.bound['InvocationID'], active['InvocationID'])

    def test_two_second_budget_never_accepts_zero_minutes(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            service, active = self.launch_fixture(directory, 2)
            with self.assertRaises(RuntimeError):
                self.launch_with(service, iter([{'LoadState':'not-found'}, {**active, 'RuntimeMaxUSec':'0min'}]))
            self.assertFalse(service.gate.exists())
            self.assertIsNone(service.bound)

    def test_provisional_start_cannot_change_invocation_or_pid(self):
        import tempfile
        for field, value in [('InvocationID','b'*32), ('MainPID','124')]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                service, active = self.launch_fixture(directory)
                with self.assertRaises(RuntimeError):
                    self.launch_with(service, iter([{'LoadState':'not-found'}, {**active, 'ActiveState':'activating'}, {**active, field:value}]))
                self.assertFalse(service.gate.exists())
                self.assertEqual(service.bound['InvocationID'], 'a'*32)

    def test_each_immutable_startup_contract_refuses_before_binding_or_release(self):
        import tempfile
        changes = {'LoadState':'masked', 'User':'0', 'Group':'0', 'KillMode':'process',
                   'Delegate':'yes', 'TimeoutStopUSec':'46s', 'ControlGroup':'/unrelated',
                   'RuntimeMaxUSec':'61s', 'InvocationID':'bad', 'MainPID':'-1'}
        for field, value in changes.items():
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                service, active = self.launch_fixture(directory)
                with self.assertRaises(RuntimeError) as caught:
                    self.launch_with(service, iter([{'LoadState':'not-found'}, {**active, field:value}]))
                self.assertFalse(service.gate.exists())
                self.assertIsNone(service.bound)
                self.assertIn(field, caught.exception.diagnostic['mismatchedFields'])

    def test_persistent_startup_retains_cleanup_only_identity_at_original_deadline(self):
        import io
        import tempfile
        from types import SimpleNamespace
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            service, active = self.launch_fixture(directory)
            starting = {**active, 'ActiveState':'activating'}
            with patch.object(module.time, 'monotonic', side_effect=[0, 0, 21]), self.assertRaises(RuntimeError) as caught:
                self.launch_with(service, iter([{'LoadState':'not-found'}, starting]))
            self.assertEqual(caught.exception.diagnostic['mismatchedFields'], ['startupDeadline'])
            self.assertFalse(service.gate.exists())
            self.assertEqual(service.bound['InvocationID'], 'a'*32)
            service.out, service.err = io.BytesIO(), io.BytesIO()
            receipt = {'invocationId':'a'*32, 'cgroup':'0::/system.slice/'+service.unit, 'uid':1001}
            service.terminal.write_text(json.dumps(receipt))
            with patch.object(module, 'service_state', return_value=starting), patch.object(module, 'run') as command:
                service.stop()
                self.assertEqual(command.call_args.args[0][-1], service.unit)
            with patch.object(module, 'bounded_capture', return_value=(0,b'',b'',False,False)), patch.object(module, 'service_state', return_value={'LoadState':'not-found'}), patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=0o100644, st_uid=1001, st_nlink=1, st_size=100)):
                result = service.wait()
            self.assertTrue(result['cancelled'])
            self.assertTrue(result['cgroupAbsent'])
            self.assertTrue(service.waited)
            self.assertFalse(service.gate.exists())

    def test_startup_diagnostics_never_publish_private_or_unbounded_values(self):
        diagnostic = module.binding_failure({'User':'private/path', 'InvocationID':'a'*32,
                                             'ExecStart':'private-command', 'SubState':'private/path'*100}, ['User']).diagnostic
        self.assertNotIn('private', json.dumps(diagnostic))
        self.assertNotIn('ExecStart', diagnostic['observed'])
        self.assertEqual(diagnostic['observed']['InvocationID'], hashlib.sha256(('a'*32).encode()).hexdigest())
        all_private = {name:'private-secret' for name in module.SERVICE_FIELDS}
        self.assertNotIn('private', json.dumps(module.binding_failure(all_private, ['User']).diagnostic))

    def test_exited_client_still_requires_terminal_receipt_and_cgroup_disposal(self):
        import io
        import tempfile
        from types import SimpleNamespace
        from unittest.mock import patch
        for missing, live in ((False,False), (True,False), (False,True)):
            with self.subTest(missing=missing, live=live), tempfile.TemporaryDirectory() as directory:
                service, active = self.launch_fixture(directory)
                service.bound = active
                service.child = SimpleNamespace(poll=lambda: 0)
                service.group.exists = lambda: live
                service.out, service.err = io.BytesIO(), io.BytesIO()
                if not missing:
                    service.terminal.write_text(json.dumps({'invocationId':'a'*32, 'cgroup':'0::/system.slice/'+service.unit, 'uid':1001}))
                original_stat = Path.lstat
                def receipt_stat(path):
                    if not missing and path == service.terminal:
                        return SimpleNamespace(st_mode=0o100644, st_uid=1001, st_nlink=1, st_size=100)
                    return original_stat(path)
                with patch.object(module, 'bounded_capture', return_value=(0,b'',b'',False,False)) as capture, patch.object(module, 'service_state', return_value={'LoadState':'not-found'}), patch.object(Path, 'lstat', new=receipt_stat), patch.object(module.time, 'monotonic', side_effect=[0,11]), patch.object(service, 'stop') as stop:
                    self.assertEqual(module.retire_services([service]), not missing and not live)
                    capture.assert_called_once()
                    stop.assert_not_called()
                self.assertEqual(service.waited, not missing and not live)

    def test_pid_outside_exact_root_managed_cgroup_never_acquires_cleanup_authority(self):
        import tempfile
        from types import SimpleNamespace
        for wrong_owner in (False, True):
            with self.subTest(wrong_owner=wrong_owner), tempfile.TemporaryDirectory() as directory:
                service, active = self.launch_fixture(directory)
                if wrong_owner:
                    service.group.lstat = lambda: SimpleNamespace(st_mode=0o40755, st_uid=1001)
                with self.assertRaises(RuntimeError):
                    self.launch_with(service, iter([{'LoadState':'not-found'}, active]), cgroup='0::/unrelated')
                self.assertFalse(service.gate.exists())
                self.assertIsNone(service.bound)

    def test_cancelled_start_cannot_release_even_a_fully_active_service(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            service, active = self.launch_fixture(directory)
            service.cancelled = True
            with self.assertRaises(RuntimeError):
                self.launch_with(service, iter([{'LoadState':'not-found'}, active]))
            self.assertFalse(service.gate.exists())
            self.assertEqual(service.bound['InvocationID'], 'a'*32)

    def setUp(self):
        self.data = {'filter.so': b'filter', 'abuse': b'abuse'}
        self.pins = {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in self.data.items()}
        self.encoded = {name: base64.b64encode(data).decode() for name, data in self.data.items()}

    def test_exact_pair(self):
        self.assertEqual(module.decode_helpers(json.dumps(self.encoded), self.pins), self.data)

    def test_only_independently_reviewed_runner_images_admit_tool_preparation(self):
        manifest = json.loads(Path(__file__).with_name('native-kvm-host-tools.json').read_text())
        for image in ('20261012.334.1', '20261023.334.3'):
            with self.subTest(image=image):
                self.assertEqual(module.admit_runner_image(manifest, image)['version'], image)
        for image in (None, '', '20261023.334.4', '20261012.334', 'latest', '*', '20261023.334.3\n'):
            with self.subTest(image=image), self.assertRaises(ValueError):
                module.admit_runner_image(manifest, image)
        for change in ('duplicate', 'wildcard', 'evidence', 'unknown-field', 'boolean-attempt'):
            malformed = json.loads(json.dumps(manifest))
            if change == 'duplicate': malformed['runnerImages'].append(malformed['runnerImages'][0])
            if change == 'wildcard': malformed['runnerImages'][0]['version'] = '*'
            if change == 'evidence': malformed['runnerImages'][0]['inventoryReportSha256'] = 'bad'
            if change == 'unknown-field': malformed['runnerImages'][0]['extra'] = True
            if change == 'boolean-attempt': malformed['runnerImages'][0]['inventoryRunAttempt'] = True
            with self.subTest(change=change), self.assertRaises(ValueError):
                module.admit_runner_image(malformed, '20261012.334.1')

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

    def ready(self, command):
        evidence = '6b4066ed5c199006695d769d07ec5d813fa8cddff1d396a089e1749d6c27231e'
        return {'exitCode': 0, 'result': {'formatVersion': 1, 'command': command, 'ok': True, 'error': None, 'truncated': False,
                'data': {'components': {**{name: {'state': 'ready'} for name in ('cli', 'daemon', 'compose')},
                    'smoke': {'state': 'ready', 'cleanup': True}, 'release': {'state': 'verified', 'floor': 'debian-x64-engine', 'admission': 'measured', 'measuredRows': ['debian-13-x64-docker-29.9.1'],
                        'machineTools': [{'tool': tool, 'status': 'verified', 'floor': version, 'detected': version, 'comparison': 'equal'} for tool, version in (('release', '13'), ('kernel', '6.12.113+deb13-cloud-amd64'), ('bun', '1.4.3'), ('cli', '29.9.1'), ('engine', '29.9.1'), ('compose', '5.6.0'), ('containerd', 'v2.4.2'), ('runc', '1.5.2'))],
                        'evidence': {'readinessSha256': evidence, 'isolationSha256': evidence}}}}}}

    def test_terminal_gate_requires_real_guest_disposal(self):
        source = 'a' * 40
        catalog = '032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d'
        proof = {'ok': True, 'executed': True, 'scope': 'fresh-full-system-guest', 'installationEvidence': 'verified-full-system-guest',
                 'fixture': {'id': 'debian13-amd64', 'catalogSha256': catalog}, 'capabilities': {'architecture': 'x64'},
                 'candidate': {'catalogSha256': catalog, 'internalArtifact': True, 'ordinary': {'sha256': 'b' * 64}},
                 'executionArtifact': {'kind': 'ordinary', 'sha256': 'b' * 64},
                 'restrictionSource': {'commit': source}, 'accelerator': 'kvm', 'boot': {'accelerator': 'kvm'},
                 'ownedGuestCustody': {'fixtureCustodyValidated': True},
                 'guest': {'ok': True, 'executionArtifact': {'kind': 'ordinary', 'packageName': 'fleur', 'artifactCatalogSha256': catalog}, 'runs': [self.ready('doctor'), self.ready('doctor')], 'readySetupReprobes': [{**self.ready('setup'), 'snapshotPreserved': True, 'grantsPreserved': True} for _ in range(2)], 'debianDependencyPreservation': {'backend': 'nf_tables', 'cleanup': True, 'observations': {phase: {} for phase in ('before', 'afterInstall', 'freshLogin', 'afterRuntime')}}, 'installationEvidence': 'verified-full-system-guest', 'sentinelCleanup': True,
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

        import copy
        mutations = [
            lambda p: p['executionArtifact'].update(kind='internal-candidate'),
            lambda p: p['guest']['executionArtifact'].update(packageName='fleur-internal-native-verification'),
            lambda p: p['guest']['executionArtifact'].update(kind='internal-candidate'),
            lambda p: p['guest']['executionArtifact'].update(artifactCatalogSha256='c'*64),
            lambda p: p['candidate']['ordinary'].update(sha256='c'*64),
            lambda p: p['guest']['runs'][0].update(exitCode=4),
            lambda p: p['guest']['runs'][1]['result']['data']['components']['release'].update(profile='ubuntu-26.04-x64-docker-29.9.1'),
            lambda p: p['guest']['readySetupReprobes'].pop(),
            lambda p: p['guest']['readySetupReprobes'][0].update(snapshotPreserved=False),
            lambda p: p['guest']['readySetupReprobes'][1].update(grantsPreserved=False),
            lambda p: p['guest']['debianDependencyPreservation'].update(cleanup=False),
            lambda p: p['guest']['debianDependencyPreservation']['observations'].pop('freshLogin'),
        ]
        for mutate in mutations:
            invalid = copy.deepcopy(proof)
            mutate(invalid)
            self.assertFalse(module.accepted_guest(invalid, source))

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

    def test_stop_accepts_already_collected_service_only_after_independent_absence(self):
        import tempfile
        import subprocess
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            service = module.Service(Path(directory), 1001, 108, [], {})
            service.bound = {'InvocationID': 'a' * 32}
            absent = {'LoadState': 'not-found'}
            stopped = subprocess.CompletedProcess([], 5, b'', b'Unit not loaded')
            def stop_command(args, timeout=30, allowed=(0,)):
                self.assertEqual(args, ['sudo', '-n', '/usr/bin/systemctl', 'stop', '--no-block', service.unit])
                if stopped.returncode not in allowed:
                    raise RuntimeError('Fixed host command failed: sudo')
                return stopped
            with patch.object(module, 'service_state', side_effect=[service.bound, absent]), patch.object(module, 'run', side_effect=stop_command):
                service.stop()
            self.assertTrue(service.cancelled)
            self.assertEqual(service.stopCommands, 1)
            with patch.object(module, 'service_state', return_value=absent), patch.object(module, 'run') as command:
                service.stop()
                command.assert_not_called()
            self.assertEqual(service.stopCommands, 1)
            for current in ({'LoadState': 'loaded', 'InvocationID': 'b' * 32}, service.bound):
                with self.subTest(current=current), patch.object(module, 'service_state', side_effect=[service.bound, current]), patch.object(module, 'run', side_effect=stop_command):
                    with self.assertRaises(RuntimeError):
                        service.stop()
            for code in (1, 4):
                stopped.returncode = code
                with self.subTest(code=code), patch.object(module, 'service_state', return_value=service.bound), patch.object(module, 'run', side_effect=stop_command):
                    with self.assertRaises(RuntimeError):
                        service.stop()
            stopped.returncode = 5
            with patch.object(module, 'service_state', side_effect=[service.bound, RuntimeError('Metadata unavailable')]), patch.object(module, 'run', side_effect=stop_command):
                with self.assertRaises(RuntimeError):
                    service.stop()
            service.group = Path(directory)
            with patch.object(module, 'service_state', side_effect=[service.bound, absent]), patch.object(module, 'run', side_effect=stop_command):
                with self.assertRaises(RuntimeError):
                    service.stop()
            with patch.object(module, 'service_state', return_value=absent), patch.object(module, 'run') as command:
                with self.assertRaises(RuntimeError):
                    service.stop()
                command.assert_not_called()


if __name__ == '__main__':
    unittest.main()

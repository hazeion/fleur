"""Portable recorded-policy refusals; genuine compiled acceptance is a native run."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

BASE = 'oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e'


class RecordedPolicy(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fleur-recorded-policy-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.policy = self.root/'probe'
        self.policy.mkdir(mode=0o700)
        self.output = self.root/'output'
        self.output.mkdir(mode=0o700)
        for name in ('helper_artifacts.py', 'recorded-helper-origin.json', 'filter.c', 'abuse.c'):
            shutil.copyfile(Path(__file__).with_name(name), self.policy/name)
        module_name = 'fleur_recorded_policy_' + str(id(self))
        spec = importlib.util.spec_from_file_location(module_name, self.policy/'helper_artifacts.py')
        self.module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = self.module
        self.addCleanup(sys.modules.pop, module_name)
        spec.loader.exec_module(self.module)

    def test_current_source_drift_refuses_before_artifact_io(self):
        path = self.policy/'filter.c'
        data = path.read_bytes()
        path.write_bytes(b'X'+data[1:])
        with self.assertRaisesRegex(ValueError, 'recorded helper source'):
            self.module.stage_recorded_helpers(self.root/'absent', self.output, 'amd64', BASE, time.monotonic()+5)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_changed_source_owned_manifest_is_not_a_policy_override(self):
        path = self.policy/'recorded-helper-origin.json'
        data = path.read_bytes()
        path.write_bytes(data.replace(b'13.3.0', b'13.4.0'))
        with self.assertRaisesRegex(ValueError, 'recorded helper manifest differs'):
            self.module.stage_recorded_helpers(self.root/'absent', self.output, 'amd64', BASE, time.monotonic()+5)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_foreign_base_refuses_before_artifact_io(self):
        with self.assertRaisesRegex(ValueError, 'recorded helper profile'):
            self.module.stage_recorded_helpers(self.root/'absent', self.output, 'amd64', 'unapproved-base', time.monotonic()+5)
        self.assertEqual(list(self.output.iterdir()), [])

    def report_fixture(self):
        # Report-schema data only. No files are staged and no native execution is claimed.
        metadata = json.loads((self.policy/'recorded-helper-origin.json').read_text())
        origin = {'mode': 'recorded-prebuilt',
                  'manifest_sha256': '26167bf5307aacabbec7f51e05e348418170d98075baa1964b971460988cf47b',
                  'architecture': 'amd64', 'base_image': BASE, 'local_compiler_executed': False,
                  'producer': metadata['producer'],
                  'source_sha256': {'filter.c': '533a20d7d4e151f023146a216cc802231669c08113533fde09253892030043dc',
                                    'abuse.c': '610850ac43bff233b887e27626cee91f93fd2c74c98befe1f03ae92a7d7b179a'},
                  'helpers': metadata['helpers']}
        return {'compiler_status': 'prebuilt-origin', 'compiler_pin_verified': False,
                'expected_gcc': '13.3.0',
                'expected_gcc_binary_sha256': '1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26',
                'architecture': 'amd64', 'base_image': BASE, 'helper_origin': origin,
                'source_sha256': dict(origin['source_sha256']),
                'helper_sha256': '99e38df6acbde709100bfcf80c02eee49d364abd8b89838c006e572344da7ab4',
                'abuse_sha256': '67e15a766caaae73f1068cec21150160c8d9d80fcdf527e461d3ed35fae4a1c8',
                'helper_elf': {'class': 64, 'endianness': 'little', 'machine': 62},
                'abuse_elf': {'class': 64, 'endianness': 'little', 'machine': 62}}

    def test_recorded_report_schema_keeps_local_and_producer_facts_distinct(self):
        observed = self.report_fixture()
        self.assertTrue(self.module.accept_helper_origin(observed, True, time.monotonic()+5))
        self.assertFalse(observed['compiler_pin_verified'])
        self.assertTrue(observed['helper_origin']['producer']['compilerExecuted'])

    def test_crossed_expected_compiler_pin_is_not_a_valid_origin_report(self):
        observed = self.report_fixture()
        observed['expected_gcc_binary_sha256'] = '0'*64
        self.assertFalse(self.module.accept_helper_origin(observed, True, time.monotonic()+5))

    def test_report_cannot_claim_local_compiler_execution(self):
        observed = self.report_fixture()
        observed['compiler_pin_verified'] = True
        self.assertFalse(self.module.accept_helper_origin(observed, True, time.monotonic()+5))

    def test_report_false_must_not_be_integer_zero(self):
        observed = self.report_fixture()
        observed['compiler_pin_verified'] = 0
        self.assertFalse(self.module.accept_helper_origin(observed, True, time.monotonic()+5))

    def test_producer_execution_fact_must_not_be_integer_one(self):
        observed = self.report_fixture()
        observed['helper_origin']['producer']['compilerExecuted'] = 1
        self.assertFalse(self.module.accept_helper_origin(observed, True, time.monotonic()+5))

    def test_report_cannot_cross_second_helper_hash(self):
        observed = self.report_fixture()
        observed['abuse_sha256'] = observed['helper_sha256']
        self.assertFalse(self.module.accept_helper_origin(observed, True, time.monotonic()+5))

    def test_origin_validation_cannot_accept_late_manifest_completion(self):
        observed=self.report_fixture()
        deadline=time.monotonic()+5
        read=os.read
        now=time.monotonic
        late=False
        def delayed_eof(fd, count):
            nonlocal late
            block=read(fd,count)
            if not block:
                late=True
            return block
        with patch.object(os, 'read', side_effect=delayed_eof), patch.object(time, 'monotonic', side_effect=lambda:deadline+1 if late else now()):
            self.assertFalse(self.module.accept_helper_origin(observed, True, deadline))
        self.assertTrue(late)


if __name__ == '__main__':
    unittest.main()

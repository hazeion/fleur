"""Raw Arch identity and existing manifest contracts through real custody files."""
import hashlib
import json
import os
import unittest
from unittest.mock import patch
import test_owned_guest as custody_fixture

NONCE, BOOT = custody_fixture.NONCE, custody_fixture.BOOT


class OwnedArchGuestRequirements(unittest.TestCase):
    raw = 'NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n'

    def setUp(self):
        self.fixture = custody_fixture.OwnedGuestCustody('runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def observe(self, *args, **kwargs):
        return self.fixture.observe(*args, **kwargs)

    def record(self, raw=None):
        return {'id': 'arch', 'versionId': None, 'buildId': 'rolling',
                'sha256': hashlib.sha256((self.raw if raw is None else raw).encode()).hexdigest()}

    def test_arch_custody_retains_literal_version_absence_and_raw_build_identity(self):
        code, report = self.observe(raw_release=self.raw, expected_os=self.record())
        self.assertEqual(code, 0)
        self.assertTrue(report['fixtureCustodyValidated'])
        self.assertEqual(report['osRelease'], self.record())
        self.assertFalse(report['runtimeAdmission'])
        self.assertFalse(report['humanConsentProof'])

    def test_arch_root_producer_and_reobservation_use_the_same_raw_record(self):
        code, report = self.observe('produce', arguments=['--create-arch', NONCE], raw_release=self.raw, expected_os=self.record())
        self.assertEqual(code, 0)
        self.assertEqual(self.fixture.produced_manifest, {'formatVersion': 1, 'nonce': NONCE, 'bootId': BOOT,
                                                 'uid': 1000, 'osRelease': self.record()})
        self.assertTrue(report['ok'])

    def test_arch_cannot_supply_a_version_or_omit_change_or_duplicate_its_build(self):
        for raw in (self.raw + 'VERSION_ID=rolling\n', self.raw + 'VERSION_ID=""\n',
                    self.raw.replace('BUILD_ID=rolling\n', ''), self.raw.replace('rolling', 'stable'),
                    self.raw + 'BUILD_ID=rolling\n', self.raw.replace('ID=arch', 'ID=archlinux'),
                    self.raw.replace('ID=arch', 'ID="arch'), self.raw.replace('rolling', '"rolling')):
            with self.subTest(raw=raw):
                code, report = self.observe(raw_release=raw, expected_os=self.record(raw))
                self.assertEqual(code, 4)
                self.assertFalse(report['ok'])

    def test_normalized_release_cannot_be_forged_into_the_root_manifest(self):
        for changed in ({**self.record(), 'versionId': 'rolling'},
                        {key: value for key, value in self.record().items() if key != 'buildId'},
                        {**self.record(), 'release': 'rolling'}):
            with self.subTest(record=changed):
                code, report = self.observe(raw_release=self.raw, expected_os=changed)
                self.assertEqual(code, 4)
                self.assertFalse(report['ok'])

    def test_arch_cannot_be_created_as_an_existing_distribution_or_wrong_architecture(self):
        for option in ('--create', '--create-ubuntu26', '--create-debian13'):
            with self.subTest(option=option):
                code, report = self.observe('produce', arguments=[option, NONCE], raw_release=self.raw, expected_os=self.record())
                self.assertEqual(code, 4)
                self.assertFalse(report['ok'])
        code, report = self.observe(raw_release=self.raw, expected_os=self.record(), architecture='aarch64')
        self.assertEqual(code, 4)
        self.assertFalse(report['ok'])

    def test_arch_actual_root_control_round_trip_keeps_the_existing_closed_reply(self):
        replies = []
        def round_trip(fixture):
            response = fixture.root_cli(['--verify-control', fixture.context.root_payload(), '--budget-seconds', '0.25'])
            self.assertEqual(response.returncode, 0)
            reply = json.loads(response.stdout)
            self.assertTrue(reply['rootValidation'])
            self.assertEqual((reply['nonce'], reply['bootId'], reply['uid'], reply['manifestSha256']), fixture.context.original)
            self.assertNotIn('osRelease', reply)
            self.assertFalse(reply['runtimeAdmission'])
            replies.append(set(reply))
        binding = {'nonce': NONCE, 'boot_id': BOOT, 'uid': 1000, 'manifest_sha256': 'fixture'}
        for arguments in ({'raw_release': self.raw, 'expected_os': self.record()}, {'distribution': 'debian', 'release': '13'}):
            code, report = self.observe(control_binding=binding, action=round_trip, **arguments)
            self.assertEqual(code, 0)
            self.assertTrue(report['ok'])
        self.assertEqual(replies[0], replies[1])

    def test_arch_root_control_refuses_replaced_os_bytes_even_with_unchanged_public_binding(self):
        def drift(fixture):
            payload = fixture.context.root_payload()
            path = fixture.root / 'usr/lib/os-release'
            path.chmod(0o644)
            path.write_text(self.raw + 'VERSION_ID=rolling\n')
            path.chmod(0o444)
            response = fixture.root_cli(['--verify-control', payload, '--budget-seconds', '0.25'])
            self.assertEqual(response.returncode, 4)
            reply = json.loads(response.stdout)
            self.assertFalse(reply['ok'])
            self.assertNotIn('rootValidation', reply)
        code, report = self.observe(raw_release=self.raw, expected_os=self.record(),
            control_binding={'nonce': NONCE, 'boot_id': BOOT, 'uid': 1000, 'manifest_sha256': 'fixture'}, action=drift)
        self.assertEqual(code, 0)
        self.assertTrue(report['ok'])

    def test_original_three_distribution_manifests_keep_their_exact_canonical_bytes(self):
        original_write = os.write
        for distribution, release, option in [('ubuntu', '24.04', '--create'), ('ubuntu', '26.04', '--create-ubuntu26'), ('debian', '13', '--create-debian13')]:
            with self.subTest(distribution=distribution, release=release):
                chunks = []
                def capture(fd, body):
                    written = original_write(fd, body)
                    chunks.append(body[:written])
                    return written
                with patch('owned_guest.os.write', side_effect=capture):
                    code, report = self.observe('produce', arguments=[option, NONCE], distribution=distribution, release=release)
                self.assertEqual(code, 0)
                self.assertTrue(report['ok'])
                raw = f'ID={distribution}\nVERSION_ID="{release}"\n'.encode()
                expected = {'formatVersion': 1, 'nonce': NONCE, 'bootId': BOOT, 'uid': 1000,
                    'osRelease': {'id': distribution, 'versionId': release, 'sha256': hashlib.sha256(raw).hexdigest()}}
                self.assertEqual(b''.join(chunks), json.dumps(expected, sort_keys=True, separators=(',', ':')).encode())


if __name__ == '__main__':
    unittest.main()

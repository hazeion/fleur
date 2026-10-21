"""Portable fixed-name artifact tests; text fixtures never stand for native ELF."""
from pathlib import Path
import os
import tempfile
import time
import unittest
from unittest.mock import patch
from helper_artifacts import ArtifactPin, PairSpec, stage_pair


TEXT_PAIR = PairSpec(
    ArtifactPin(3, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'),
    ArtifactPin(5, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'))


class PairArtifacts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fleur-pair-contract-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'input'
        self.destination = self.root / 'context'
        self.source.mkdir(mode=0o700)
        self.destination.mkdir(mode=0o700)
        for name, body in [('filter.so', b'abc'), ('abuse', b'hello')]:
            path = self.source / name
            path.write_bytes(body)
            path.chmod(0o600)

    def test_stages_two_fixed_names_as_artifact_data(self):
        observed = stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertEqual((self.destination/'filter.so').read_bytes(), b'abc')
        self.assertEqual((self.destination/'abuse').read_bytes(), b'hello')
        self.assertEqual(set(path.name for path in self.destination.iterdir()), {'filter.so', 'abuse'})
        self.assertEqual(observed['files']['filter.so']['sha256'], TEXT_PAIR.filter.sha256)
        self.assertEqual(observed['files']['abuse']['bytes'], 5)

    def test_changed_second_artifact_refuses_before_any_publication(self):
        (self.source/'abuse').write_bytes(b'HELLO')
        with self.assertRaisesRegex(ValueError, 'artifact digest'):
            stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_symlink_to_matching_bytes_refuses_before_publication(self):
        (self.source/'filter.so').rename(self.source/'real-filter')
        (self.source/'filter.so').symlink_to('real-filter')
        with self.assertRaisesRegex(ValueError, 'artifact custody'):
            stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_existing_destination_is_preserved(self):
        (self.destination/'filter.so').write_bytes(b'foreign')
        with self.assertRaisesRegex(ValueError, 'artifact publication'):
            stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertEqual((self.destination/'filter.so').read_bytes(), b'foreign')
        self.assertFalse((self.destination/'abuse').exists())

    def test_expired_absolute_budget_does_not_publish(self):
        with self.assertRaisesRegex(ValueError, 'artifact deadline'):
            stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()-1)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_matching_source_name_replacement_during_read_refuses(self):
        original = (self.source/'filter.so').stat()
        read = os.read
        fired = False
        def replace_name(fd, count):
            nonlocal fired
            block = read(fd, count)
            if not fired and os.fstat(fd).st_ino == original.st_ino:
                fired = True
                (self.source/'filter.so').rename(self.source/'retained-filter')
                (self.source/'filter.so').write_bytes(b'abc')
                (self.source/'filter.so').chmod(0o600)
            return block
        with patch.object(os, 'read', side_effect=replace_name):
            with self.assertRaisesRegex(ValueError, 'artifact custody'):
                stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertTrue(fired)
        self.assertEqual((self.source/'filter.so').read_bytes(), b'abc')
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_destination_parent_swap_never_writes_foreign_directory(self):
        foreign = self.root/'foreign'
        foreign.mkdir(mode=0o700)
        opened = os.open
        fired = False
        def replace_parent(path, flags, *args, **kwargs):
            nonlocal fired
            if not fired and flags & os.O_CREAT and Path(path).name == 'filter.so':
                fired = True
                self.destination.rename(self.root/'retained-context')
                self.destination.symlink_to(foreign, target_is_directory=True)
            return opened(path, flags, *args, **kwargs)
        with patch.object(os, 'open', side_effect=replace_parent):
            with self.assertRaisesRegex(ValueError, 'artifact parent'):
                stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertTrue(fired)
        self.assertEqual(list(foreign.iterdir()), [])
        self.assertTrue(self.destination.is_symlink())

    def test_changed_output_bytes_are_not_reported_authenticated(self):
        write = os.write
        fired = False
        def corrupt(fd, body):
            nonlocal fired
            if not fired:
                fired = True
                return write(fd, b'xyz')
            return write(fd, body)
        with patch.object(os, 'write', side_effect=corrupt):
            with self.assertRaisesRegex(ValueError, 'artifact output'):
                stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertTrue(fired)
        self.assertEqual((self.destination/'filter.so').read_bytes(), b'xyz')
        self.assertFalse((self.destination/'abuse').exists())

    def test_post_create_observation_failure_requires_retention(self):
        opened, observed = os.open, os.fstat
        created = None
        fired = False
        def remember_creation(path, flags, *args, **kwargs):
            nonlocal created
            fd = opened(path, flags, *args, **kwargs)
            if flags & os.O_CREAT:
                created = fd
            return fd
        def fail_created_observation(fd):
            nonlocal fired
            if fd == created and not fired:
                fired = True
                raise OSError('observation unavailable')
            return observed(fd)
        with patch.object(os, 'open', side_effect=remember_creation), patch.object(os, 'fstat', side_effect=fail_created_observation):
            with self.assertRaisesRegex(ValueError, 'artifact operation') as refused:
                stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertTrue(fired)
        self.assertTrue(refused.exception.recovery_required)
        self.assertFalse(refused.exception.cleanup_confirmed)
        self.assertEqual((self.destination/'filter.so').read_bytes(), b'abc')
        self.assertFalse((self.destination/'abuse').exists())

    def test_invalid_catalog_bound_refuses_before_opening_inputs(self):
        oversized = PairSpec(ArtifactPin(47577, TEXT_PAIR.filter.sha256), TEXT_PAIR.abuse)
        opened = os.open
        paths = []
        def record_open(path, flags, *args, **kwargs):
            paths.append(path)
            return opened(path, flags, *args, **kwargs)
        with patch.object(os, 'open', side_effect=record_open):
            with self.assertRaisesRegex(ValueError, 'artifact catalog'):
                stage_pair(self.source, self.destination, oversized, time.monotonic()+5)
        self.assertEqual(paths, [])
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_source_change_after_authentication_invalidates_pair(self):
        write = os.write
        fired = False
        def replace_source(fd, body):
            nonlocal fired
            if not fired:
                fired = True
                (self.source/'filter.so').rename(self.source/'retained-source')
                (self.source/'filter.so').write_bytes(b'abc')
                (self.source/'filter.so').chmod(0o600)
            return write(fd, body)
        with patch.object(os, 'write', side_effect=replace_source):
            with self.assertRaisesRegex(ValueError, 'artifact custody') as refused:
                stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertTrue(fired)
        self.assertTrue(refused.exception.recovery_required)
        self.assertEqual((self.source/'filter.so').read_bytes(), b'abc')

    def test_first_published_name_must_remain_bound_while_second_is_written(self):
        write = os.write
        fired = False
        def replace_published(fd, body):
            nonlocal fired
            if not fired and len(body) == 5:
                fired = True
                (self.destination/'filter.so').rename(self.destination/'retained-output')
                (self.destination/'filter.so').write_bytes(b'abc')
                (self.destination/'filter.so').chmod(0o600)
            return write(fd, body)
        with patch.object(os, 'write', side_effect=replace_published):
            with self.assertRaisesRegex(ValueError, 'artifact output') as refused:
                stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertTrue(fired)
        self.assertTrue(refused.exception.recovery_required)
        self.assertEqual((self.destination/'filter.so').read_bytes(), b'abc')
        self.assertEqual((self.destination/'retained-output').read_bytes(), b'abc')

    def test_recorded_policy_refuses_foreign_architecture_before_artifact_io(self):
        from helper_artifacts import stage_recorded_helpers
        with self.assertRaisesRegex(ValueError, 'recorded helper profile'):
            stage_recorded_helpers(self.root/'absent', self.destination, 'arm64',
                'oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e', time.monotonic()+5)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_hardlinked_source_refuses_without_publication(self):
        os.link(self.source/'filter.so', self.root/'second-link')
        with self.assertRaisesRegex(ValueError, 'artifact custody') as refused:
            stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertTrue(refused.exception.cleanup_confirmed)
        self.assertFalse(refused.exception.recovery_required)
        self.assertEqual(list(self.destination.iterdir()), [])
        self.assertEqual((self.root/'second-link').read_bytes(), b'abc')

    def test_missing_second_input_refuses_without_publication(self):
        (self.source/'abuse').unlink()
        with self.assertRaisesRegex(ValueError, 'artifact custody') as refused:
            stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertTrue(refused.exception.cleanup_confirmed)
        self.assertFalse(refused.exception.recovery_required)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_truncated_second_input_refuses_without_publication(self):
        (self.source/'abuse').write_bytes(b'hell')
        with self.assertRaisesRegex(ValueError, 'artifact digest') as refused:
            stage_pair(self.source, self.destination, TEXT_PAIR, time.monotonic()+5)
        self.assertTrue(refused.exception.cleanup_confirmed)
        self.assertFalse(refused.exception.recovery_required)
        self.assertEqual(list(self.destination.iterdir()), [])


if __name__ == '__main__':
    unittest.main()

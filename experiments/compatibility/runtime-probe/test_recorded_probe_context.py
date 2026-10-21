"""Artifact lifetime at the real OS boundary, not a native runtime fixture."""
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import run
from helper_artifacts import stage_pair
from test_helper_artifacts import TEXT_PAIR


class RecordedContext(unittest.TestCase):
    def test_cancellation_after_actual_creation_retains_uncertain_context(self):
        with tempfile.TemporaryDirectory(prefix='fleur-recorded-context-test-') as directory:
            source = Path(directory)/'input'
            source.mkdir(mode=0o700)
            for name, body in [('filter.so', b'abc'), ('abuse', b'hello')]:
                path=source/name
                path.write_bytes(body)
                path.chmod(0o600)
            actual_write=os.write
            fired=False
            def cancelled_write(fd, body):
                nonlocal fired
                count=actual_write(fd, body)
                if not fired:
                    fired=True
                    raise KeyboardInterrupt('external cancellation after creation')
                return count
            report={}
            deadline=time.monotonic()+5
            context_path=None
            try:
                with self.assertRaises(KeyboardInterrupt):
                    with run.recorded_probe_context(report, deadline) as context:
                        context_path=Path(context)
                        with patch.object(os, 'write', side_effect=cancelled_write):
                            stage_pair(source, context_path, TEXT_PAIR, deadline)
                self.assertTrue(fired)
                self.assertIsNotNone(context_path)
                self.assertTrue(context_path.exists())
                self.assertEqual((context_path/'filter.so').read_bytes(), b'abc')
                self.assertFalse(report['helper_artifact_context']['cleanup_confirmed'])
                self.assertTrue(report['helper_artifact_context']['retained'])
            finally:
                # The test owns this exact retained directory and known single file.
                if context_path is not None and context_path.exists():
                    (context_path/'filter.so').unlink()
                    context_path.rmdir()

    def test_replaced_context_is_preserved_on_normal_exit(self):
        report={}
        context_path=None
        retained=None
        try:
            with self.assertRaisesRegex(ValueError, 'recorded helper context custody'):
                with run.recorded_probe_context(report, time.monotonic()+5) as context:
                    context_path=Path(context)
                    retained=context_path.with_name(context_path.name+'-retained')
                    context_path.rename(retained)
                    context_path.mkdir(mode=0o700)
                    (context_path/'foreign').write_bytes(b'foreign')
            self.assertEqual((context_path/'foreign').read_bytes(), b'foreign')
            self.assertTrue(retained.exists())
            self.assertFalse(report['helper_artifact_context']['cleanup_confirmed'])
        finally:
            if context_path is not None and context_path.exists():
                (context_path/'foreign').unlink()
                context_path.rmdir()
            if retained is not None and retained.exists():
                retained.rmdir()

    def test_unknown_context_entry_is_retained(self):
        report={}
        context_path=None
        try:
            with self.assertRaisesRegex(ValueError, 'recorded helper context entries'):
                with run.recorded_probe_context(report, time.monotonic()+5) as context:
                    context_path=Path(context)
                    (context_path/'foreign').write_bytes(b'foreign')
            self.assertEqual((context_path/'foreign').read_bytes(), b'foreign')
            self.assertFalse(report['helper_artifact_context']['cleanup_confirmed'])
        finally:
            if context_path is not None and context_path.exists():
                (context_path/'foreign').unlink()
                context_path.rmdir()

    def test_normal_context_remains_pending_owned_vm_disposal(self):
        report={}
        context_path=None
        try:
            with run.recorded_probe_context(report, time.monotonic()+5) as context:
                context_path=Path(context)
                (context_path/'filter.so').write_bytes(b'context data')
                context.seal()
            self.assertTrue(context_path.exists())
            self.assertEqual((context_path/'filter.so').read_bytes(), b'context data')
            observation=report['helper_artifact_context']
            self.assertFalse(observation['cleanup_confirmed'])
            self.assertTrue(observation['retained'])
            self.assertEqual(observation['state'], 'retained-for-owned-guest-disposal')
            self.assertEqual(observation['disposal_scope'], 'owned-full-system-guest-filesystem')
            self.assertEqual(observation['local_disposal'], 'pending')
        finally:
            if context_path is not None and context_path.exists():
                (context_path/'filter.so').unlink()
                context_path.rmdir()

    def test_owned_materialization_under_inherited_group_write_umask_seals(self):
        for mask in (0o002, 0o077):
            report = {}
            context_path = None
            with tempfile.TemporaryDirectory(prefix='fleur-recorded-materialize-') as fixture:
                source = Path(fixture)/'inputs'
                source.mkdir(mode=0o700)
                for name, body in [('filter.so', b'abc'), ('abuse', b'hello')]:
                    (source/name).write_bytes(body)
                    (source/name).chmod(0o600)
                # Text-only lower-artifact fixtures, never compiled-policy proof.
                previous = os.umask(mask)
                try:
                    with run.recorded_probe_context(report, time.monotonic()+5) as context:
                        context_path = Path(context)
                        staged = stage_pair(source, context_path, TEXT_PAIR, time.monotonic()+5)
                        names = ('bootstrap.ts', 'heap_probe.ts', 'heap_probe.test.ts', 'application.js',
                                 'busy-application.js', 'profile.json', 'package.json', 'bun.lock', 'Dockerfile')
                        for name in names:
                            context.write_input(name, b'owned context input')
                        context.seal(staged)
                        context.revalidate()
                        self.assertEqual(set(os.listdir(context_path)), set(names)|{'filter.so', 'abuse'})
                        for name in names:
                            self.assertEqual((context_path/name).stat().st_mode & 0o777, 0o644)
                        self.assertTrue(report['helper_artifact_context']['ledger_verified'])
                finally:
                    os.umask(previous)
                    if context_path is not None:
                        for name in os.listdir(context_path):
                            (context_path/name).unlink()
                        context_path.rmdir()

    def test_owned_input_creation_preserves_an_occupied_foreign_name(self):
        report = {}
        context_path = None
        try:
            with self.assertRaises(FileExistsError):
                with run.recorded_probe_context(report, time.monotonic()+5) as context:
                    context_path = Path(context)
                    target = context_path/'application.js'
                    target.write_bytes(b'foreign bytes')
                    target.chmod(0o600)
                    identity = target.stat()
                    context.write_input('application.js', b'owned replacement refused')
            self.assertEqual(target.read_bytes(), b'foreign bytes')
            self.assertEqual(target.stat().st_ino, identity.st_ino)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertFalse(report['helper_artifact_context']['ledger_verified'])
        finally:
            if context_path is not None:
                target.unlink()
                context_path.rmdir()

    def test_created_descriptor_does_not_chmod_or_overwrite_a_replacement(self):
        report = {}
        context_path = None
        original = None
        actual_open = os.open
        fired = False
        def replaced_open(name, flags, *args, **kwargs):
            nonlocal fired, original
            fd = actual_open(name, flags, *args, **kwargs)
            if name == 'application.js' and flags & os.O_EXCL and not fired:
                fired = True
                original = context_path.with_name(context_path.name+'-original-input')
                (context_path/name).rename(original)
                (context_path/name).write_bytes(b'foreign bytes')
                (context_path/name).chmod(0o600)
            return fd
        try:
            with self.assertRaisesRegex(ValueError, 'input custody changed'):
                with run.recorded_probe_context(report, time.monotonic()+5) as context:
                    context_path = Path(context)
                    with patch.object(os, 'open', side_effect=replaced_open):
                        context.write_input('application.js', b'owned context bytes')
            self.assertTrue(fired)
            self.assertEqual((context_path/'application.js').read_bytes(), b'foreign bytes')
            self.assertEqual((context_path/'application.js').stat().st_mode & 0o777, 0o600)
            self.assertEqual(original.read_bytes(), b'owned context bytes')
            self.assertFalse(report['helper_artifact_context']['ledger_verified'])
        finally:
            if context_path is not None:
                (context_path/'application.js').unlink()
                context_path.rmdir()
            if original is not None:
                original.unlink()

    def test_sealing_cannot_adopt_replaced_staged_helper_inode(self):
        with tempfile.TemporaryDirectory(prefix='fleur-recorded-seal-test-') as fixture:
            source = Path(fixture)/'input'
            source.mkdir(mode=0o700)
            for name, body in [('filter.so', b'abc'), ('abuse', b'hello')]:
                (source/name).write_bytes(body)
                (source/name).chmod(0o600)
            report = {}
            context_path = None
            original = Path(fixture)/'original-filter'
            actual_open = os.open
            fired = False
            try:
                with self.assertRaisesRegex(ValueError, 'recorded helper context staged identity'):
                    with run.recorded_probe_context(report, time.monotonic()+5) as context:
                        context_path = Path(context)
                        staged = stage_pair(source, context_path, TEXT_PAIR, time.monotonic()+5)
                        def replaced_open(path, flags, *args, **kwargs):
                            nonlocal fired
                            if path == 'filter.so' and not fired:
                                fired = True
                                (context_path/'filter.so').rename(original)
                                (context_path/'filter.so').write_bytes(b'abc')
                                (context_path/'filter.so').chmod(0o600)
                            return actual_open(path, flags, *args, **kwargs)
                        with patch.object(os, 'open', side_effect=replaced_open):
                            context.seal(staged)
                self.assertTrue(fired)
                self.assertEqual((context_path/'filter.so').read_bytes(), b'abc')
                self.assertEqual(original.read_bytes(), b'abc')
                self.assertNotEqual((context_path/'filter.so').stat().st_ino, original.stat().st_ino)
                self.assertFalse(report['helper_artifact_context']['ledger_verified'])
                self.assertFalse(report['helper_artifact_context']['cleanup_confirmed'])
            finally:
                if context_path is not None:
                    for name in ('filter.so', 'abuse'):
                        (context_path/name).unlink(missing_ok=True)
                    context_path.rmdir()

    def test_sealed_allowed_name_replacement_invalidates_retained_context(self):
        report={}
        context_path=None
        original=None
        try:
            with self.assertRaisesRegex(ValueError, 'recorded helper context inputs'):
                with run.recorded_probe_context(report, time.monotonic()+5) as context:
                    context_path=Path(context)
                    (context_path/'filter.so').write_bytes(b'original')
                    context.seal()
                    original=context_path.with_name(context_path.name+'-original-file')
                    (context_path/'filter.so').rename(original)
                    (context_path/'filter.so').write_bytes(b'original')
            self.assertEqual((context_path/'filter.so').read_bytes(), b'original')
            self.assertEqual(original.read_bytes(), b'original')
            self.assertFalse(report['helper_artifact_context']['ledger_verified'])
            self.assertFalse(report['helper_artifact_context']['cleanup_confirmed'])
        finally:
            if context_path is not None and context_path.exists():
                (context_path/'filter.so').unlink()
                context_path.rmdir()
            if original is not None and original.exists():
                original.unlink()


if __name__ == '__main__':
    unittest.main()

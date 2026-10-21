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

"""Bounded deletion telemetry cannot change custody or deletion outcomes."""
import os
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import owned_mounts


class RemovalProgressTests(unittest.TestCase):
    def test_parser_refuses_private_text_truncation_overflow_and_wrong_attempt(self):
        row = b'1 1 1 123 0 0 0 0 0 0 0\n'
        self.assertEqual(owned_mounts.parse_removal_progress(row, 1), [[1,1,1,123,0,0,0,0,0,0,0]])
        for raw in (b'private-path\n', row[:-1], row*65, b'x'*16385,
                    row.replace(b'123', b'18446744073709551616'), row.replace(b'1 1 1', b'1 1 9')):
            with self.subTest(raw=raw[:60]), self.assertRaises(ValueError):
                owned_mounts.parse_removal_progress(raw, 1)
        with self.assertRaises(ValueError):
            owned_mounts.parse_removal_progress(row, 2)

    def test_public_projection_discards_untyped_or_private_progress(self):
        from types import SimpleNamespace
        from vfs import cleanup_diagnostics
        row = [1,1,1,123,0,0,0,0,0,0,0]
        facts = {'removal_progress': [row], 'removal_progress_invalid': False}
        observed = cleanup_diagnostics(SimpleNamespace(retirement_facts=facts))
        self.assertEqual(observed['daemon_retirement_observations']['removal_progress'], [row])
        for invalid in ('private-path', [[True]*11], [row + ['private-path']]):
            facts['removal_progress'] = invalid
            observed = cleanup_diagnostics(SimpleNamespace(retirement_facts=facts))
            self.assertNotIn('removal_progress', observed['daemon_retirement_observations'])
            self.assertNotIn('private', str(observed))

    def test_interruption_retains_successful_progress_without_completion(self):
        import subprocess
        import sys
        import time
        with tempfile.TemporaryDirectory() as directory:
            root, token, expected = self.fixture(directory)
            (root/'data'/'third').write_text('x')
            marker = root/'blocked'
            program = '''import json,os,pathlib,shutil,sys,time
from unittest.mock import patch
sys.path.insert(0,sys.argv[1]);import owned_mounts
root=pathlib.Path(sys.argv[2]);token=sys.argv[3];expected=json.loads(sys.argv[4])
original=os.unlink;calls=0
def delayed(*args,**kwargs):
 global calls
 calls+=1
 if calls==3:
  (root/'blocked').write_text('ready');time.sleep(30)
 result=original(*args,**kwargs);time.sleep(.3);return result
with patch.object(owned_mounts,'_table',return_value=''),patch.object(owned_mounts,'plan',return_value=[]),patch.object(os,'unlink',side_effect=delayed):
 owned_mounts.remove_roots(root,token,expected,attempt=1)
'''
            child = subprocess.Popen([sys.executable, '-I', '-c', program, str(Path(__file__).resolve().parent), str(root), token, json.dumps(expected)],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic()+5
                while not marker.exists() and child.poll() is None and time.monotonic()<deadline:
                    time.sleep(.01)
                ready = marker.exists()
            finally:
                if child.poll() is None: child.kill()
                _, error = child.communicate(timeout=5)
            self.assertTrue(ready, error.decode())
            rows = self.rows(root)
            progress = [row for row in rows if row[2] == 2]
            self.assertTrue(progress)
            self.assertEqual(progress[-1][5], 2)
            self.assertFalse(any(row[2] == 3 for row in rows))
            self.assertTrue((root/'data').exists())

    def fixture(self, directory):
        root = Path(directory).resolve()
        token = 'fleur-vfs-' + 'a' * 32
        (root/'owner').write_text(token)
        root.chmod(0o700)
        (root/'data').mkdir()
        (root/'exec').mkdir()
        (root/'data'/'private-name').write_text('private-content')
        (root/'data'/'nested').mkdir()
        (root/'data'/'nested'/'second').write_text('x')
        info = root.stat()
        return root, token, {'root': [info.st_dev, info.st_ino, info.st_uid], 'mounts': []}

    def remove(self, root, token, expected, attempt=1):
        with patch.object(owned_mounts, '_table', return_value=''):
            owned_mounts.remove_roots(root, token, expected, attempt=attempt)

    def rows(self, root, attempt=1):
        return [list(map(int, line.split())) for line in (root/f'removal-progress-{attempt}.facts').read_text().splitlines()]

    def test_exact_success_counts_and_no_private_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root, token, expected = self.fixture(directory)
            with patch.object(owned_mounts, 'plan', return_value=[]):
                self.remove(root, token, expected)
            self.assertFalse((root/'data').exists())
            self.assertFalse((root/'exec').exists())
            rows = self.rows(root)
            ends = {row[1]: row for row in rows if row[2] == 3}
            self.assertEqual(ends[1][5:7], [2, 2])
            self.assertEqual(ends[2][5:7], [0, 1])
            self.assertTrue(all(len(row) == 11 and row[0] == 1 for row in rows))
            self.assertNotIn('private', (root/'removal-progress-1.facts').read_text())

    def test_mount_refusal_precedes_journaling_and_tree_symlink_stays_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root, token, expected = self.fixture(directory)
            with patch.object(owned_mounts, 'plan', return_value=[{}]):
                with self.assertRaises(ValueError):
                    self.remove(root, token, expected)
            self.assertFalse((root/'removal-progress-1.facts').exists())
            outside = root/'unrelated'
            outside.mkdir()
            (outside/'keep').write_text('preserve')
            shutil.rmtree(root/'data')
            (root/'data').symlink_to(outside)
            original = shutil.os
            with patch.object(owned_mounts, 'plan', return_value=[]):
                with self.assertRaises(OSError):
                    self.remove(root, token, expected)
            self.assertIs(shutil.os, original)
            self.assertEqual((outside/'keep').read_text(), 'preserve')
            self.assertTrue((root/'data').is_symlink())
            self.assertTrue((root/'exec').exists())

    def test_unlink_failure_propagates_and_restores_shutil_module(self):
        with tempfile.TemporaryDirectory() as directory:
            root, token, expected = self.fixture(directory)
            original = shutil.os
            failure = PermissionError(13, 'private-exception')
            with patch.object(owned_mounts, 'plan', return_value=[]), patch.object(os, 'unlink', side_effect=failure):
                with self.assertRaises(PermissionError) as caught:
                    self.remove(root, token, expected)
            self.assertIs(caught.exception, failure)
            self.assertIs(shutil.os, original)
            self.assertTrue((root/'data').exists())
            self.assertEqual(self.rows(root)[-1][2], 4)
            self.assertEqual(self.rows(root)[-1][-1], 13)
            self.assertNotIn('private', (root/'removal-progress-1.facts').read_text())

    def test_symlink_or_existing_journal_is_never_overwritten_or_followed(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink), tempfile.TemporaryDirectory() as directory:
                root, token, expected = self.fixture(directory)
                outside = root/'unrelated'
                outside.write_text('preserve')
                journal = root/'removal-progress-1.facts'
                if symlink:
                    journal.symlink_to(outside)
                else:
                    journal.write_text('original')
                with patch.object(owned_mounts, 'plan', return_value=[]):
                    self.remove(root, token, expected)
                self.assertEqual(outside.read_text(), 'preserve')
                self.assertEqual(journal.read_text(), 'preserve' if symlink else 'original')
                self.assertFalse((root/'data').exists())

    def test_record_limit_and_write_failure_do_not_interrupt_deletion(self):
        for failed_write in (False, True):
            with self.subTest(failed_write=failed_write), tempfile.TemporaryDirectory() as directory:
                root, token, expected = self.fixture(directory)
                for index in range(90):
                    (root/'data'/str(index)).write_text('x')
                clock = iter(range(0, 1000_000_000_000, 600_000_000))
                with patch.object(owned_mounts, 'plan', return_value=[]), patch('owned_mounts.time.monotonic_ns', side_effect=lambda: next(clock)):
                    if failed_write:
                        with patch.object(os, 'write', side_effect=OSError(28, 'private-disk-error')):
                            self.remove(root, token, expected)
                    else:
                        self.remove(root, token, expected)
                self.assertFalse((root/'data').exists())
                self.assertFalse((root/'exec').exists())
                if not failed_write:
                    rows = self.rows(root)
                    self.assertLessEqual(len(rows), 64)
                    self.assertEqual([row[1] for row in rows if row[2] == 3], [1, 2])
                    self.assertEqual(rows[-1][5:7], [0, 1])


if __name__ == '__main__':
    unittest.main()

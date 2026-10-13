"""Requirements for post-TSYNC descriptor identity admission; no Docker claim."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from descriptor_audit import AUDIT_COMMAND, inspect_event_inventory, parse_descriptor_inventory

INVENTORY = [{'fd': 7, 'kind': 'eventfd'}, {'fd': 8, 'kind': 'eventpoll'}, {'fd': 9, 'kind': 'timerfd'}]
GOOD = '0 unadmitted\n1 unadmitted\n2 unadmitted\n7 eventfd\n8 eventpoll\n9 timerfd\n'

class DescriptorAdmission(unittest.TestCase):
    def inspect_fixture(self, output):
        # Real external CLI process at the inspector seam; this substitutes only
        # the unavailable local Docker daemon, not acceptance decisions.
        with tempfile.TemporaryDirectory(prefix='fleur-audit-cli-') as temporary:
            root = Path(temporary)
            fixture = root / 'output'
            fixture.write_text(output)
            executable = root / 'docker'
            executable.write_text('#!/bin/sh\n[ "$1" = exec ] && [ "$2" = --user ] && [ "$3" = 65534:65534 ] && [ "$4" = fleur-owned-worker ] && [ "$5" = /bin/sh ] && [ "$6" = -c ] && [ "$#" = 7 ] || exit 7\ncat "$FLEUR_AUDIT_FIXTURE"\n')
            executable.chmod(0o700)
            with patch.dict(os.environ, {'PATH': str(root) + os.pathsep + os.environ['PATH'], 'FLEUR_AUDIT_FIXTURE': str(fixture)}):
                return inspect_event_inventory('fleur-owned-worker', INVENTORY)

    def test_exact_kernel_class_inventory_passes(self):
        result = self.inspect_fixture(GOOD)
        self.assertTrue(result['passed'])
        self.assertEqual(result['category'], 'verified')
        self.assertEqual(result['descriptor_count'], 3)

    def test_replaced_extra_and_missing_descriptor_fail_at_public_seam(self):
        for output, category in ((GOOD.replace('7 eventfd', '7 unadmitted'), 'class-mismatch'),
                                 (GOOD.replace('8 eventpoll', '8 timerfd'), 'class-mismatch'),
                                 (GOOD + '10 eventfd\n', 'unexpected-fd'),
                                 (GOOD.replace('8 eventpoll\n', ''), 'missing-fd'),
                                 (GOOD.replace('8 eventpoll', '8 missing'), 'missing-fd')):
            with self.subTest(category=category):
                result = self.inspect_fixture(output)
                self.assertFalse(result['passed'])
                self.assertEqual(result['category'], category)

    def test_caller_inventory_rejects_duplicate_wrong_types_and_bounds(self):
        for inventory in (None, [], INVENTORY + INVENTORY[:1], [{'fd': True, 'kind': 'eventfd'}],
                          [{'fd': 2, 'kind': 'eventfd'}], [{'fd': 7, 'kind': 'file'}],
                          [{'fd': 7, 'kind': 'eventfd', 'target': 'secret'}],
                          [{'fd': n + 3, 'kind': 'eventfd'} for n in range(193)]):
            with self.subTest(inventory=str(inventory)[:60]):
                result = inspect_event_inventory('fleur-owned-worker', inventory)
                self.assertFalse(result['passed'])
                self.assertEqual(result['category'], 'invalid-inventory')

    def test_parser_rejects_malformed_duplicate_and_unbounded_output(self):
        for output in ('', GOOD + '7 eventfd\n', GOOD.replace('7 eventfd', '07 eventfd'),
                       GOOD + '10 /secret/path\n', GOOD.replace('7 eventfd', 'true eventfd'),
                       GOOD.replace('0 unadmitted\n', ''), 'x' * 16385, GOOD + 'overflow\n'):
            with self.subTest(output=output[:50]), self.assertRaises(ValueError):
                parse_descriptor_inventory(output)

    def test_actual_shell_classifies_symlinks_without_disclosing_targets(self):
        with tempfile.TemporaryDirectory(prefix='fleur-audit-links-') as temporary:
            root = Path(temporary)
            for fd, target in ((0, 'pipe:[secret]'), (1, '/secret/path'), (2, 'socket:[secret]'),
                               (7, 'anon_inode:[eventfd]'), (8, 'anon_inode:[eventpoll]'), (9, 'anon_inode:[timerfd]')):
                (root / str(fd)).symlink_to(target)
            command = AUDIT_COMMAND.replace('/proc/1/fd/[0-9]*', str(root / '[0-9]*'))
            result = subprocess.run(['/bin/sh', '-c', command], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(parse_descriptor_inventory(result.stdout), parse_descriptor_inventory(GOOD))
            self.assertNotIn('secret', result.stdout)
            self.assertNotIn('/secret/path', result.stdout)

    def test_failed_inspection_never_exposes_stderr_or_command_output(self):
        with tempfile.TemporaryDirectory(prefix='fleur-audit-failure-') as temporary:
            executable = Path(temporary) / 'docker'
            executable.write_text('#!/bin/sh\nprintf "private-target\\n" >&2\nexit 1\n')
            executable.chmod(0o700)
            with patch.dict(os.environ, {'PATH': temporary + os.pathsep + os.environ['PATH']}):
                result = inspect_event_inventory('fleur-owned-worker', INVENTORY)
            self.assertEqual(result, {'passed': False, 'category': 'inspection-failed'})
            self.assertNotIn('private-target', str(result))

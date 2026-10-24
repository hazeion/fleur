"""Independent file-boundary requirements; small synthetic pins are not image evidence."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('review_arch_image', Path(__file__).with_name('inspect-arch-image.py'))
image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image)


class ArchImageCustodyRequirements(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        fixture = json.loads((Path(__file__).parent.parent / 'tests/cli/fixtures/arch-qcow2-header.json').read_text())
        self.prefix = base64.b64decode(fixture['base64']) + bytes(65536 - fixture['prefixBytes'])
        self.body = self.prefix + b'independent full-byte boundary fixture'
        self.path = self.root / 'image.qcow2'
        self.path.write_bytes(self.body)
        self.path.chmod(0o600)

    def inspect_synthetic(self):
        # Trusted test-only constants exercise the full-byte reader without
        # copying a 578 MiB image. No CLI/environment override exists.
        with patch.object(image, 'PIN_BYTES', len(self.body)), patch.object(image, 'PIN_SHA256', hashlib.sha256(self.body).hexdigest()):
            return image.inspect(self.path)

    def test_source_pin_fixture_and_reader_constants_agree(self):
        pin = json.loads(Path(__file__).with_name('arch-boot-image.json').read_text())
        fixture = json.loads((Path(__file__).parent.parent / 'tests/cli/fixtures/arch-qcow2-header.json').read_text())
        self.assertEqual(pin['sha256'], image.PIN_SHA256)
        self.assertEqual(pin['bytes'], image.PIN_BYTES)
        self.assertEqual(pin['headerPrefixSha256'], image.PREFIX_SHA256)
        self.assertEqual(fixture['imageSha256'], pin['sha256'])
        self.assertEqual(fixture['prefixBytes'], 512)
        self.assertEqual(len(base64.b64decode(fixture['base64'])), 512)
        self.assertEqual(hashlib.sha256(self.prefix[:512]).hexdigest(), fixture['prefixSha256'])
        self.assertEqual(fixture['prefixSha256'], image.PREFIX_SHA256)
        result = image.validate_header(self.prefix, image.PIN_BYTES)
        self.assertEqual(result['virtualBytes'], pin['virtualBytes'])
        self.assertEqual(hashlib.sha256(self.prefix[120:504]).hexdigest(), pin['featureNameTable']['sha256'])

    def test_full_byte_reader_detects_changes_outside_the_prechecked_prefix(self):
        result = self.inspect_synthetic()
        self.assertTrue(result['imageAuthenticated'])
        self.assertFalse(result['fullStructureValidated'])
        self.assertEqual(result['bytes'], len(self.body))
        self.path.write_bytes(self.body[:-1] + b'X')
        with self.assertRaises(ValueError):
            self.inspect_synthetic()

    def test_private_parent_regular_single_link_nonwritable_file_are_mandatory(self):
        for mode in (0o755, 0o770):
            self.root.chmod(mode)
            with self.assertRaises(ValueError): self.inspect_synthetic()
            self.root.chmod(0o700)
        for mode in (0o620, 0o602):
            self.path.chmod(mode)
            with self.assertRaises(ValueError): self.inspect_synthetic()
            self.path.chmod(0o600)
        alias = self.root / 'alias'
        alias.hardlink_to(self.path)
        with self.assertRaises(ValueError): self.inspect_synthetic()
        alias.unlink()
        self.path.rename(alias)
        self.path.symlink_to(alias.name)
        with self.assertRaises(OSError): self.inspect_synthetic()

    def test_same_bytes_path_replacement_during_read_is_refused(self):
        original_read = os.read
        changed = False
        def read(fd, size):
            nonlocal changed
            data = original_read(fd, size)
            if data and not changed:
                changed = True
                replacement = self.root / 'replacement'
                replacement.write_bytes(self.body)
                replacement.chmod(0o600)
                replacement.replace(self.path)
            return data
        with patch.object(image.os, 'read', side_effect=read), self.assertRaises(ValueError):
            self.inspect_synthetic()

    def test_early_eof_and_expired_reader_deadline_refuse(self):
        original_read = os.read
        def early(fd, size): return b'' if size > 1 else original_read(fd, size)
        with patch.object(image.os, 'read', side_effect=early), self.assertRaises(ValueError): self.inspect_synthetic()
        with patch.object(image.time, 'monotonic', side_effect=[0, 31]), self.assertRaises(ValueError): self.inspect_synthetic()

    def test_held_descriptors_close_after_success_and_failure(self):
        original_open = os.open
        for failure in (False, True):
            descriptors = []
            def opened(*args, **kwargs):
                descriptor = original_open(*args, **kwargs)
                descriptors.append(descriptor)
                return descriptor
            with patch.object(image.os, 'open', side_effect=opened):
                if failure:
                    with patch.object(image.os, 'read', side_effect=OSError('controlled read error')), self.assertRaises(OSError): self.inspect_synthetic()
                else: self.inspect_synthetic()
            self.assertEqual(len(descriptors), 2)
            for descriptor in descriptors:
                with self.assertRaises(OSError): os.fstat(descriptor)

    def test_public_cli_refuses_unbound_or_wrong_sized_inputs_without_authentication_claim(self):
        for arguments in ([], ['--image', 'relative.qcow2'], ['--image', str(self.path)]):
            child = subprocess.run([sys.executable, '-I', image.__file__, *arguments], capture_output=True, text=True, timeout=5)
            self.assertEqual(child.returncode, 4)
            self.assertEqual(child.stderr, '')
            report = json.loads(child.stdout)
            self.assertFalse(report['ok'])
            self.assertFalse(report['installationVerified'])
            self.assertFalse(report['nativeQualification'])
            self.assertNotIn('imageAuthenticated', report)


if __name__ == '__main__':
    unittest.main()

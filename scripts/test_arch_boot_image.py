"""Authenticated-format requirements, without interpreting or booting an image."""
import base64
import importlib.util
import json
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location('arch_image', Path(__file__).with_name('inspect-arch-image.py'))
image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image)

class ArchImageRequirements(unittest.TestCase):
    def setUp(self):
        fixture = json.loads((Path(__file__).parent.parent / 'tests/cli/fixtures/arch-qcow2-header.json').read_text())
        self.prefix = bytearray(base64.b64decode(fixture['base64']) + bytes(65536 - fixture['prefixBytes']))

    def test_known_header_is_only_a_precheck(self):
        result = image.validate_header(bytes(self.prefix), 578080256)
        self.assertTrue(result['headerPrecheck'])
        self.assertFalse(result['fullStructureValidated'])
        self.assertFalse(result['imageAuthenticated'])
        self.assertEqual(result['virtualBytes'], 2147483648)

    def test_refuse_backing_encryption_snapshots_external_data_and_feature_flags(self):
        for offset, fmt, value in [(8,'Q',512),(16,'I',1),(32,'I',1),(60,'I',1),(64,'Q',65536),
                                   (72,'Q',1),(72,'Q',4),(80,'Q',1),(88,'Q',1)]:
            with self.subTest(offset=offset,value=value):
                changed = self.prefix.copy()
                struct.pack_into('>' + fmt, changed, offset, value)
                with self.assertRaises(ValueError):
                    image.validate_header(bytes(changed),578080256)

    def test_refuse_wrong_size_version_cluster_layout_and_padding(self):
        for offset,fmt,value in [(4,'I',2),(20,'I',17),(24,'Q',2147483649),(40,'Q',196609),
                                  (48,'Q',0),(96,'I',5),(100,'I',104),(112,'I',0x44415441),
                                  (116,'I',383),(504,'I',1),(512,'I',1),(65532,'I',1)]:
            with self.subTest(offset=offset):
                changed = self.prefix.copy()
                struct.pack_into('>' + fmt,changed,offset,value)
                with self.assertRaises(ValueError):
                    image.validate_header(bytes(changed),578080256)
        for prefix,size in [(bytes(self.prefix[:-1]),578080256),(bytes(self.prefix),578080255)]:
            with self.assertRaises(ValueError):
                image.validate_header(prefix,size)

    def test_unknown_feature_name_or_extended_header_is_refused(self):
        for offset in (104,120,503):
            changed=self.prefix.copy();changed[offset]^=1
            with self.assertRaises(ValueError):
                image.validate_header(bytes(changed),578080256)

if __name__ == '__main__':
    unittest.main()

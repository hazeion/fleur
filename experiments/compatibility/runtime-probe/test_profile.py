"""Native setup selection never treats architecture emulation as evidence."""
import unittest
from runtime_profile import select_profile, native_elf_identity

class NativeProfile(unittest.TestCase):
    def test_native_architecture_selects_its_immutable_image(self):
        architecture, amd = select_profile('amd64','Linux','x86_64')
        self.assertEqual(architecture,'amd64')
        self.assertTrue(amd['base'].endswith('c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e'))
        self.assertEqual(amd['compiler_target'],'x86_64-linux-gnu')
        self.assertEqual(amd['compiler_sha256'],'1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26')
        architecture, arm = select_profile('arm64','Linux','aarch64')
        self.assertEqual(architecture,'arm64')
        self.assertTrue(arm['base'].endswith('bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023'))
        self.assertEqual(arm['compiler_target'],'aarch64-linux-gnu')
        self.assertEqual(arm['compiler_sha256'],'a20520ee21543f243d40636a9181a142c45ecd989de31ab86b99a8ea5ada870d')

    def test_emulation_unknown_architecture_and_darwin_are_rejected(self):
        for requested, system, machine in (('amd64','Linux','aarch64'),('arm64','Linux','x86_64'),
                                           ('arm64','Darwin','arm64'),(None,'Linux','riscv64'),
                                           ('unknown','Linux','x86_64')):
            with self.subTest(requested=requested,system=system,machine=machine), self.assertRaises(ValueError):
                select_profile(requested,system,machine)

    def test_wrong_elf_class_byte_order_and_machine_cannot_be_native_evidence(self):
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        header[18:20] = (183).to_bytes(2,'little')
        self.assertEqual(native_elf_identity(header,'arm64'),{'class':64,'endianness':'little','machine':183})
        for invalid in (header[:20], b'wrong'*20, header[:4]+b'\x01'+header[5:],
                        header[:5]+b'\x02'+header[6:]):
            with self.assertRaises(ValueError):
                native_elf_identity(invalid,'arm64')
        with self.assertRaises(ValueError):
            native_elf_identity(header,'amd64')

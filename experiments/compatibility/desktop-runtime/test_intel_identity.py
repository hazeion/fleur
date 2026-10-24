import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('intel_identity_outer',Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py')
outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)
class IntelIdentity(unittest.TestCase):
    def test_native_intel_cputype_uses_the_available_mac_identity(self):
        self.assertTrue(outer.native_intel_identity('Darwin','x86_64','7\n'))
    def test_unknown_or_arm_cpu_values_refuse(self):
        for system,machine,cpu in [('Linux','x86_64','7\n'),('Darwin','arm64','7\n'),('Darwin','x86_64','12\n'),('Darwin','x86_64',''),('Darwin','x86_64','7\nextra\n')]:
            self.assertFalse(outer.native_intel_identity(system,machine,cpu))

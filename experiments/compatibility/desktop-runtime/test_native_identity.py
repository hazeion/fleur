"""Native Mac identity keyed by architecture; Apple Silicon first, Intel second, everything else refused."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('native_identity_outer',Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py')
outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)
ARM='16777228\n'
class NativeIdentity(unittest.TestCase):
    def test_native_apple_silicon_cputype_without_translation_is_arm64(self):
        self.assertEqual(outer.native_mac_identity('Darwin','arm64',ARM,'0\n'),'arm64')
        self.assertEqual(outer.native_mac_identity('Darwin','arm64',ARM,None),'arm64')
    def test_native_intel_cputype_with_the_translation_oid_absent_is_x64(self):
        self.assertEqual(outer.native_mac_identity('Darwin','x86_64','7\n',None),'x64')
    def test_translated_execution_refuses_on_both_architectures(self):
        for machine,cpu in [('arm64',ARM),('x86_64','7\n'),('x86_64',ARM)]:
            self.assertIsNone(outer.native_mac_identity('Darwin',machine,cpu,'1\n'),machine)
    def test_linux_unknown_cpu_types_and_mixed_identities_refuse(self):
        for system,machine,cpu,translated in [('Linux','aarch64',ARM,'0\n'),('Linux','x86_64','7\n',None),('Darwin','arm64','12\n','0\n'),('Darwin','arm64','7\n','0\n'),('Darwin','x86_64',ARM,None),('Darwin','x86_64','7\n','0\n'),('Darwin','arm64',ARM,'2\n'),('Darwin','arm64',ARM,'unknown\n'),('Darwin','aarch64',ARM,'0\n'),('Darwin','amd64','7\n',None)]:
            self.assertIsNone(outer.native_mac_identity(system,machine,cpu,translated),(system,machine,cpu,translated))
    def test_malformed_sysctl_output_refuses(self):
        for machine,cpu,translated in [('arm64','','0\n'),('arm64','16777228','0\n'),('arm64',ARM+'extra\n','0\n'),('arm64',' '+ARM,'0\n'),('arm64',ARM,'0'),('arm64',ARM,''),('arm64',ARM,'0\n1\n'),('x86_64','','0\n'),('x86_64','7',None),('x86_64','7\nextra\n',None),('x86_64','07\n',None)]:
            self.assertIsNone(outer.native_mac_identity('Darwin',machine,cpu,translated),(machine,cpu,translated))
class ObserverIdentityGate(unittest.TestCase):
    """Run the actual observer identity phase with host seams only; never Docker, git or the preflight."""
    def observe(self,system,machine,cpu,translated):
        calls=[]
        def bounded(args,**options):
            calls.append(args)
            if args[:2]==['/usr/sbin/sysctl','-n'] and args[2]=='hw.cputype':return SimpleNamespace(returncode=0,stdout=cpu.encode(),stderr=b'')
            if args[:2]==['/usr/sbin/sysctl','-n'] and args[2]=='sysctl.proc_translated':
                if translated is None:return SimpleNamespace(returncode=1,stdout=b'',stderr=b"sysctl: unknown oid 'sysctl.proc_translated'\n")
                return SimpleNamespace(returncode=0,stdout=translated.encode(),stderr=b'')
            raise AssertionError('identity refusal must precede '+repr(args))
        with patch.dict(outer.os.environ,{'FLEUR_DESKTOP_RUNTIME_QUALIFICATION':'yes'}),patch.object(outer.platform,'system',return_value=system),patch.object(outer.platform,'machine',return_value=machine),patch.object(outer.processes,'bounded',side_effect=bounded):
            report=outer.observe('--capabilities','/nonexistent/private/inputs')
        return report,calls
    def test_linux_refuses_as_an_identity_failure_before_any_sysctl(self):
        for machine in ('aarch64','x86_64'):
            report,calls=self.observe('Linux',machine,ARM,'0\n')
            self.assertEqual(calls,[],machine)
            self.assertEqual((report['ok'],report['error'],report['failurePhase']),(False,'EXPLICIT_NATIVE_MAC_REQUIRED','native-identity'))
            self.assertEqual((report['scope'],report['architecture'],report['runtimeAdmission'],report['nativeQualification']),('native-desktop-runtime-qualification',None,False,False))
    def test_translated_execution_refuses_before_git_the_preflight_or_docker(self):
        for machine,cpu in [('arm64',ARM),('x86_64','7\n')]:
            report,calls=self.observe('Darwin',machine,cpu,'1\n')
            self.assertEqual(report['error'],'EXPLICIT_NATIVE_MAC_REQUIRED',machine);self.assertIsNone(report['architecture'])
            self.assertTrue(calls and all(args[0]=='/usr/sbin/sysctl' for args in calls),calls)
    def test_unknown_translation_oid_output_refuses_as_identity_failure(self):
        report,calls=self.observe('Darwin','arm64',ARM,'garbage\n')
        self.assertEqual(report['error'],'EXPLICIT_NATIVE_MAC_REQUIRED');self.assertTrue(all(args[0]=='/usr/sbin/sysctl' for args in calls))
    def test_explicit_opt_in_is_required_before_any_command(self):
        with patch.dict(outer.os.environ,{'FLEUR_DESKTOP_RUNTIME_QUALIFICATION':'no'}),patch.object(outer.processes,'bounded',side_effect=AssertionError):
            report=outer.observe('--capabilities','/nonexistent/private/inputs')
        self.assertEqual(report['error'],'EXPLICIT_NATIVE_MAC_REQUIRED');self.assertIn('architecture',report)
if __name__=='__main__':unittest.main()

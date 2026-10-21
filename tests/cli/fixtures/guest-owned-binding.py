"""Guest invocation/caller protocol only; no account, Docker or Linux command runs."""
import importlib.util
from pathlib import Path
import sys
import unittest
import json
from unittest.mock import patch
sys.dont_write_bytecode=True
source=Path(sys.argv.pop(1))
spec=importlib.util.spec_from_file_location('guest',source);guest=importlib.util.module_from_spec(spec);spec.loader.exec_module(guest)
NONCE='12345678-1234-4234-8234-123456789abc'
BOOT='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
FIELDS=['--owned-guest-boot-id',BOOT,'--owned-guest-uid','1000','--owned-guest-manifest-sha256','a'*64]
class CallerBinding(unittest.TestCase):
    def test_owned_initial_and_resume_parse_the_same_original_binding(self):
        first=guest.parse_guest_invocation([NONCE,*FIELDS])
        resumed=guest.parse_guest_invocation([NONCE,'--resume','b'*64,*FIELDS])
        self.assertEqual(first[0],NONCE);self.assertIsNone(first[1])
        self.assertEqual(resumed[:2],(NONCE,'b'*64))
        self.assertIsNotNone(first[2]);self.assertEqual(first[2],resumed[2])
        self.assertEqual(first[2].nonce,NONCE);self.assertEqual(first[2].bootId,BOOT)
        self.assertEqual(first[2].uid,1000);self.assertEqual(first[2].manifestSha256,'a'*64)
    def test_partial_foreign_or_noncanonical_owned_fields_are_refused(self):
        for values in ([NONCE,*FIELDS[:-2]],[NONCE,*FIELDS,'--profile','29.9.1'],[NONCE,*FIELDS[:2],*FIELDS[:2],*FIELDS[4:]],['b'*32,*FIELDS],[NONCE,*FIELDS[:3],'0',*FIELDS[4:]],[NONCE,*FIELDS[:3],'9'*4097,*FIELDS[4:]],[NONCE,*FIELDS[:3],'true',*FIELDS[4:]]):
            with self.subTest(values=values),self.assertRaises(RuntimeError):guest.parse_guest_invocation(values)
    def test_legacy_nonce_only_callers_never_select_owned_control(self):
        legacy='12345678-1234-1234-1234-123456789abc'
        self.assertEqual(guest.parse_guest_invocation([legacy]),(legacy,None,None))
        self.assertEqual(guest.parse_guest_invocation([legacy,'--resume','b'*64]),(legacy,'b'*64,None))
    def test_parsed_original_binding_is_immutable(self):
        binding=guest.parse_guest_invocation([NONCE,*FIELDS])[2]
        with self.assertRaises(AttributeError):binding.uid=0
        self.assertEqual(binding.uid,1000)
    def test_original_binding_is_verified_by_fixed_root_nocloud_program(self):
        binding=guest.parse_guest_invocation([NONCE,*FIELDS])[2]
        calls=[]
        def query(args,timeout,allowed):
            calls.append(args)
            self.assertEqual(args[:3],['/usr/bin/python3','-I','/usr/local/lib/fleur-owned-guest.py'])
            self.assertEqual(args[3:5],['--owned-guest-nonce',NONCE])
            self.assertGreater(timeout,0);self.assertLessEqual(timeout,10);self.assertEqual(allowed,(0,4))
            return 0,json.dumps({'formatVersion':1,'scope':'owned-guest-custody-validation','ok':True,'fixtureCustodyValidated':True,**binding._asdict(),'runtimeSupport':'unverified','runtimeAdmission':False,'humanConsentProof':False,'nativeCpuPerformanceProof':False}),''
        with patch('os.getuid',return_value=1000):
            verified=guest.verify_owned_binding(binding,query=query)
        self.assertEqual(verified,binding);self.assertTrue(calls)
class OwnedCommandBudget(unittest.TestCase):
    def test_invalid_absolute_deadline_starts_no_process(self):
        for deadline in (0,100,float('nan'),float('inf'),True):
            with self.subTest(deadline=deadline),patch('time.monotonic',return_value=100),patch('subprocess.Popen',side_effect=AssertionError('invalid deadline reached Popen')):
                with self.assertRaises((ValueError,TimeoutError)):
                    guest.run(['no-command'],absolute_deadline=deadline)
unittest.main()

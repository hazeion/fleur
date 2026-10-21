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
    def test_owned_initial_main_revalidates_root_fixture_before_setup_commands(self):
        class StopAtBoundary(Exception):pass
        commands=[]
        def started(args,**kwargs):
            commands.append(args)
            self.assertEqual(args[:3],['/usr/bin/python3','-I','/usr/local/lib/fleur-owned-guest.py'])
            raise StopAtBoundary()
        def read(path,*args,**kwargs):
            if str(path)=='/etc/fleur-owned-guest':return NONCE
            if str(path)=='/proc/1/comm':return 'systemd'
            self.fail('initial owned fixture reached unvalidated file '+str(path))
        with patch.object(sys,'argv',[str(source),NONCE,*FIELDS]),patch('os.getuid',return_value=1000),patch.object(Path,'read_text',read),patch('subprocess.Popen',side_effect=started):
            with self.assertRaises(StopAtBoundary):guest.main()
        self.assertEqual(len(commands),1)

    def test_checkpoint_requires_the_same_complete_original_owned_binding(self):
        binding=guest.parse_guest_invocation([NONCE,*FIELDS])[2]
        payload={'ownedGuestBinding':binding._asdict()}
        guest.check_handoff_owned_binding(payload,binding)
        guest.check_handoff_owned_binding({},None)
        for other in ({}, {'ownedGuestBinding':None}, {'ownedGuestBinding':{**binding._asdict(),'uid':1001}}, {'ownedGuestBinding':{**binding._asdict(),'nonce':'b'*32}}, {'ownedGuestBinding':{**binding._asdict(),'profile':'29.9.1'}}):
            with self.subTest(other=other),self.assertRaises(RuntimeError):guest.check_handoff_owned_binding(other,binding)
        with self.assertRaises(RuntimeError):guest.check_handoff_owned_binding(payload,None)

    def test_expired_owned_phase_starts_no_validation_command(self):
        binding=guest.parse_guest_invocation([NONCE,*FIELDS])[2]
        with patch('os.getuid',return_value=1000),patch('time.monotonic',return_value=100.0):
            with self.assertRaises(TimeoutError):
                guest.verify_owned_binding(binding,absolute_deadline=99.0,query=lambda *a,**k:self.fail('expired phase reached command'))

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
class RestrictionCaller(unittest.TestCase):
    def test_owned_restriction_uses_original_identity_and_absolute_guest_remainder(self):
        binding=guest.parse_guest_invocation([NONCE,*FIELDS])[2]
        previous=guest.GUEST_DEADLINE
        try:
            guest.GUEST_DEADLINE=150.0
            with patch('time.monotonic',return_value=100.0):args,end=guest.restriction_invocation(binding)
            self.assertEqual(end,150.0)
            self.assertEqual(args[-10:],['--owned-guest-nonce',NONCE,'--owned-guest-boot-id',BOOT,'--owned-guest-uid','1000','--owned-guest-manifest-sha256','a'*64,'--owned-guest-deadline','150.0'])
            with patch('time.monotonic',return_value=151.0),self.assertRaises(TimeoutError):guest.restriction_invocation(binding)
            args,end=guest.restriction_invocation(None)
            self.assertIsNone(end)
            self.assertEqual(args[-3:],['amd64','--healthy-containerd-exit','--idle-runtime-stress'])
        finally:guest.GUEST_DEADLINE=previous

class OwnedCommandBudget(unittest.TestCase):
    def test_invalid_absolute_deadline_starts_no_process(self):
        for deadline in (0,100,float('nan'),float('inf'),True):
            with self.subTest(deadline=deadline),patch('time.monotonic',return_value=100),patch('subprocess.Popen',side_effect=AssertionError('invalid deadline reached Popen')):
                with self.assertRaises((ValueError,TimeoutError)):
                    guest.run(['no-command'],absolute_deadline=deadline)
unittest.main()

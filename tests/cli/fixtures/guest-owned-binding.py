"""Guest invocation/caller protocol only; no account, Docker or Linux command runs."""
import importlib.util
from pathlib import Path
import sys
import unittest
import json
import os
import tempfile
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
            return 0,json.dumps({'formatVersion':1,'scope':'owned-guest-custody-validation','ok':True,'fixtureCustodyValidated':True,**binding._asdict(),'runtimeSupport':'unverified','runtimeAdmission':False,'humanConsentProof':False,'nativeCpuPerformanceProof':False,'osRelease':{'id':'ubuntu','versionId':'24.04','sha256':'c'*64}}),''
        with patch('os.getuid',return_value=1000):
            verified=guest.verify_owned_binding(binding,query=query)
        self.assertEqual(verified,binding);self.assertTrue(calls)
    def test_full_binding_never_falls_back_when_os_observation_is_missing_or_malformed(self):
        binding=guest.parse_guest_invocation([NONCE,*FIELDS])[2]
        base={'formatVersion':1,'scope':'owned-guest-custody-validation','ok':True,'fixtureCustodyValidated':True,**binding._asdict(),'runtimeSupport':'unverified','runtimeAdmission':False,'humanConsentProof':False,'nativeCpuPerformanceProof':False}
        for observed_os in (None, {}, {'id':'debian','versionId':'26.04','sha256':'c'*64}, {'id':'ubuntu','versionId':'27.04','sha256':'c'*64}, {'id':'ubuntu','versionId':'26.04','sha256':True}, {'id':'ubuntu','versionId':'26.04','sha256':'c'*64,'profile':'caller'}):
            with self.subTest(observed_os=observed_os):
                result={**base,**({'osRelease':observed_os} if observed_os is not None else {})}
                with patch('os.getuid',return_value=1000),self.assertRaisesRegex(RuntimeError,'OS binding is incomplete'):
                    guest.verify_owned_binding(binding,query=lambda *args,**kwargs:(0,json.dumps(result),''))

class CandidateBudget(unittest.TestCase):
    def test_catalog_eof_delay_refuses_before_any_further_metadata_io(self):
        with tempfile.TemporaryDirectory(prefix='fleur-catalog-clock-') as home,patch.dict(os.environ,{'HOME':home}):
            alternate=importlib.util.module_from_spec(spec);spec.loader.exec_module(alternate)
            alternate.GUEST_DEADLINE=1000.0
            package=Path(home)/'lab/package';package.mkdir(parents=True,mode=0o700)
            raw=(source.parent/'native-candidate-ubuntu24-amd64.json').read_bytes()
            catalog=json.loads(raw)
            metadata={key:catalog[key] for key in ('formatVersion','catalogId','artifactAuthentication','installationEvidence','runtimeSupport','authentication','artifacts','limits')}
            metadata.update(internalArtifact=True,catalogSha256='540de9d76fc2aa8c260d1579a68c64ff0f1474b61cd332cfd428785432a56e58',legacyProfileAdmission={'verified':True,'meaning':'internal-catalog-admission-only'})
            (package/'internal-native-candidate.json').write_text(json.dumps(metadata))
            (package/'internal-native-candidate-catalog.json').write_bytes(raw)
            original_open=os.open;original_read=os.read;original_fstat=os.fstat
            paths={};clock=[100.0];expired=[False]
            def opened(name,*args,**kwargs):
                fd=original_open(name,*args,**kwargs);paths[fd]=str(name);return fd
            def read(fd,maximum):
                block=original_read(fd,maximum)
                if paths.get(fd)=='internal-native-candidate-catalog.json' and not block:
                    clock[0]=111.0;expired[0]=True
                return block
            def fstat(fd):
                if expired[0]:raise AssertionError('Catalog performed metadata I/O after its absolute phase end')
                return original_fstat(fd)
            with patch('time.monotonic',side_effect=lambda:clock[0]),patch.object(os,'open',side_effect=opened),patch.object(os,'read',side_effect=read),patch.object(os,'fstat',side_effect=fstat):
                with self.assertRaises(TimeoutError):alternate.checked_internal_candidate()
            self.assertTrue(expired[0])

class CandidateOSRead(unittest.TestCase):
    def test_oversized_legacy_os_snapshot_never_requests_an_unbounded_read(self):
        with tempfile.TemporaryDirectory(prefix='fleur-legacy-os-read-') as home,patch.dict(os.environ,{'HOME':home}):
            alternate=importlib.util.module_from_spec(spec);spec.loader.exec_module(alternate)
            alternate.GUEST_DEADLINE=alternate.time.monotonic()+5
            record=Path(home)/'os-release'
            record.write_text('ID=ubuntu\nVERSION_ID="24.04"\n'+'X'*17000)
            original_path_open=Path.open;original_open=os.open
            owner=self
            class Stream:
                def __init__(self,stream):self.stream=stream
                def __enter__(self):return self
                def __exit__(self,*args):return self.stream.__exit__(*args)
                def __getattr__(self,name):return getattr(self.stream,name)
                def read(self,size=-1):
                    owner.assertGreaterEqual(size,0,'OS snapshot requested an unbounded read before its size cap')
                    owner.assertLessEqual(size,16385)
                    return self.stream.read(size)
            def opened(path,*args,**kwargs):
                return Stream(original_path_open(record,*args,**kwargs)) if str(path)=='/etc/os-release' else original_path_open(path,*args,**kwargs)
            def descriptor(path,*args,**kwargs):
                return original_open(record if str(path)=='/etc/os-release' else path,*args,**kwargs)
            with patch.object(Path,'open',opened),patch.object(os,'open',side_effect=descriptor):
                with self.assertRaisesRegex(RuntimeError,'OS release'):
                    alternate.verify_guest_candidate_target(None)

    def test_standard_os_alias_retains_exact_regular_file_bytes(self):
        with tempfile.TemporaryDirectory(prefix='fleur-legacy-os-alias-') as home:
            record=Path(home)/'os-release';body=b'ID=ubuntu\nVERSION_ID="24.04"\n'
            record.write_bytes(body);record.chmod(0o444)
            alias=Path(home)/'alias';alias.symlink_to(record)
            original_open=os.open;original_stat=os.stat
            def opened(path,*args,**kwargs):return original_open(alias if str(path)=='/etc/os-release' else path,*args,**kwargs)
            def observed(path,*args,**kwargs):return original_stat(alias if str(path)=='/etc/os-release' else path,*args,**kwargs)
            with patch.object(os,'open',side_effect=opened),patch.object(os,'stat',side_effect=observed):
                self.assertEqual(guest.legacy_os_release_snapshot().encode(),body)

    def test_fifo_os_record_is_refused_without_a_blocking_read(self):
        with tempfile.TemporaryDirectory(prefix='fleur-legacy-os-fifo-') as home:
            record=Path(home)/'os-release';os.mkfifo(record,0o600)
            original_open=os.open
            def opened(path,*args,**kwargs):return original_open(record if str(path)=='/etc/os-release' else path,*args,**kwargs)
            with patch.object(os,'open',side_effect=opened),patch.object(os,'read',side_effect=AssertionError('FIFO reached a read')):
                with self.assertRaisesRegex(RuntimeError,'OS release type or size'):
                    guest.legacy_os_release_snapshot()

    def test_late_os_eof_starts_no_further_metadata_io(self):
        with tempfile.TemporaryDirectory(prefix='fleur-legacy-os-clock-') as home:
            record=Path(home)/'os-release';record.write_text('ID=ubuntu\nVERSION_ID="24.04"\n');record.chmod(0o444)
            original_open=os.open;original_read=os.read;original_fstat=os.fstat
            clock=[100.0];expired=[False]
            def opened(path,*args,**kwargs):return original_open(record if str(path)=='/etc/os-release' else path,*args,**kwargs)
            def read(fd,maximum):
                block=original_read(fd,maximum)
                if not block:clock[0]=111.0;expired[0]=True
                return block
            def observed(fd):
                if expired[0]:raise AssertionError('OS record performed metadata I/O after its original phase end')
                return original_fstat(fd)
            with patch('time.monotonic',side_effect=lambda:clock[0]),patch.object(guest,'GUEST_DEADLINE',105.0),patch.object(os,'open',side_effect=opened),patch.object(os,'read',side_effect=read),patch.object(os,'fstat',side_effect=observed):
                with self.assertRaises(TimeoutError):guest.legacy_os_release_snapshot()
            self.assertTrue(expired[0])

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

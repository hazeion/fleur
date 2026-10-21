"""Guest selector/checkpoint protocol only; no VM, account, compiler or Docker."""
import importlib.util
import os
import shutil
import tempfile
import time
from unittest.mock import patch
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode=True
source=Path(sys.argv.pop(1))
spec=importlib.util.spec_from_file_location('guest_recorded_fixture',source)
guest=importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
NONCE='12345678-1234-4234-8234-123456789abc'
BOOT='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
FIELDS=['--owned-guest-boot-id',BOOT,'--owned-guest-uid','1000','--owned-guest-manifest-sha256','a'*64]


class RecordedBinding(unittest.TestCase):
    def test_initial_and_resume_retain_the_same_explicit_selection(self):
        first=guest.parse_recorded_guest_invocation([NONCE,*FIELDS,'--recorded-helpers'])
        resumed=guest.parse_recorded_guest_invocation([NONCE,'--resume','b'*64,*FIELDS,'--recorded-helpers'])
        self.assertEqual(first[2],resumed[2])
        self.assertTrue(first[3]);self.assertTrue(resumed[3])
        self.assertEqual(first[:2],(NONCE,None))
        self.assertEqual(resumed[:2],(NONCE,'b'*64))

    def test_recorded_selection_cannot_upgrade_a_legacy_nonce(self):
        with self.assertRaisesRegex(RuntimeError,'original owned'):
            guest.parse_recorded_guest_invocation([NONCE,'--recorded-helpers'])

    def test_matching_handoff_mode_is_accepted_as_protocol_data(self):
        guest.check_handoff_recorded_mode({'helperMode':'recorded-prebuilt','report':{'helperMode':'recorded-prebuilt'}},True)

    def test_legacy_resume_cannot_acquire_recorded_mode(self):
        with self.assertRaisesRegex(RuntimeError,'recorded helper mode'):
            guest.check_handoff_recorded_mode({'helperMode':'recorded-prebuilt','report':{'helperMode':'recorded-prebuilt'}},False)

    def test_handoff_refuses_wrong_compiled_pair_before_snapshot_acceptance(self):
        with tempfile.TemporaryDirectory(prefix='fleur-recorded-handoff-') as home, patch.dict(os.environ, {'HOME':home}):
            alternate=importlib.util.module_from_spec(spec)
            spec.loader.exec_module(alternate)
            alternate.GUEST_DEADLINE=time.monotonic()+5
            alternate.RECORDED_HELPERS=alternate.parse_recorded_guest_invocation([NONCE,*FIELDS,'--recorded-helpers'])[3]
            lab=Path(home)/'lab';lab.mkdir(mode=0o700)
            package=lab/'package';package.mkdir(mode=0o700)
            (package/'package.json').write_text('{}')
            for name in ('fleur-internal-native-candidate.tgz','bun.zip','runtime-probe.tar','bun'):
                (lab/name).write_bytes(b'owned artifact data')
            probe=lab/'experiments/compatibility/runtime-probe';probe.mkdir(parents=True)
            original=source.parent.parent/'experiments/compatibility/runtime-probe'
            for name in ('helper_artifacts.py','runtime_profile.py','recorded-helper-origin.json','filter.c','abuse.c'):
                shutil.copyfile(original/name,probe/name)
            inputs=lab/'recorded-helpers';inputs.mkdir(mode=0o700)
            for name in ('filter.so','abuse'):
                path=inputs/name;path.write_bytes(b'not a compiled helper');path.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError,'Recorded helper handoff bytes differ'):
                alternate.handoff_artifacts()

    def test_recorded_restriction_invocation_cannot_fall_back_to_legacy(self):
        previous=guest.RECORDED_HELPERS
        guest.RECORDED_HELPERS=True
        try:
            with self.assertRaisesRegex(RuntimeError,'original owned'):
                guest.restriction_invocation(None)
        finally:
            guest.RECORDED_HELPERS=previous


if __name__=='__main__':unittest.main()

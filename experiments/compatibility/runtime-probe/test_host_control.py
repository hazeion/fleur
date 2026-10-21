"""Mode selection is a host protocol, not a native runtime success fixture."""
import os
import unittest
from unittest.mock import patch
from owned_guest import HOSTED, OwnedGuestContext
from host_control import select_owned_context


class ExplicitHostMode(unittest.TestCase):
    def test_absent_owned_binding_preserves_legacy_selection_without_owned_file_access(self):
        with patch('os.open',side_effect=AssertionError('default mode must not inspect owned files')):
            self.assertIsNone(select_owned_context(remaining=1))

    def test_observation_json_or_plain_custody_object_never_grants_control(self):
        from host_control import authorize_host_control
        observation=OwnedGuestContext('12345678-1234-4234-8234-123456789abc','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',1000,'a'*64,())
        for value in ({'fixtureCustodyValidated':True}, observation, True):
            with self.subTest(value=value),patch('os.open',side_effect=AssertionError('untyped authority must refuse before file access')):
                with self.assertRaises(ValueError):authorize_host_control(value,remaining=1)

    def test_default_mode_keeps_exact_github_predicate_and_ignores_owned_env_flags(self):
        from host_control import authorize_host_control
        with patch('platform.system',return_value='Linux'),patch.dict(os.environ,HOSTED,clear=True):
            self.assertEqual(authorize_host_control(None,remaining=1),'github-hosted')
        with patch('platform.system',return_value='Linux'),patch.dict(os.environ,{'FLEUR_OWNED_DISPOSABLE_HOST':'yes'},clear=True):
            with self.assertRaises(RuntimeError):authorize_host_control(None,remaining=1)

    def test_runtime_context_requires_explicit_remaining_budget_before_file_access(self):
        from host_control import HostControlContext, authorize_host_control
        custody=OwnedGuestContext('12345678-1234-4234-8234-123456789abc','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',1000,'a'*64,())
        context=HostControlContext(custody,(custody.nonce,custody.boot_id,custody.uid,custody.manifest_sha256))
        with patch('platform.system',return_value='Linux'),patch('platform.machine',return_value='x86_64'),patch('os.getuid',return_value=1000),patch('os.open',side_effect=AssertionError('missing budget reached filesystem')):
            with self.assertRaisesRegex(ValueError,'remaining budget'):
                authorize_host_control(context,remaining=None)

    def test_root_payload_is_opaque_original_identity_data_with_absolute_deadline(self):
        import json
        from host_control import HostControlContext
        custody=OwnedGuestContext('12345678-1234-4234-8234-123456789abc','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',1000,'a'*64,())
        context=HostControlContext(custody,(custody.nonce,custody.boot_id,custody.uid,custody.manifest_sha256),123.0)
        value=json.loads(context.root_payload())
        self.assertEqual(set(value),{'formatVersion','nonce','bootId','uid','manifestSha256','custodySha256','deadlineMonotonic'})
        self.assertEqual((value['nonce'],value['bootId'],value['uid'],value['manifestSha256']),context.original)
        self.assertEqual(value['formatVersion'],1);self.assertEqual(value['deadlineMonotonic'],123.0)
        self.assertRegex(value['custodySha256'],r'^[a-f0-9]{64}$')
        value['uid']=0
        self.assertEqual(json.loads(context.root_payload())['uid'],1000)

    def test_explicit_control_requires_original_nonexpanded_absolute_deadline_before_io(self):
        valid={'nonce':'12345678-1234-4234-8234-123456789abc','boot_id':'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','uid':1000,'manifest_sha256':'a'*64}
        for deadline in (None,100,102,float('nan'),float('inf')):
            with self.subTest(deadline=deadline),patch('time.monotonic',return_value=100),patch('os.open',side_effect=AssertionError('invalid absolute deadline reached files')):
                with self.assertRaisesRegex(ValueError,'original.*deadline'):select_owned_context(**valid,remaining=1,deadline=deadline)

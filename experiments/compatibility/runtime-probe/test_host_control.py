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

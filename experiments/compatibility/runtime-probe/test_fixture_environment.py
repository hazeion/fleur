"""Runner metadata must not leak into synthetic owned-guest fixtures."""
import os
import unittest
from unittest.mock import patch
import owned_guest
import test_owned_guest as custody_fixtures


class FixtureEnvironmentIsolation(unittest.TestCase):
    def test_owned_fixture_and_explicit_hosted_refusals_are_independent_of_runner(self):
        cases = ('test_explicit_cli_validates_root_manifest_bound_to_real_fixture_bytes',
                 'test_hosted_and_owned_selection_cannot_be_combined',
                 'test_partial_hosted_metadata_also_refuses_explicit_owned_selection')
        with patch.dict(os.environ, owned_guest.HOSTED):
            result = unittest.TestResult()
            unittest.TestSuite(custody_fixtures.OwnedGuestCustody(name) for name in cases).run(result)
            self.assertTrue(result.wasSuccessful(), result.failures + result.errors)
            self.assertEqual(os.environ['GITHUB_ACTIONS'], 'true')

    def test_shared_privileged_fixture_is_independent_of_runner_and_restores_environment(self):
        with patch.dict(os.environ, owned_guest.HOSTED):
            report = custody_fixtures.OwnedGuestCustody().with_context(lambda fixture: None)
            self.assertTrue(report['ok'])
            self.assertEqual(os.environ['GITHUB_ACTIONS'], 'true')

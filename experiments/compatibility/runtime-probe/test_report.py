"""Public probe report acceptance, independent of native filter implementation."""
import unittest
from report import accept


class ReportAcceptance(unittest.TestCase):
    def test_unrestricted_fixture_cannot_pass(self):
        self.assertFalse(accept({'install': 0, 'html': '<p>restricted render</p>',
                                 'main': [0] * 10, 'thread': 0}))

    def test_only_complete_negative_and_render_evidence_passes(self):
        complete = {'install': 0, 'html': '<p>restricted render</p>',
                    'main': [-1] * 24, 'thread': -1, 'application_open': True, 'cleanup_complete': True, 'descriptors_closed': True, 'broker_reply': 'registered:Squat', 'cgroups': {'cpu':'100000 100000','memory':'536870912','pids':'64'}}
        self.assertTrue(accept(complete))
        for field in complete:
            missing = dict(complete)
            del missing[field]
            self.assertFalse(accept(missing))
        for result in (1, 42, -1):
            self.assertFalse(accept(dict(complete, install=result)))

    def test_cleanup_and_malformed_reports_cannot_pass(self):
        complete = {'install': 0, 'html': '<p>restricted render</p>',
                    'main': [-1] * 24, 'thread': -1, 'application_open': True,
                    'cleanup_complete': True, 'descriptors_closed': True, 'broker_reply': 'registered:Squat', 'cgroups': {'cpu':'100000 100000','memory':'536870912','pids':'64'}}
        for invalid in (dict(complete, cleanup_complete=False),
                        dict(complete, install=False), dict(complete, install=0.0),
                        dict(complete, main=[-1.0] * 10),
                        dict(complete, thread=-1.0),
                        dict(complete, application_open=1),
                        dict(complete, cleanup_complete=1), None, [], 0):
            with self.subTest(report=invalid):
                self.assertFalse(accept(invalid))


if __name__ == '__main__':
    unittest.main()

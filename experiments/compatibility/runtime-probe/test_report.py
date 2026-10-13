"""Public probe report acceptance, independent of native filter implementation."""
import unittest
from report import accept


class ReportAcceptance(unittest.TestCase):
    def test_unrestricted_fixture_cannot_pass(self):
        self.assertFalse(accept({'install': 0, 'html': '<p>restricted render</p>',
                                 'main': [0] * 10, 'thread': 0}))

    def test_only_complete_negative_and_render_evidence_passes(self):
        complete = {'install': 0, 'html': '<p>restricted render</p>',
                    'main': [-1] * 10, 'thread': -1, 'application_open': True}
        self.assertTrue(accept(complete))
        for field in complete:
            missing = dict(complete)
            del missing[field]
            self.assertFalse(accept(missing))
        for result in (1, 42, -1):
            self.assertFalse(accept(dict(complete, install=result)))


if __name__ == '__main__':
    unittest.main()

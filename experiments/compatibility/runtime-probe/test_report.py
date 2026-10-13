"""Public probe report acceptance, independent of native filter implementation."""
import unittest
from report import accept, CONTROLS

THREADS = [{'pid':1,'no_new_privs':1,'seccomp':2,'seccomp_filters':1},
           {'pid':7,'no_new_privs':1,'seccomp':2,'seccomp_filters':1}]


class ReportAcceptance(unittest.TestCase):
    def test_unrestricted_fixture_cannot_pass(self):
        self.assertFalse(accept({'host_threads':THREADS, 'architecture':'amd64', 'negative_controls':CONTROLS['amd64'], 'event_probe':0,'event_negatives':[-1]*12,'install': 0, 'html': '<p>restricted render</p>',
                                 'main': [0] * 10, 'thread': 0}))

    def test_only_complete_negative_and_render_evidence_passes(self):
        complete = {'host_threads':THREADS, 'architecture':'amd64', 'negative_controls':CONTROLS['amd64'], 'event_probe':0,'event_negatives':[-1]*12,'install': 0, 'html': '<p>restricted render</p>',
                    'main': [-1] * 24, 'thread': -1, 'application_open': True, 'cleanup_complete': True, 'descriptors_closed': True, 'broker_reply': 'registered:Squat', 'cgroups': {'cpu':'100000 100000','memory':'536870912','pids':'64'}}
        self.assertTrue(accept(complete))
        for field in complete:
            missing = dict(complete)
            del missing[field]
            self.assertFalse(accept(missing))
        for result in (1, 42, -1):
            self.assertFalse(accept(dict(complete, install=result)))

    def test_cleanup_and_malformed_reports_cannot_pass(self):
        complete = {'host_threads':THREADS, 'architecture':'amd64', 'negative_controls':CONTROLS['amd64'], 'event_probe':0,'event_negatives':[-1]*12,'install': 0, 'html': '<p>restricted render</p>',
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

class ArchitectureEvidence(unittest.TestCase):
    def test_claimed_arm64_controls_cannot_reuse_amd64_x32_label(self):
        complete = {'event_probe':0,'event_negatives':[-1]*12,'install':0,'html':'<p>restricted render</p>','main':[-1]*24,
                    'thread':-1,'application_open':True,'cleanup_complete':True,
                    'descriptors_closed':True,'broker_reply':'registered:Squat',
                    'cgroups':{'cpu':'100000 100000','memory':'536870912','pids':'64'},
                    'architecture':'arm64','negative_controls':['x32_openat']*24}
        self.assertFalse(accept(complete))

    def test_native_evidence_requires_matching_requested_architecture(self):
        complete = {'event_probe':0,'event_negatives':[-1]*12,'install':0,'html':'<p>restricted render</p>','main':[-1]*24,
                    'thread':-1,'application_open':True,'cleanup_complete':True,
                    'descriptors_closed':True,'broker_reply':'registered:Squat',
                    'cgroups':{'cpu':'100000 100000','memory':'536870912','pids':'64'},
                    'host_threads':THREADS, 'architecture':'arm64','negative_controls':CONTROLS['arm64']}
        self.assertTrue(accept(complete,'arm64'))
        self.assertFalse(accept(complete,'amd64'))
        for architecture in (None,[],{},True,'riscv64'):
            self.assertFalse(accept(dict(complete,architecture=architecture)))
        self.assertFalse(accept(dict(complete,negative_controls=CONTROLS['amd64'])))

    def test_one_thread_without_native_filter_prevents_all_thread_claim(self):
        complete = {'event_probe':0,'event_negatives':[-1]*12,'install':0,'html':'<p>restricted render</p>','main':[-1]*24,
                    'thread':-1,'application_open':True,'cleanup_complete':True,
                    'descriptors_closed':True,'broker_reply':'registered:Squat',
                    'cgroups':{'cpu':'100000 100000','memory':'536870912','pids':'64'},
                    'architecture':'amd64','negative_controls':CONTROLS['amd64'],
                    'host_threads':[{'pid':1,'no_new_privs':1,'seccomp':2,'seccomp_filters':1},
                                    {'pid':7,'no_new_privs':1,'seccomp':0,'seccomp_filters':0}]}
        self.assertFalse(accept(complete))

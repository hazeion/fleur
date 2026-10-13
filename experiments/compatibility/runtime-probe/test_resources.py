import unittest
from resources import accept_resources

class ResourceEvidence(unittest.TestCase):
    def test_limits_require_actual_throttling_oom_and_pid_refusal(self):
        complete = {'cpu':{'throttled_periods':1,'throttled_usec':1},
                    'memory':{'exit':137,'oom_killed':True},
                    'pids':{'errno':11,'current':64,'max':64,'limit_events':1}}
        self.assertTrue(accept_resources(complete))
        for section, field, invalid in (('cpu','throttled_usec',0), ('cpu','throttled_periods',False),
                                        ('memory','oom_killed',False),('memory','exit',1),
                                        ('pids','errno',1),('pids','current',63),('pids','limit_events',0)):
            changed = {key:dict(value) for key,value in complete.items()}
            changed[section][field] = invalid
            self.assertFalse(accept_resources(changed))

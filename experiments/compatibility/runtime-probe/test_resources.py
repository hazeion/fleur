import unittest
from resources import accept_resources

class ResourceEvidence(unittest.TestCase):
    def test_limits_require_actual_throttling_oom_and_pid_refusal(self):
        complete = {'cpu':{'throttled_periods':1,'throttled_usec':1},
                    'memory':{'container_exit':0,'docker_oom_killed':False,
                              'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                              'memory_max':536870912,'swap_max':0},
                    'pids':{'errno':11,'current':64,'max':64,'limit_events':1}}
        self.assertTrue(accept_resources(complete))
        for section, field, invalid in (('cpu','throttled_usec',0), ('cpu','throttled_periods',False),
                                        ('memory','oom_kill_delta',0),('memory','child_signal',0),
                                        ('pids','errno',1),('pids','current',63),('pids','limit_events',0)):
            changed = {key:dict(value) for key,value in complete.items()}
            changed[section][field] = invalid
            self.assertFalse(accept_resources(changed))

    def test_kernel_oom_cause_requires_child_signal_and_actual_limit(self):
        complete = {'cpu':{'throttled_periods':20,'throttled_usec':1987459},
                    'memory':{'container_exit':0,'docker_oom_killed':False,
                              'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                              'memory_max':536870912,'swap_max':0},
                    'pids':{'errno':11,'current':64,'max':64,'limit_events':1}}
        self.assertTrue(accept_resources(complete))
        for field, value in (('container_exit',137),('child_signal',0),('oom_events_delta',0),
                             ('oom_kill_delta',0),('memory_max',1073741824),('swap_max',536870912)):
            invalid = {key:dict(value) for key,value in complete.items()}
            invalid['memory'][field] = value
            self.assertFalse(accept_resources(invalid))

    def test_ambiguous_137_never_establishes_oom_causality(self):
        for docker_flag in (False, True):
            ambiguous = {'cpu':{'throttled_periods':20,'throttled_usec':1987459},
                         'memory':{'exit':137,'oom_killed':docker_flag},
                         'pids':{'errno':11,'current':64,'max':64,'limit_events':1}}
            self.assertFalse(accept_resources(ambiguous))

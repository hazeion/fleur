import unittest
from native import attach_host_threads


class ThreadEvidenceTests(unittest.TestCase):
    def test_worker_cannot_replace_the_hosts_actual_observation(self):
        with self.assertRaisesRegex(RuntimeError, 'Worker cannot supply'):
            attach_host_threads({'host_threads': ['forged']}, ['host-observed'])

    def test_missing_host_measurement_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'did not complete'):
            attach_host_threads({'kind': 'runtime-evidence'}, None)

    def test_driver_attaches_only_the_separately_collected_host_measurement(self):
        worker = {'kind': 'runtime-evidence'}
        observed = [{'pid': 1, 'no_new_privs': 1, 'seccomp': 2, 'seccomp_filters': 1}]
        result = attach_host_threads(worker, observed)
        self.assertEqual(result['host_threads'], observed)
        self.assertNotIn('host_threads', worker)


if __name__ == '__main__':
    unittest.main()

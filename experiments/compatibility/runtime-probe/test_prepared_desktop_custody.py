"""Independent prepared-image authority requirements; no native execution."""
import json
import unittest
import run
import test_driver


class PreparedDesktopCustody(unittest.TestCase):
    monitor = json.dumps({'child_signal': 9, 'oom_events_delta': 1,
        'oom_kill_delta': 1, 'memory_max': 536870912, 'swap_max': 0})

    def template(self):
        fixture = test_driver.DriverEvidence()
        code, proof = fixture.execute(self.monitor, container_exit=0, idle_runtime_stress=True)
        self.assertEqual(code, 0)
        return proof

    def image(self, proof, **changes):
        values = dict(image_id=proof['image_id'], architecture=proof['architecture'],
            base_image=proof['base_image'], helper_sha256=proof['helper_sha256'],
            abuse_sha256=proof['abuse_sha256'], sources=tuple(sorted(proof['source_sha256'].items())))
        values.update(changes)
        return run.PreparedRuntimeImage(**values)

    def callbacks(self):
        return dict(owner_registration=lambda *args: None,
            deadline_factory=lambda *args: None, owned_cleanup=lambda *args: 'removed')

    def test_each_missing_or_noncallable_custody_boundary_refuses_before_workers(self):
        proof = self.template()
        for name in self.callbacks():
            for bad in ('omitted', None, False, object()):
                with self.subTest(boundary=name, value=type(bad).__name__):
                    callbacks = self.callbacks()
                    if bad == 'omitted':
                        callbacks.pop(name)
                    else:
                        callbacks[name] = bad
                    fixture = test_driver.DriverEvidence()
                    code, observed = fixture.execute(self.monitor, container_exit=0,
                        idle_runtime_stress=True, prepared_image=self.image(proof), **callbacks)
                    self.assertEqual(code, 1)
                    self.assertIs(observed['bounded_probe_passed'], False)
                    self.assertNotIn('evidence', observed)
                    self.assertNotIn('trusted_cgroup_abuse', observed)
                    self.assertEqual(fixture.last_lifecycle_calls, [])
                    self.assertEqual(fixture.last_build_requests, [])

    def test_valid_explicit_boundaries_preserve_all_original_mocked_oracles(self):
        proof = self.template()
        fixture = test_driver.DriverEvidence()
        code, observed = fixture.execute(self.monitor, container_exit=0,
            idle_runtime_stress=True, prepared_image=self.image(proof), **self.callbacks())
        self.assertEqual(code, 0)
        self.assertIs(observed['bounded_probe_passed'], True)
        self.assertIs(observed['cleanup_complete'], True)
        self.assertEqual(len(fixture.last_lifecycle_calls), 2)
        self.assertEqual(fixture.last_build_requests, [])

    def test_valid_boundaries_do_not_mask_native_helper_or_source_drift(self):
        proof = self.template()
        for changes in ({'helper_sha256': 'd' * 64}, {'abuse_sha256': 'd' * 64},
                {'sources': tuple((name, 'd' * 64) for name in proof['source_sha256'])}):
            with self.subTest(changes=changes):
                fixture = test_driver.DriverEvidence()
                code, observed = fixture.execute(self.monitor, container_exit=0,
                    prepared_image=self.image(proof, **changes), **self.callbacks())
                self.assertEqual(code, 1)
                self.assertEqual(observed['failure'], 'prepared image differs from native compiler/helper/source evidence')
                self.assertNotIn('evidence', observed)
                self.assertEqual(fixture.last_build_requests, [])


if __name__ == '__main__':
    unittest.main()

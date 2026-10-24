"""Internal Desktop preparation never substitutes for native runtime oracles."""
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import run
import test_driver

class DesktopSeams(unittest.TestCase):
    def test_owner_registration_must_retire_before_any_worker_starts(self):
        facts=[]
        def registered(tag,image):
            self.assertRegex(tag,r'^fleur-runtime-probe-[0-9]+$')
            self.assertRegex(image,r'^sha256:[a-f0-9]{64}$')
            facts.append((tag,image))
            raise RuntimeError('external owner acknowledgment refused')
        fixture=test_driver.DriverEvidence()
        monitor=json.dumps({'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,'memory_max':536870912,'swap_max':0})
        code,report=fixture.execute(monitor,container_exit=0,owner_registration=registered)
        self.assertEqual(code,1);self.assertFalse(report['bounded_probe_passed'])
        self.assertEqual(len(facts),1)
        self.assertNotIn('evidence',report);self.assertNotIn('trusted_cgroup_abuse',report)
        self.assertTrue(report['cleanup_complete'])
    def test_preparation_export_is_not_runtime_qualification(self):
        exports=[]
        def export(image,report):
            exports.append(image)
            self.assertTrue(report['compiler_pin_verified'])
            raise RuntimeError('preparation-only exported')
        fixture=test_driver.DriverEvidence()
        code,report=fixture.execute('{}',prepared_image_export=export)
        self.assertEqual(code,1);self.assertEqual(exports,['sha256:'+'a'*64])
        self.assertFalse(report['bounded_probe_passed']);self.assertNotIn('evidence',report)
    def test_guardian_deadline_factory_is_used_for_both_original_lanes(self):
        factory=object();fixture=test_driver.DriverEvidence()
        monitor=json.dumps({'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,'memory_max':536870912,'swap_max':0})
        code,report=fixture.execute(monitor,container_exit=0,idle_runtime_stress=True,deadline_factory=factory)
        self.assertEqual(code,0);self.assertTrue(report['bounded_probe_passed'])
        self.assertEqual(len(fixture.last_lifecycle_calls),2)
        self.assertTrue(all(call.kwargs['deadline_factory'] is factory for call in fixture.last_lifecycle_calls))

if __name__=='__main__':unittest.main()

class PreparedImageTests(unittest.TestCase):
    monitor=json.dumps({'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,'memory_max':536870912,'swap_max':0})
    def template(self):
        fixture=test_driver.DriverEvidence();code,report=fixture.execute(self.monitor,container_exit=0,idle_runtime_stress=True)
        self.assertEqual(code,0)
        return report
    def prepared(self, report, **changes):
        values=dict(image_id=report['image_id'],architecture=report['architecture'],base_image=report['base_image'],helper_sha256=report['helper_sha256'],abuse_sha256=report['abuse_sha256'],sources=tuple(sorted(report['source_sha256'].items())))
        values.update(changes);return run.PreparedRuntimeImage(**values)
    def test_exact_prepared_image_uses_all_original_runtime_oracles_without_build(self):
        report=self.template();fixture=test_driver.DriverEvidence()
        code,observed=fixture.execute(self.monitor,container_exit=0,idle_runtime_stress=True,prepared_image=self.prepared(report),owner_registration=lambda *args:None,deadline_factory=lambda *args:None,owned_cleanup=lambda *args:"removed")
        self.assertEqual(code,0);self.assertTrue(observed['bounded_probe_passed'])
        self.assertTrue(observed['compiler_pin_verified']);self.assertEqual(fixture.last_build_requests,[])
        self.assertTrue(observed['prepared_runtime_image']['source_verified'])
    def test_helper_source_architecture_or_image_drift_cannot_start_workers(self):
        report=self.template()
        for change in ({'helper_sha256':'d'*64},{'abuse_sha256':'d'*64},{'architecture':'arm64'},{'image_id':'mutable-tag'},{'sources':tuple()},{'sources':tuple((name,'d'*64) for name in report['source_sha256'])}):
            fixture=test_driver.DriverEvidence();code,observed=fixture.execute(self.monitor,container_exit=0,prepared_image=self.prepared(report,**change),owner_registration=lambda *args:None,deadline_factory=lambda *args:None,owned_cleanup=lambda *args:"removed")
            self.assertEqual(code,1);self.assertFalse(observed['bounded_probe_passed'])
            self.assertEqual(fixture.last_build_requests,[]);self.assertNotIn('evidence',observed)
    def test_prepared_image_is_not_a_mapping_or_a_cli_bypass(self):
        fixture=test_driver.DriverEvidence();code,observed=fixture.execute(self.monitor,container_exit=0,prepared_image={'image_id':'sha256:'+'a'*64})
        self.assertEqual(code,1);self.assertFalse(observed['bounded_probe_passed']);self.assertEqual(fixture.last_build_requests,[])

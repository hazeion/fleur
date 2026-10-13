"""Replay subprocess evidence through the real report-producing driver."""
import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import run
from report import CONTROLS
from runtime_profile import PROFILES

class DriverEvidence(unittest.TestCase):
    def execute(self, memory_output, container_exit=137, docker_oom_killed=False, host_machine="x86_64", compiled_machine=None, compiler_target=None, compiler_sha=None):
        architecture = "arm64" if host_machine == "aarch64" else "amd64"
        cpu = {"throttled_periods":20,"throttled_usec":1987459}
        pids = {"errno":11,"current":64,"max":64,"limit_events":1}
        native = {"architecture":architecture,"negative_controls":CONTROLS[architecture],"install":0,"main":[-1]*24,"thread":-1,"html":"<p>restricted render</p>",
                  "application_open":True,"descriptors_closed":True,"broker_reply":"registered:Squat",
                  "cgroups":{"cpu":"100000 100000","memory":"536870912","pids":"64"}}
        def command(args, **kwargs):
            if '-dumpfullversion' in args: return '13.3.0'
            if '-dumpmachine' in args: return compiler_target or PROFILES[architecture]['compiler_target']
            if '--version' in args: return 'GCC 13.3.0'
            if '-o' in args:
                header = bytearray(64)
                header[:6] = b'\x7fELF\x02\x01'
                machine = compiled_machine if compiled_machine is not None else 183 if architecture == 'arm64' else 62
                header[18:20] = machine.to_bytes(2,'little')
                Path(args[-1]).write_bytes(header)
                return ''
            if args[:2] == ['docker','image']:
                return architecture if args[-1] == '{{.Architecture}}' else 'sha256:fixture'
            if args[:2] == ['docker','inspect']: return json.dumps({'OOMKilled':docker_oom_killed})
            return '{}'
        def subprocess_run(args, **kwargs):
            if args[:2] == ['docker','run']:
                mode = args[-1]
                output = json.dumps(cpu if mode == 'cpu' else pids) if mode != 'memory' else memory_output
                return SimpleNamespace(returncode=container_exit if mode == 'memory' else 0,
                                       stdout=output,stderr='')
            return SimpleNamespace(returncode=0,stdout='',stderr='')
        captured = io.StringIO()
        run.REPORT = {'scope':'fixture','v1_gate_passed':False,'expected_gcc':'13.3.0',
                      'expected_gcc_binary_sha256':PROFILES['amd64']['compiler_sha256']}
        with patch.object(run.platform,'system',return_value='Linux'), \
             patch.object(run.platform,'machine',return_value=host_machine), \
             patch.object(run.shutil,'which',return_value=__file__), \
             patch.object(run.hashlib,'sha256',return_value=SimpleNamespace(hexdigest=lambda:compiler_sha or PROFILES['amd64']['compiler_sha256'])), \
             patch.object(Path,'read_text',return_value='Linux'), \
             patch.object(run,'command',side_effect=command), \
             patch.object(run,'run_container',return_value=json.dumps(native)), \
             patch.object(run.subprocess,'run',side_effect=subprocess_run), \
             contextlib.redirect_stdout(captured):
            code = run.main()
        return code, json.loads(captured.getvalue())

    def test_native_monitor_cannot_overwrite_measured_process_status(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0,
                   'container_exit':0,'docker_oom_killed':True}
        code, report = self.execute(json.dumps(monitor))
        self.assertEqual(code,1)
        self.assertFalse(report['bounded_probe_passed'])

    def test_each_driver_owned_field_is_rejected_in_monitor_payload(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0}
        for field, value in (('container_exit',0),('docker_oom_killed',True)):
            with self.subTest(field=field):
                code, report = self.execute(json.dumps(dict(monitor, **{field:value})))
                self.assertEqual(code,1)
                self.assertFalse(report['bounded_probe_passed'])
                self.assertEqual(report['trusted_cgroup_abuse']['memory']['container_exit'],137)
                self.assertIs(report['trusted_cgroup_abuse']['memory']['docker_oom_killed'],False)

    def test_valid_monitor_only_passes_with_actual_successful_parent_exit(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0}
        for exit_code in (0,137):
            code, report = self.execute(json.dumps(monitor),container_exit=exit_code)
            self.assertEqual(code,0 if exit_code == 0 else 1)
            self.assertEqual(report['bounded_probe_passed'],exit_code == 0)

    def test_malformed_nonobject_and_oversized_monitor_output_is_reported_failure(self):
        for payload in ('[1,2,3]', 'null', 'true', 'broken', '{"padding":"' + 'x'*4096 + '"}'):
            with self.subTest(payload=payload[:40]):
                code, report = self.execute(payload,container_exit=0)
                self.assertEqual(code,1)
                self.assertFalse(report['bounded_probe_passed'])
                self.assertTrue(report['cleanup_complete'])
                self.assertIn('evidence',report)

    def test_native_arm64_uses_its_image_and_candidate_compiler_evidence(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0}
        code, report = self.execute(json.dumps(monitor),container_exit=0,host_machine='aarch64')
        self.assertEqual(code,0)
        self.assertEqual(report['architecture'],'arm64')
        self.assertEqual(report['base_image'],PROFILES['arm64']['base'])
        self.assertIsNone(report['expected_gcc_binary_sha256'])
        self.assertFalse(report['compiler_pin_verified'])
        self.assertEqual(report['compiler_status'],'candidate-recorded')
        self.assertEqual(report['gcc']['target'],'aarch64-linux-gnu')

    def test_wrong_compiled_native_machine_is_rejected_even_with_matching_compiler_label(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0}
        code, report = self.execute(json.dumps(monitor),container_exit=0,
                                    host_machine='aarch64',compiled_machine=62)
        self.assertEqual(code,1)
        self.assertFalse(report['bounded_probe_passed'])

    def test_mismatched_compiler_target_and_changed_amd64_pin_fail_closed(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0}
        for kwargs in ({'host_machine':'aarch64','compiler_target':'x86_64-linux-gnu'},
                       {'compiler_sha':'f'*64}):
            with self.subTest(kwargs=kwargs):
                code, report = self.execute(json.dumps(monitor),container_exit=0,**kwargs)
                self.assertEqual(code,1)
                self.assertFalse(report['bounded_probe_passed'])
                self.assertFalse(report['compiler_pin_verified'])

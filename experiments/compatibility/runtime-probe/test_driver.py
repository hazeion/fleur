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
    def execute(self, memory_output, container_exit=137, docker_oom_killed=False, host_machine="x86_64", compiled_machine=None, compiler_target=None, compiler_sha=None, unsafe_environment=False, lifecycle_error=None, primary_error=None, trusted_build_network=None, healthy_containerd_exit=False, control_error=None):
        architecture = "arm64" if host_machine == "aarch64" else "amd64"
        cpu = {"throttled_periods":20,"throttled_usec":1987459}
        pids = {"errno":11,"current":64,"max":64,"limit_events":1}
        native = {"event_probe":0,"event_negatives":[-1]*12,"host_canary_absent":True,"architecture":architecture,"negative_controls":CONTROLS[architecture],"install":0,"main":[-1]*24,"thread":-1,"html":"<p>restricted render</p>",
                  "application_open":True,"descriptors_closed":True,"broker_reply":"registered:Squat",
                  "cgroups":{"cpu":"100000 100000","memory":"536870912","pids":"64"}}
        self.last_build_requests = []
        def command(args, **kwargs):
            if args[:2] == ['docker','build']: self.last_build_requests.append(args)
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
                return architecture if args[-1] == '{{.Architecture}}' else 'sha256:'+'a'*64
            if args[:2] == ['docker','inspect']: return json.dumps({'OOMKilled':docker_oom_killed})
            return '{}'
        owner = {}
        def subprocess_run(args, **kwargs):
            if args[:2] == ['docker','inspect'] and '{{json .}}' in args:
                metadata = {'Id':'a'*64,'Name':'/'+owner.get('container',''), 'Image':'sha256:'+'a'*64,
                            'Config':{'Image':'sha256:'+'a'*64,'User':'65534:65534','Labels':{'fleur.compatibility.runtime-owner':owner.get('value','')},
                            'Env':['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin',
                                   'BUN_RUNTIME_TRANSPILER_CACHE_PATH=0','BUN_INSTALL_BIN=/usr/local/bin','GLIBC_TUNABLES=glibc.pthread.rseq=0']},
                            'HostConfig':{'ReadonlyRootfs':True,'Privileged':False,'CapDrop':['ALL'],'CapAdd':None,
                            'SecurityOpt':['no-new-privileges','seccomp=unconfined'],'NanoCpus':1000000000,
                            'Memory':536870912,'MemorySwap':536870912,'PidsLimit':64,'NetworkMode':'none',
                            'Binds':None,'Mounts':None,'VolumesFrom':None,'Devices':[],'DeviceRequests':None,
                            'PidMode':'','IpcMode':'private','RestartPolicy':{'Name':'no'}},
                            'Mounts':[],'State':{'Running':True,'Pid':47},
                            'NetworkSettings':{'Networks':{'none':{'IPAddress':'','Gateway':'','GlobalIPv6Address':'','IPv6Gateway':''}}}}
                if unsafe_environment: metadata['Config']['Env'].append('DATABASE_URL=must-be-redacted')
                return SimpleNamespace(returncode=0,stdout=json.dumps(metadata),stderr='')
            if args[:2] == ['docker','run']:
                mode = args[-1]
                output = json.dumps(cpu if mode == 'cpu' else pids) if mode != 'memory' else memory_output
                return SimpleNamespace(returncode=container_exit if mode == 'memory' else 0,
                                       stdout=output,stderr='')
            return SimpleNamespace(returncode=0,stdout='',stderr='')
        threads = [{'pid':1,'no_new_privs':1,'seccomp':2,'seccomp_filters':1},
                   {'pid':7,'no_new_privs':1,'seccomp':2,'seccomp_filters':1}]
        def run_container(args, **kwargs):
            owner['container'] = args[args.index('--name')+1]
            if '--label' in args:
                owner['value'] = args[args.index('--label')+1].split('=',1)[1]
            inventory = [{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]
            audited = kwargs['startup_audit'](inventory)
            if args[-1] == 'event-replacement':
                kwargs['diagnostics']['stderr'] = '[compat-event] replacement-fd=3\n'
                raise run.StartupAuditRejected(audited['category'])
            if primary_error is not None: raise primary_error
            waiter = kwargs['completion_start'](30)
            kwargs['completion_observer'](native,30)
            waiter.completion(30)
            waiter.close()
            return json.dumps(native)
        captured = io.StringIO()
        run.REPORT = {'scope':'fixture','v1_gate_passed':False,'expected_gcc':'13.3.0',
                      'expected_gcc_binary_sha256':PROFILES['amd64']['compiler_sha256']}
        with patch.object(run.platform,'system',return_value='Linux'), \
             patch.object(run.platform,'machine',return_value=host_machine), \
             patch.object(run.shutil,'which',return_value=__file__), \
             patch.object(run.hashlib,'sha256',return_value=SimpleNamespace(hexdigest=lambda:compiler_sha or PROFILES[architecture]['compiler_sha256'])), \
             patch.object(Path,'read_text',return_value='Linux'), \
             patch.object(run,'command',side_effect=command), \
             patch.object(run,'run_container',side_effect=run_container), \
             patch.object(run,'snapshot_worker',return_value={'tasks':threads}), \
             patch.object(run,'run_lifecycle',return_value={'passed':True,'repeats':[{},{}]},side_effect=lifecycle_error) as lifecycle_call, \
             patch.object(run,'inspect_containerd_control',return_value={'ctr':'/usr/bin/ctr','address':'/run/containerd/containerd.sock','namespace':'moby'},side_effect=control_error), \
             patch.object(run,'OwnedWaiter',return_value=SimpleNamespace(completion=lambda r:{'completed':True,'exit_code':0},close=lambda:None)), \
             patch.object(run,'inspect_event_inventory',side_effect=lambda name,inventory:
                 {'passed':False,'category':'class-mismatch'} if name.endswith('-event-replacement') else
                 {'passed':True,'category':'verified','descriptor_count':len(inventory)}), \
             patch.object(run.subprocess,'run',side_effect=subprocess_run), \
             contextlib.redirect_stdout(captured):
            code = run.main(trusted_build_network=trusted_build_network,healthy_containerd_exit=healthy_containerd_exit)
        self.last_lifecycle_call=lifecycle_call.call_args
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

    def test_native_arm64_uses_its_image_and_executed_compiler_pin(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0}
        code, report = self.execute(json.dumps(monitor),container_exit=0,host_machine='aarch64')
        self.assertEqual(code,0)
        self.assertEqual(report['architecture'],'arm64')
        self.assertEqual(report['base_image'],PROFILES['arm64']['base'])
        self.assertEqual(report['expected_gcc_binary_sha256'],'a20520ee21543f243d40636a9181a142c45ecd989de31ab86b99a8ea5ada870d')
        self.assertTrue(report['compiler_pin_verified'])
        self.assertEqual(report['compiler_status'],'executed-pin')
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

    def test_changed_arm64_compiler_is_rejected_after_executed_pin_freeze(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0}
        code, report = self.execute(json.dumps(monitor),container_exit=0,
                                    host_machine='aarch64',compiler_sha='f'*64)
        self.assertEqual(code,1)
        self.assertFalse(report['bounded_probe_passed'])
        self.assertFalse(report['compiler_pin_verified'])

    def test_absent_compiler_pin_cannot_reenable_candidate_acceptance(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0}
        incomplete = dict(PROFILES['arm64'],compiler_sha256=None)
        with patch.dict(PROFILES,{'arm64':incomplete}):
            code, report = self.execute(json.dumps(monitor),container_exit=0,
                host_machine='aarch64',compiler_sha='a20520ee21543f243d40636a9181a142c45ecd989de31ab86b99a8ea5ada870d')
        self.assertEqual(code,1)
        self.assertFalse(report['bounded_probe_passed'])

    def test_actual_unsafe_worker_environment_is_rejected_without_value_disclosure(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0}
        code, report = self.execute(json.dumps(monitor),container_exit=0,unsafe_environment=True)
        self.assertEqual(code,1)
        self.assertFalse(report['bounded_probe_passed'])
        self.assertFalse('must-be-redacted' in json.dumps(report))

    def test_generic_healthy_completion_failure_retains_category_and_cleanup(self):
        from completion import CompletionUnverified
        error = CompletionUnverified('state-invalid',{'stdout_bytes':120,'stderr_bytes':0,'cli_returncode':0,'state_running':False})
        error.worker_role = 'healthy'
        error.worker_state = {'Running':False,'ExitCode':0,'FinishedAt':'2026-10-13T00:00:01Z'}
        error.worker_diagnostics = {'protocol_phase':'waiting-worker-completion'}
        error.lifecycle_cleanup_verified = False
        error.lifecycle_cleanup = [{'worker_role':'healthy','outcome':'removal-unverified'}]
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,'memory_max':536870912,'swap_max':0}
        code, report = self.execute(json.dumps(monitor),container_exit=0,lifecycle_error=error)
        self.assertEqual(code,1)
        self.assertEqual(report['completion_failure']['category'],'state-invalid')
        self.assertEqual(report['lifecycle_failure']['category'],'state-invalid')
        self.assertEqual(report['lifecycle_failure']['observations']['stdout_bytes'],120)
        self.assertFalse(report['lifecycle_failure']['cleanup_verified'])
        self.assertEqual(report['lifecycle_failure']['state']['ExitCode'],0)

    def test_primary_startup_rejection_retains_category_and_cleanup(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,'memory_max':536870912,'swap_max':0}
        code, report = self.execute(json.dumps(monitor),container_exit=0,
                                    primary_error=run.StartupAuditRejected('class-mismatch'))
        self.assertEqual(code,1)
        self.assertFalse(report['bounded_probe_passed'])
        self.assertEqual(report['startup_failure']['category'],'class-mismatch')
        self.assertNotIn('observations',report['startup_failure'])
        self.assertNotIn('completion_failure',report)
        self.assertTrue(report['cleanup_complete'])

    def test_unverified_lifecycle_removal_prevents_aggregate_cleanup_success(self):
        error = RuntimeError('owned lifecycle cleanup incomplete')
        error.lifecycle_cleanup_verified = False
        error.deadline_guard_cleanup_verified = False
        error.lifecycle_cleanup = [{'worker_role':'healthy','outcome':'inspection-unverified'}]
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0}
        code, report = self.execute(json.dumps(monitor),container_exit=0,lifecycle_error=error)
        self.assertEqual(code,1)
        self.assertFalse(report['cleanup_complete'])
        self.assertFalse(report['bounded_probe_passed'])
        self.assertEqual(report['lifecycle_failure']['cleanup'],error.lifecycle_cleanup)
        self.assertFalse(report['lifecycle_failure']['deadline_guard_cleanup_verified'])

    def test_removed_containers_do_not_hide_an_unreaped_lifecycle_observer(self):
        error = RuntimeError('observer cleanup unverified')
        error.lifecycle_cleanup_verified = True
        error.lifecycle_cleanup = [{'worker_role':'healthy','outcome':'removed'}]
        error.worker_diagnostics = {'waiter_cleanup_verified':False}
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,
                   'memory_max':536870912,'swap_max':0}
        code, report = self.execute(json.dumps(monitor),container_exit=0,lifecycle_error=error)
        self.assertEqual(code,1)
        self.assertTrue(report['lifecycle_failure']['cleanup_verified'])
        self.assertFalse(report['cleanup_complete'])

    def test_host_network_is_explicit_for_trusted_build_only(self):
        monitor = {'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,'memory_max':536870912,'swap_max':0}
        code, report = self.execute(json.dumps(monitor),container_exit=0,trusted_build_network='host')
        self.assertEqual(code,0)
        self.assertEqual(report['trusted_build_network'],'host')
        self.assertIn('--network=host',self.last_build_requests[0])
        self.assertEqual(report['worker_configuration']['network_mode'],'none')

    def test_containerd_evidence_is_explicit_and_only_for_concurrent_healthy_path(self):
        monitor={'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,'memory_max':536870912,'swap_max':0}
        code, report=self.execute(json.dumps(monitor),container_exit=0,healthy_containerd_exit=True)
        self.assertEqual(code,0)
        self.assertEqual(report['healthy_exit_evidence'],'containerd-init-exit')
        self.assertEqual(self.last_lifecycle_call.kwargs['containerd_control']['namespace'],'moby')
        self.assertEqual(self.last_lifecycle_call.kwargs['timeout'],30)
        code, report=self.execute(json.dumps(monitor),container_exit=0)
        self.assertEqual(code,0)
        self.assertIsNone(self.last_lifecycle_call.kwargs['containerd_control'])
        self.assertNotIn('host_containerd_control',report)

    def test_failed_host_prerequisite_reports_safe_category_before_lifecycle(self):
        from configuration import ContainerdControlUnverified
        error=ContainerdControlUnverified('ctr-client-revision',{'ctr_banner_fields':3,'ctr-client_revision_match':False})
        monitor={'child_signal':9,'oom_events_delta':1,'oom_kill_delta':1,'memory_max':536870912,'swap_max':0}
        code, report=self.execute(json.dumps(monitor),container_exit=0,healthy_containerd_exit=True,control_error=error)
        self.assertEqual(code,1)
        self.assertEqual(report['host_containerd_failure']['category'],'ctr-client-revision')
        self.assertEqual(report['host_containerd_failure']['observations']['ctr_banner_fields'],3)
        self.assertIsNone(self.last_lifecycle_call)
        self.assertTrue(report['cleanup_complete'])

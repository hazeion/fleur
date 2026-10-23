#!/usr/bin/env python3
"""Disposable native amd64/arm64 Linux experiment. Exit 0 accepts only bounded evidence."""
import argparse
from contextlib import contextmanager
import math
import os
import stat
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import time
from report import accept, accept_threads, CONTROLS
from runtime_profile import select_profile, native_elf_identity
from helper_artifacts import stage_recorded_helpers, revalidate_recorded_helpers, accept_helper_origin
from protocol import run_container, StartupAuditRejected
from resources import accept_resources
from diagnostics import snapshot_worker
from configuration import inspect_worker_configuration, host_environment, OWNER_LABEL, inspect_containerd_control, ContainerdControlUnverified
from lifecycle import run_lifecycle
from engine_state import read_owned_container_state
from descriptor_audit import inspect_event_inventory
from completion import CompletionUnverified
from waiter import OwnedWaiter, WaitUnverified
from containerd_observer import ObserverUnverified
from daemon_trace import capture_daemon_trace

HERE = Path(__file__).resolve().parent
REPORT = {'scope': 'bounded-pre-application-tsync-render', 'v1_gate_passed': False,
          'expected_bun': '1.4.3', 'expected_gcc': '13.3.0'}


def command(args, timeout=30, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                            timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f'{args[0]} exited {result.returncode}: '
                           + (result.stdout + result.stderr)[-3000:])
    return result.stdout.strip()


class RecordedBuildContext:
    """One fixed probe context, retained until its owning VM is disposed."""
    NAMES = {'bootstrap.ts', 'heap_probe.ts', 'heap_probe.test.ts', 'application.js',
             'busy-application.js', 'profile.json', 'package.json', 'bun.lock',
             'filter.so', 'abuse', 'Dockerfile'}

    def __init__(self, path, directory, identity, deadline, observation):
        self.path, self.directory, self.identity = path, directory, identity
        self.deadline, self.observation = deadline, observation
        self.ledger = None
        self.closed = False

    def __fspath__(self):
        return self.path

    def _remaining(self):
        if self.closed or time.monotonic() >= self.deadline:
            raise ValueError('recorded helper context deadline expired')

    @staticmethod
    def _file_identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
                info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def _snapshot(self):
        self._remaining()
        current = os.stat(self.path, follow_symlinks=False)
        held = os.fstat(self.directory)
        expected = (self.identity.st_dev, self.identity.st_ino, self.identity.st_uid, self.identity.st_mode)
        if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino, current.st_uid, current.st_mode) != expected or (held.st_dev, held.st_ino, held.st_uid, held.st_mode) != expected:
            raise ValueError('recorded helper context custody changed')
        entries = os.listdir(self.directory)
        if len(entries) > len(self.NAMES) or not set(entries).issubset(self.NAMES):
            raise ValueError('recorded helper context entries changed')
        snapshot = {}
        total = 0
        for name in sorted(entries):
            self._remaining()
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.directory)
            try:
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_mode & 0o022 or before.st_size > 8*1024*1024:
                    self.observation['rejected_entry'] = {'name': name, 'mode': stat.S_IMODE(before.st_mode)}
                    raise ValueError('recorded helper context entries changed')
                digest = hashlib.sha256()
                count = 0
                while True:
                    self._remaining()
                    block = os.read(fd, min(65536, before.st_size+1-count))
                    if not block:
                        break
                    count += len(block)
                    if count > before.st_size:
                        raise ValueError('recorded helper context inputs changed')
                    digest.update(block)
                after = os.fstat(fd)
                named = os.stat(name, dir_fd=self.directory, follow_symlinks=False)
                if count != before.st_size or self._file_identity(before) != self._file_identity(after) or self._file_identity(after) != self._file_identity(named):
                    raise ValueError('recorded helper context inputs changed')
                total += count
                if total > 32*1024*1024:
                    raise ValueError('recorded helper context inputs exceed bound')
                snapshot[name] = (self._file_identity(after), digest.hexdigest())
            finally:
                os.close(fd)
        for name, (identity, _) in snapshot.items():
            self._remaining()
            if self._file_identity(os.stat(name, dir_fd=self.directory, follow_symlinks=False)) != identity:
                raise ValueError('recorded helper context inputs changed')
        named = os.stat(self.path, follow_symlinks=False)
        if (named.st_dev, named.st_ino, named.st_uid, named.st_mode) != expected or set(os.listdir(self.directory)) != set(snapshot):
            raise ValueError('recorded helper context custody changed')
        self._remaining()
        return snapshot

    def write_input(self, name, body):
        if name not in self.NAMES - {'filter.so', 'abuse'} or type(body) is not bytes or len(body) > 8*1024*1024:
            raise ValueError('recorded helper context input differs')
        expected = (self.identity.st_dev, self.identity.st_ino, self.identity.st_uid, self.identity.st_mode)
        def parent_current():
            self._remaining()
            for info in (os.fstat(self.directory), os.stat(self.path, follow_symlinks=False)):
                if not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino, info.st_uid, info.st_mode) != expected:
                    raise ValueError('recorded helper context custody changed')
        parent_current()
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o644, dir_fd=self.directory)
        try:
            created = os.fstat(fd)
            if not stat.S_ISREG(created.st_mode) or created.st_uid != os.getuid() or created.st_nlink != 1:
                raise ValueError('recorded helper context input custody changed')
            # The exclusive newly-created descriptor is ours even if its name is replaced.
            # Explicit mode also supports restrictive inherited umasks without pathname chmod.
            os.fchmod(fd, 0o644)
            offset = 0
            while offset < len(body):
                self._remaining()
                written = os.write(fd, body[offset:offset+65536])
                if written <= 0:
                    raise OSError('recorded helper context write made no progress')
                offset += written
            os.fsync(fd)
            after = os.fstat(fd)
            named = os.stat(name, dir_fd=self.directory, follow_symlinks=False)
            if (after.st_dev, after.st_ino) != (created.st_dev, created.st_ino) or self._file_identity(after) != self._file_identity(named) or after.st_size != len(body) or stat.S_IMODE(after.st_mode) != 0o644 or after.st_nlink != 1:
                raise ValueError('recorded helper context input custody changed')
            parent_current()
        finally:
            os.close(fd)

    def seal(self, staged_helpers=None):
        if self.ledger is not None:
            raise ValueError('recorded helper context already sealed')
        snapshot = self._snapshot()
        if staged_helpers is not None:
            for name in ('filter.so', 'abuse'):
                if snapshot.get(name, (None,))[0] != staged_helpers['files'][name]['identity']:
                    raise ValueError('recorded helper context staged identity changed')
        self.ledger = snapshot
        self.observation['ledger_verified'] = True

    def revalidate(self):
        self.observation['ledger_verified'] = False
        snapshot = self._snapshot()
        if self.ledger is None or snapshot != self.ledger:
            raise ValueError('recorded helper context inputs changed')
        self.observation['ledger_verified'] = True


@contextmanager
def recorded_probe_context(report, absolute_deadline):
    if type(absolute_deadline) not in (int, float) or not math.isfinite(absolute_deadline) or time.monotonic() >= absolute_deadline:
        raise ValueError('recorded helper context deadline expired')
    observation = {'retained': True, 'cleanup_confirmed': False, 'path': None,
                   'state': 'retained-for-owned-guest-disposal',
                   'disposal_scope': 'owned-full-system-guest-filesystem',
                   'local_disposal': 'pending', 'ledger_verified': False}
    report['helper_artifact_context'] = observation
    temporary = tempfile.TemporaryDirectory(prefix='fleur-runtime-probe-', delete=False)
    observation['path'] = temporary.name
    directory = os.open(temporary.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    context = None
    try:
        before = os.fstat(directory)
        if not stat.S_ISDIR(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o077:
            raise ValueError('recorded helper context custody differs')
        context = RecordedBuildContext(temporary.name, directory, before, absolute_deadline, observation)
        try:
            yield context
        except BaseException:
            observation['ledger_verified'] = False
            raise
        else:
            if context.ledger is not None:
                context.revalidate()
            else:
                context._snapshot()
    finally:
        if context is not None:context.closed = True
        os.close(directory)



def main(architecture=None, trusted_build_network=None, healthy_containerd_exit=False, kernel_private_network=False, idle_runtime_stress=False, *, owned_guest_nonce=None, owned_guest_boot_id=None, owned_guest_uid=None, owned_guest_manifest_sha256=None, owned_guest_deadline=None, recorded_helper_artifacts=None):
    recorded = recorded_helper_artifacts is not None
    REPORT.pop('helper_origin', None)
    REPORT.pop('helper_artifact_context', None)
    REPORT.pop('helper_origin_verified', None)
    tag = 'fleur-runtime-probe-' + str(time.time_ns())
    container = tag + '-run'
    result_code = 1
    build_started = False
    build_finished = False
    run_started = False
    resource_containers = []
    worker_environment = host_environment()
    creator = None
    host_context=None;host_binding=None
    def trace(remaining):
        if host_context is None:return capture_daemon_trace(remaining)
        if host_binding is None:return {'outcome':'owned-daemon-binding-unavailable'}
        return capture_daemon_trace(remaining,host_binding=host_binding)
    try:
        from host_control import select_owned_context
        owned_values=(owned_guest_nonce,owned_guest_boot_id,owned_guest_uid,owned_guest_manifest_sha256,owned_guest_deadline)
        if any(value is not None for value in owned_values):
            if any(value is None for value in owned_values) or kernel_private_network:raise ValueError('complete owned binding without kernel-private scope required')
            if type(owned_guest_deadline) not in (float,int):raise ValueError('original owned deadline required')
            host_context=select_owned_context(owned_guest_nonce,owned_guest_boot_id,owned_guest_uid,owned_guest_manifest_sha256,remaining=owned_guest_deadline-time.monotonic(),deadline=owned_guest_deadline)
            REPORT['owned_host_control']=host_context.report()
        if recorded_helper_artifacts is not None and (type(recorded_helper_artifacts) is not str or not recorded_helper_artifacts or '\x00' in recorded_helper_artifacts or host_context is None or kernel_private_network):
            raise ValueError('recorded helpers require original owned guest context')
        if type(idle_runtime_stress) is not bool:raise ValueError('idle runtime stress flag invalid')
        REPORT['idle_runtime_stress']=idle_runtime_stress
        if trusted_build_network not in (None,'host'): raise ValueError('trusted build network invalid')
        if kernel_private_network:
            from kernel_docker import KernelPrivateDocker
            creator=KernelPrivateDocker(worker_environment)
        REPORT['kernel_private_network'] = kernel_private_network
        REPORT['trusted_build_network'] = trusted_build_network or 'default'
        architecture, selected = select_profile(architecture, platform.system(), platform.machine())
        base = selected['base']
        expected_compiler = selected['compiler_sha256']
        REPORT.update({'architecture':architecture, 'base_image':base,
                       'expected_gcc_binary_sha256':expected_compiler,
                       'compiler_status':'prebuilt-origin' if recorded else 'executed-pin',
                       'compiler_pin_verified':False})
        if type(expected_compiler) is not str or len(expected_compiler) != 64 or any(
                character not in '0123456789abcdef' for character in expected_compiler):
            raise RuntimeError('native compiler profile lacks an executed SHA-256 pin')
        if recorded:
            REPORT.pop('gcc', None)
        else:
            compiler = shutil.which('gcc')
            if compiler is None:
                raise RuntimeError('gcc prerequisite missing; nothing installed')
            version = command([compiler, '-dumpfullversion'])
            REPORT['gcc'] = {'target': command([compiler, '-dumpmachine']), 'version': command([compiler, '--version']),
                             'binary_sha256': hashlib.sha256(Path(compiler).read_bytes()).hexdigest()}
            if REPORT['gcc']['target'] != selected['compiler_target']:
                raise RuntimeError('compiler target differs from native architecture')
            if REPORT['gcc']['binary_sha256'] != expected_compiler:
                raise RuntimeError('compiler binary differs from executed GCC pin')
            if version != REPORT['expected_gcc']:
                raise RuntimeError(f'compiler candidate mismatch: {version}')
            REPORT['compiler_pin_verified'] = True
        REPORT['source_sha256'] = {name:hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                                  for name in ('filter.c','abuse.c','bootstrap.ts','heap_probe.ts','heap_probe.test.ts','application.js',
                                               'protocol.py','report.py','runtime_profile.py','run.py','resources.py','threads.py','diagnostics.py','configuration.py','lifecycle.py','busy-application.js','descriptor_audit.py','completion.py','waiter.py','daemon_trace.py','containerd_observer.py',
                                               'registration_canary.py','worker_deadline.py','helper_artifacts.py','recorded-helper-origin.json','host_control.py','owned_guest.py','privileged_control.py','kernel_network.py','kernel_docker.py','engine_state.py')}
        REPORT['host'] = {'kernel': platform.release(),
                          'os_release': Path('/etc/os-release').read_text(),
                          'docker': command(['docker', 'version', '--format', '{{json .}}'])}
        context_lifetime = recorded_probe_context(REPORT, host_context.deadline) if recorded else tempfile.TemporaryDirectory(prefix='fleur-runtime-probe-')
        with context_lifetime as directory:
            context = Path(directory)
            for name in ('bootstrap.ts', 'heap_probe.ts', 'heap_probe.test.ts', 'application.js', 'busy-application.js'):
                if recorded:
                    directory.write_input(name, (HERE / name).read_bytes())
                else:
                    shutil.copyfile(HERE / name, context / name)
            profile_text = json.dumps({'architecture':architecture, 'negative_controls':CONTROLS[architecture]})
            if recorded:
                directory.write_input('profile.json', profile_text.encode())
            else:
                (context / 'profile.json').write_text(profile_text)
            dependencies = HERE.parent / 'rendering'
            for name in ('package.json', 'bun.lock'):
                if recorded:
                    directory.write_input(name, (dependencies / name).read_bytes())
                else:
                    shutil.copyfile(dependencies / name, context / name)
            if recorded:
                host_context.verify(host_context.deadline-time.monotonic())
                staged_helpers = stage_recorded_helpers(recorded_helper_artifacts, context, architecture, base, host_context.deadline)
                REPORT['helper_origin'] = staged_helpers['origin']
            else:
                command([compiler, '-shared', '-fPIC', '-O2', '-std=c11', '-Wall', '-Wextra',
                         '-Werror', '-pthread', str(HERE / 'filter.c'), '-o', str(context / 'filter.so')])
                command([compiler, '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-pthread',
                         str(HERE / 'abuse.c'), '-o', str(context / 'abuse')])
            REPORT['helper_elf'] = native_elf_identity((context / 'filter.so').read_bytes()[:64], architecture)
            REPORT['abuse_elf'] = native_elf_identity((context / 'abuse').read_bytes()[:64], architecture)
            REPORT['abuse_sha256'] = hashlib.sha256((context / 'abuse').read_bytes()).hexdigest()
            REPORT['helper_sha256'] = hashlib.sha256((context / 'filter.so').read_bytes()).hexdigest()
            dockerfile_text = f'''FROM {base} AS prepare
WORKDIR /probe
COPY package.json bun.lock ./
RUN test "$(bun --version)" = "1.4.3" && bun install --production --frozen-lockfile
COPY bootstrap.ts heap_probe.ts heap_probe.test.ts ./
RUN bun test heap_probe.test.ts && BUN_JSC_useConcurrentJIT=0 BUN_JSC_useConcurrentGC=0 BUN_JSC_numberOfGCMarkers=1 BUN_JSC_useWarmUpMarkedBlocks=0 bun test heap_probe.test.ts
RUN bun build bootstrap.ts --target=bun --outfile=bootstrap.js
FROM {base}
WORKDIR /probe
COPY --from=prepare /probe/bootstrap.js ./
COPY filter.so application.js busy-application.js abuse profile.json ./
ENV GLIBC_TUNABLES=glibc.pthread.rseq=0 \
    BUN_JSC_useConcurrentJIT=0 \
    BUN_JSC_useConcurrentGC=0 \
    BUN_JSC_numberOfGCMarkers=1 \
    BUN_JSC_useWarmUpMarkedBlocks=0
USER 65534:65534
ENTRYPOINT ["bun", "/probe/bootstrap.js"]
'''
            if recorded:
                directory.write_input('Dockerfile', dockerfile_text.encode())
            else:
                (context / 'Dockerfile').write_text(dockerfile_text)
            if recorded:
                host_context.verify(host_context.deadline-time.monotonic())
                revalidate_recorded_helpers(context, staged_helpers, host_context.deadline)
                directory.seal(staged_helpers)
                directory.revalidate()
            build_started = True
            command(['docker', 'build', *(['--network=host'] if trusted_build_network == 'host' else []), '--platform', 'linux/' + architecture, '-t', tag, str(context)], timeout=240)
            build_finished = True
            REPORT['image_architecture'] = command(['docker','image','inspect',tag,'--format','{{.Architecture}}'])
            if REPORT['image_architecture'] != architecture:
                raise RuntimeError('built Docker image architecture differs from native runner')
            REPORT['image_id'] = command(['docker', 'image', 'inspect', tag, '--format', '{{.Id}}'])
            run_started = True
            def audited_worker(name,owner,inventory):
                configuration = inspect_worker_configuration(name,owner,REPORT['image_id'],kernel_private=kernel_private_network)
                snapshot = snapshot_worker(name)
                rows = [{key:row[key] for key in ('pid','no_new_privs','seccomp','seccomp_filters')}
                        for row in snapshot['tasks']]
                if not accept_threads(rows):
                    raise RuntimeError('existing thread lacks the sole native restriction filter')
                descriptors = inspect_event_inventory(name,inventory)
                return {'host_threads':rows,'configuration_verified':True,'configuration':configuration,
                        'snapshot':snapshot,'descriptor_audit':descriptors}
            def startup_worker(inventory):
                audited = audited_worker(container,tag,inventory)
                REPORT['worker_configuration'] = audited['configuration']
                REPORT['host_pause_diagnostics'] = audited['snapshot']
                REPORT['host_threads'] = audited['host_threads']
                REPORT['worker_descriptors'] = audited['descriptor_audit']
                return audited['descriptor_audit']
            def completed_worker(frame,remaining):
                if ('host_threads' in frame or 'cleanup_complete' in frame
                        or not accept(dict(frame,host_threads=REPORT.get('host_threads'),cleanup_complete=True),architecture)
                        or frame.get('host_canary_absent') is not True):
                    raise RuntimeError('completed worker evidence invalid')
                return {'completed':True,'exit_code':0}
            def start_waiter(remaining):
                return OwnedWaiter(REPORT['worker_configuration']['container_id'],timeout=remaining)
            REPORT['worker_protocol'] = {}
            primary_command = ['docker', 'run', '-i', '--name', container, '--label', OWNER_LABEL+'='+tag, '--network=none',
                              '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                              '--security-opt=seccomp=unconfined', '--cpus=1', '--memory=512m',
                              '--memory-swap=512m', '--pids-limit=64', '--ulimit=core=0', '--pull=never', REPORT['image_id']]
            if creator is not None:
                primary_id=creator.create_worker(container,tag,REPORT['image_id'],'render')
                primary_command=['docker','start','--attach','--interactive',primary_id]
            output = run_container(primary_command, timeout=30, startup_audit=startup_worker, diagnostics=REPORT['worker_protocol'], environment=worker_environment, completion_observer=completed_worker,completion_start=start_waiter,completion_stall=trace)
            if len(output) > 16384:
                raise RuntimeError('probe output exceeded bound')
            # Retain successful native evidence even if a later resource probe fails.
            REPORT['evidence'] = json.loads(output)
            evidence = REPORT['evidence']
            if isinstance(evidence, dict):
                evidence['host_threads'] = REPORT.get('host_threads')
                if evidence.get('host_canary_absent') is not True:
                    raise RuntimeError('restricted worker host canary exclusion failed')
            if not isinstance(evidence, dict) or not accept(dict(evidence, cleanup_complete=True), architecture):
                raise RuntimeError('incomplete, malformed or failed bounded runtime evidence')
            resources = {}
            REPORT['trusted_cgroup_abuse'] = resources
            for mode in ('cpu', 'memory', 'pids'):
                resource_name = tag + '-' + mode
                resource_containers.append(resource_name)
                if creator is not None:
                    from kernel_docker import run_resource
                    abuse=run_resource(creator,resource_name,tag,REPORT['image_id'],mode,worker_environment)
                else:
                    abuse = subprocess.run(['docker', 'run', '--name', resource_name,
                        '--network=none', '--read-only', '--cap-drop=ALL',
                        '--security-opt=no-new-privileges', '--security-opt=seccomp=unconfined',
                        '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=64',
                        '--ulimit=core=0', '--pull=never', '--entrypoint=/probe/abuse',
                        REPORT['image_id'], mode], capture_output=True, text=True, timeout=15)
                if mode == 'memory':
                    state = json.loads(command(['docker', 'inspect', resource_name,
                                                '--format', '{{json .State}}']))
                    resources[mode] = {'container_exit': abuse.returncode,
                                       'docker_oom_killed': state.get('OOMKilled')}
                    if not abuse.stdout.strip() or len(abuse.stdout.encode('utf-8')) > 4096:
                        raise RuntimeError('native memory monitor output missing or exceeded bound')
                    monitor = json.loads(abuse.stdout)
                    if not isinstance(monitor, dict) or set(monitor) != {
                            'child_signal', 'oom_events_delta', 'oom_kill_delta',
                            'memory_max', 'swap_max'}:
                        raise RuntimeError('native memory monitor fields invalid')
                    resources[mode].update(monitor)
                else:
                    if abuse.returncode or len(abuse.stdout) > 4096:
                        raise RuntimeError('trusted cgroup ' + mode + ' experiment failed')
                    resources[mode] = json.loads(abuse.stdout)
            REPORT['trusted_cgroup_abuse'] = resources
            if not accept_resources(resources):
                raise RuntimeError('missing controlled cgroup enforcement evidence')
            if healthy_containerd_exit and host_context is not None:
                control,host_binding=inspect_containerd_control(host_context=host_context,with_binding=True)
            else:control=inspect_containerd_control() if healthy_containerd_exit else None
            state_endpoint=None
            if control is not None:
                state_endpoint=control.pop('_docker_state_endpoint',None)
                if creator is None and type(state_endpoint) is not dict:
                    raise RuntimeError('verified default Engine endpoint missing')
                REPORT['host_containerd_control'] = control
            REPORT['healthy_exit_evidence'] = 'containerd-init-exit' if control is not None else 'startup-bound-docker-wait'
            REPORT['restricted_worker_lifecycle'] = run_lifecycle(
                REPORT['image_id'],tag,architecture,worker_environment,audited_worker,timeout=30,containerd_control=control,host_binding=host_binding,
                create_worker=(lambda name,busy,remaining:creator.create_worker(name,tag,REPORT['image_id'],'busy' if busy else 'render',remaining)) if creator is not None else None,
                aggregate_preparation_budget=creator is not None,
                inspect_worker_state=(lambda cid,remaining:read_owned_container_state(state_endpoint,cid,timeout=remaining)) if state_endpoint is not None and creator is None else None)
            if idle_runtime_stress:
                idle_tag=tag+'-idle'
                REPORT['restricted_worker_idle_lifecycle'] = run_lifecycle(
                    REPORT['image_id'],idle_tag,architecture,worker_environment,audited_worker,timeout=30,
                    containerd_control=control,host_binding=host_binding,broker_ack_delay=11,
                    create_worker=(lambda name,busy,remaining:creator.create_worker(name,idle_tag,REPORT['image_id'],'busy' if busy else 'render',remaining)) if creator is not None else None,
                    aggregate_preparation_budget=creator is not None,
                    inspect_worker_state=(lambda cid,remaining:read_owned_container_state(state_endpoint,cid,timeout=remaining)) if state_endpoint is not None and creator is None else None)
            negative_name = tag+'-event-replacement'
            resource_containers.append(negative_name)
            negative_diagnostics = {}
            REPORT['event_replacement_diagnostics'] = negative_diagnostics
            def replacement_audit(inventory):
                audited = audited_worker(negative_name,tag,inventory)
                REPORT['event_replacement_audit'] = audited['descriptor_audit']
                return audited['descriptor_audit']
            try:
                negative_command = ['docker','run','-i','--name',negative_name,'--label',OWNER_LABEL+'='+tag,
                    '--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
                    '--security-opt=seccomp=unconfined','--cpus=1','--memory=512m','--memory-swap=512m',
                    '--pids-limit=64','--ulimit=core=0','--pull=never',REPORT['image_id'],'event-replacement']
                if creator is not None:
                    negative_id=creator.create_worker(negative_name,tag,REPORT['image_id'],'event-replacement')
                    negative_command=['docker','start','--attach','--interactive',negative_id]
                run_container(negative_command,
                    startup_audit=replacement_audit,environment=worker_environment,diagnostics=negative_diagnostics,timeout=30)
            except StartupAuditRejected as rejected:
                REPORT['event_replacement_rejection_category'] = rejected.category
                stderr = negative_diagnostics.get('stderr','')
                if (rejected.category != 'class-mismatch' or '[compat-event] replacement-fd=' not in stderr
                        or '[compat-event] startup-approved' in stderr or '[compat-event] result=' in stderr
                        or '[DEBUG-runtime] eval-compile-start' in stderr):
                    raise RuntimeError('controlled descriptor replacement failed the expected pre-application rejection')
                REPORT['event_replacement_negative'] = {'passed':True,'category':'class-mismatch',
                    'application_evaluated':False,'event_probe_executed':False,'startup_acknowledged':False}
            else:
                raise RuntimeError('controlled descriptor replacement was admitted')
            REPORT['event_replacement_diagnostics'] = negative_diagnostics
        result_code = 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as error:
        REPORT['bounded_probe_passed'] = False
        REPORT['failure'] = str(error)[:4000]
        from kernel_docker import EngineRequestUnverified
        if isinstance(error,EngineRequestUnverified):
            REPORT['vfs_engine_failure']={'category':error.category,'observations':error.observations}
        if isinstance(error,ContainerdControlUnverified):
            REPORT['host_containerd_failure']={'category':error.category,'observations':error.observations}
        if isinstance(error,StartupAuditRejected):
            REPORT['startup_failure'] = {'category':error.category}
        if isinstance(error,(CompletionUnverified,WaitUnverified,ObserverUnverified)):
            REPORT['completion_failure'] = {'category':error.category,'observations':error.observations}
        if hasattr(error,'worker_role') or hasattr(error,'lifecycle_cleanup'):
            REPORT['lifecycle_failure'] = {
                'error_type':type(error).__name__,
                'category':getattr(error,'category','lifecycle-error'),
                'observations':getattr(error,'observations',{}),
                'worker_role':getattr(error,'worker_role','unknown'),
                'state':getattr(error,'worker_state',{'outcome':'unavailable'}),
                'protocol':getattr(error,'worker_diagnostics',{}),
                'cleanup':getattr(error,'lifecycle_cleanup',[]),
                'cleanup_verified':getattr(error,'lifecycle_cleanup_verified',False),
            }
            if hasattr(error,'deadline_guard_cleanup_verified'):
                REPORT['lifecycle_failure']['deadline_guard_cleanup_verified'] = error.deadline_guard_cleanup_verified is True
        if isinstance(error, subprocess.TimeoutExpired) and run_started and hasattr(error,'protocol_phase'):
            REPORT['worker_timeout'] = {
                'protocol_phase':getattr(error,'protocol_phase','unknown'),
                'stdout':(error.output or b'')[:16384].decode('utf-8',errors='replace'),
                'stderr':(error.stderr or b'')[:4096].decode('utf-8',errors='replace'),
            }
            if getattr(error,'worker_role',None) == 'healthy':
                REPORT['lifecycle_timeout'] = {'worker_role':'healthy','state':error.worker_state,
                                               'protocol':error.worker_diagnostics}
            else:
                try:
                    REPORT['host_timeout_diagnostics'] = snapshot_worker(container)
                except (OSError,RuntimeError,ValueError,subprocess.TimeoutExpired) as diagnostic_error:
                    REPORT['host_timeout_diagnostics'] = {'outcome':'timed-out' if isinstance(diagnostic_error,subprocess.TimeoutExpired) else 'unavailable'}
        result_code = 1
    finally:
        if creator is not None:creator.close()
        cleanup = []
        cleanup_resources = [
            ('container', run_started, ['docker', 'rm', '-f', container]),
            ('image', build_started, ['docker', 'image', 'rm', '-f', tag]),
        ]
        cleanup_resources.extend(('resource-container', True, ['docker', 'rm', '-f', name])
                                 for name in resource_containers)
        for resource, started, args in cleanup_resources:
            if not started:
                cleanup.append({'resource': resource, 'outcome': 'never-created'})
                continue
            try:
                removed = subprocess.run(args, capture_output=True, text=True,
                                         timeout=15, check=False)
                absent = (('No such container:' if resource in ('container', 'resource-container') else
                           'No such image:') in removed.stderr)
                outcome = 'removed' if removed.returncode == 0 else 'absent' if absent else 'failed'
                cleanup.append({'resource': resource, 'outcome': outcome})
            except (OSError, subprocess.TimeoutExpired):
                cleanup.append({'resource': resource, 'outcome': 'failed'})
        REPORT['cleanup'] = cleanup
        # A timed-out Docker build command can leave daemon work running after
        # its CLI has died. Removing a current tag does not cancel that work.
        REPORT['daemon_build_may_be_pending'] = build_started and not build_finished
        REPORT['cleanup_complete'] = (all(item['outcome'] != 'failed' for item in cleanup)
                                      and not REPORT['daemon_build_may_be_pending']
                                      and ('lifecycle_failure' not in REPORT or
                                           REPORT['lifecycle_failure'].get('cleanup_verified') is True)
                                      and all(protocol.get('waiter_cleanup_verified',True) is True
                                              for protocol in (REPORT.get('worker_protocol',{}),
                                                  REPORT.get('lifecycle_failure',{}).get('protocol',{}))))
        evidence = REPORT.get('evidence')
        artifact_context = REPORT.get('helper_artifact_context', {})
        disposal_scope_verified = not recorded or (host_context is not None and not kernel_private_network
            and artifact_context.get('state') == 'retained-for-owned-guest-disposal'
            and artifact_context.get('disposal_scope') == 'owned-full-system-guest-filesystem'
            and artifact_context.get('local_disposal') == 'pending'
            and artifact_context.get('ledger_verified') is True
            and artifact_context.get('cleanup_confirmed') is False and artifact_context.get('retained') is True)
        if recorded:REPORT['owned_artifact_disposal_scope_verified'] = disposal_scope_verified
        origin_verified = accept_helper_origin(REPORT, recorded, host_context.deadline if host_context is not None else None)
        if recorded:REPORT['helper_origin_verified'] = origin_verified
        REPORT['bounded_probe_passed'] = (disposal_scope_verified and origin_verified and result_code == 0 and isinstance(evidence, dict)
            and accept(dict(evidence, cleanup_complete=REPORT['cleanup_complete']), architecture)
            and accept_resources(REPORT.get('trusted_cgroup_abuse'))
            and type(REPORT.get('worker_configuration')) is dict
            and evidence.get('host_canary_absent') is True
            and type(REPORT.get('restricted_worker_lifecycle')) is dict
            and REPORT['restricted_worker_lifecycle'].get('passed') is True
            and type(REPORT['restricted_worker_lifecycle'].get('repeats')) is list
            and len(REPORT['restricted_worker_lifecycle']['repeats']) == 2
            and (not idle_runtime_stress or (
                type(REPORT.get('restricted_worker_idle_lifecycle')) is dict
                and REPORT['restricted_worker_idle_lifecycle'].get('passed') is True
                and type(REPORT['restricted_worker_idle_lifecycle'].get('repeats')) is list
                and len(REPORT['restricted_worker_idle_lifecycle']['repeats'])==2
                and all(type(row) is dict and row.get('deadline_seconds')==30
                        and row.get('retained_heap_verified_before_cpu_loop') is True
                        and type(row.get('broker_ack_pause')) is dict
                        and row['broker_ack_pause'].get('requested_ms')==11000
                        and type(row['broker_ack_pause'].get('duration_ms')) is int
                        and row['broker_ack_pause']['duration_ms']>10000
                        and row['broker_ack_pause'].get('completed') is True
                        and row['broker_ack_pause'].get('after_restriction_audit') is True
                        and row['broker_ack_pause'].get('registered_request_verified') is True
                        for row in REPORT['restricted_worker_idle_lifecycle']['repeats'])))
            and type(REPORT.get('worker_descriptors')) is dict and REPORT['worker_descriptors'].get('passed') is True
            and type(REPORT.get('event_replacement_negative')) is dict
            and REPORT['event_replacement_negative'].get('passed') is True)
        if not REPORT['cleanup_complete']:
            REPORT['cleanup_failure'] = 'owned resource cleanup incomplete or daemon build state unresolved'
            result_code = 1
        if not REPORT['bounded_probe_passed']:
            result_code = 1
        print(json.dumps(REPORT, indent=2))
    return result_code


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--architecture', choices=('amd64','arm64'),
                        help='require this native Linux architecture; default detects supported native host')
    parser.add_argument('--trusted-build-network',choices=('host',),help='explicit trusted dependency build networking; worker networking remains none')
    parser.add_argument('--healthy-containerd-exit',action='store_true',help='Linux-host-only matching init exit evidence for concurrent healthy workers; removal still required')
    parser.add_argument('--kernel-private-network',action='store_true',help='owned VFS only: explicit NetworkDisabled plus measured kernel isolation')
    parser.add_argument('--idle-runtime-stress',action='store_true',help='add two unchanged 30-second lifecycle proofs with an audited 11-second broker pause')
    parser.add_argument('--owned-guest-nonce')
    parser.add_argument('--owned-guest-boot-id')
    parser.add_argument('--owned-guest-uid',type=int)
    parser.add_argument('--owned-guest-manifest-sha256')
    parser.add_argument('--owned-guest-deadline',type=float)
    parser.add_argument('--recorded-helper-artifacts',help='internal owned-fixture byte location; immutable source record only')
    arguments = parser.parse_args()
    raise SystemExit(main(arguments.architecture,arguments.trusted_build_network,arguments.healthy_containerd_exit,arguments.kernel_private_network,arguments.idle_runtime_stress,owned_guest_nonce=arguments.owned_guest_nonce,owned_guest_boot_id=arguments.owned_guest_boot_id,owned_guest_uid=arguments.owned_guest_uid,owned_guest_manifest_sha256=arguments.owned_guest_manifest_sha256,owned_guest_deadline=arguments.owned_guest_deadline,recorded_helper_artifacts=arguments.recorded_helper_artifacts))

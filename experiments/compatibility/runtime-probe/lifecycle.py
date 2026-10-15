"""Deadline proof across Docker CLI and owned daemon worker boundaries."""
from concurrent.futures import ThreadPoolExecutor
import json
import re
import subprocess
import sys
import threading
import time
from protocol import run_container, fixture_dispatch
from report import accept, accept_threads
from waiter import OwnedWaiter
from containerd_observer import ContainerdObserver
from daemon_trace import capture_daemon_trace
from worker_deadline import HostDeadlineGuard

OWNER_LABEL = 'fleur.compatibility.runtime-owner'


def safe_worker_state(state):
    if (type(state) is dict and type(state.get('Running')) is bool
            and type(state.get('ExitCode')) is int and 0 <= state['ExitCode'] <= 255
            and type(state.get('FinishedAt')) is str
            and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z',state['FinishedAt'])):
        return {key:state[key] for key in ('Running','ExitCode','FinishedAt')}
    return {'outcome':'output-invalid'}


def run_lifecycle(image_id, tag, architecture, environment, observe_worker,
                  timeout=30, docker='docker', containerd_control=None, deadline_factory=None):
    repeats = []
    def command(args):
        result = subprocess.run([docker, *args], env=environment,
                                capture_output=True, text=True, timeout=5)
        if result.returncode or len(result.stdout) > 65536:
            raise RuntimeError('owned lifecycle Docker command failed')
        return result.stdout
    def inspect(name):
        value = json.loads(command(['inspect', name, '--format', '{{json .}}']))
        if type(value) is not dict or value.get('Config', {}).get('Labels', {}).get(OWNER_LABEL) != tag:
            raise RuntimeError('lifecycle container ownership mismatch')
        return value['State']
    def args(name, busy=False):
        result = [docker, 'run', '-i', '--name', name, '--label', OWNER_LABEL+'='+tag,
                  '--network=none', '--read-only', '--cap-drop=ALL',
                  '--security-opt=no-new-privileges', '--security-opt=seccomp=unconfined',
                  '--cpus=1', '--memory=512m', '--memory-swap=512m',
                  '--pids-limit=64', '--ulimit=core=0', '--pull=never', image_id]
        return result + (['busy'] if busy else [])
    for repeat in range(2):
        busy_name = tag + '-busy-' + str(repeat)
        healthy_name = tag + '-healthy-' + str(repeat)
        created = []
        ready = threading.Event()
        observed = {}
        busy_diagnostics = {}
        stopped = {}
        abort = threading.Event()
        active_role = 'busy'
        guard = None
        pool = ThreadPoolExecutor(max_workers=1)
        def cancel_busy():
            abort.set()
            if guard is not None:
                try: guard.close()
                except (OSError, RuntimeError, subprocess.TimeoutExpired): return False
            return True
        def observe(name,inventory):
            nonlocal guard
            evidence = observe_worker(name, tag, inventory)
            if (type(evidence) is not dict or evidence.get('configuration_verified') is not True
                    or not accept_threads(evidence.get('host_threads'))):
                raise RuntimeError('lifecycle worker configuration or restrictions unverified')
            observed[name] = evidence
            if name == busy_name:
                configuration = evidence.get('configuration', {})
                guard = (deadline_factory or HostDeadlineGuard)(
                    configuration.get('container_id'), configuration.get('host_init_pid'), started+timeout)
            return evidence.get('descriptor_audit')
        def dispatch(request):
            response = fixture_dispatch(request)
            return response
        def progress(stderr):
            if b'[compat-lifecycle] cpu-loop' in stderr:
                if busy_name not in observed:
                    raise RuntimeError('CPU loop observed before worker restriction audit')
                if not ready.is_set():
                    stopped['cpu_loop_entered_ms'] = round(1000*(time.monotonic()-started))
                ready.set()
        def busy_run():
            return run_container(args(busy_name, True), dispatch=dispatch,
                                 timeout=timeout, startup_audit=lambda inventory: observe(busy_name,inventory),
                                 environment=environment, diagnostics=busy_diagnostics, on_stderr=progress, cancel_event=abort)
        try:
            created.append(busy_name)
            started = time.monotonic()
            future = pool.submit(busy_run)
            while not ready.wait(min(.05, max(0, started+timeout-time.monotonic()))):
                # A rejected startup must fail promptly, rather than spending
                # the entire operation budget waiting for a CPU-loop marker.
                if future.done():
                    future.result()
                    raise RuntimeError('busy worker did not enter restricted CPU loop')
                if time.monotonic() >= started+timeout:
                    future.result(timeout=6)
                    raise RuntimeError('busy worker did not enter restricted CPU loop')
            if inspect(busy_name).get('Running') is not True:
                raise RuntimeError('busy worker ended before healthy execution')
            created.append(healthy_name)
            remaining = timeout - (time.monotonic()-started)
            if remaining <= 0:
                raise RuntimeError('deadline consumed before healthy worker start')
            healthy_started_ms = round(1000*(time.monotonic()-started))
            def completed_healthy(frame,remaining_budget):
                if ('host_threads' in frame or 'cleanup_complete' in frame
                        or not accept(dict(frame,host_threads=observed[healthy_name]['host_threads'],cleanup_complete=True),architecture)
                        or frame.get('host_canary_absent') is not True):
                    raise RuntimeError('healthy completed evidence invalid')
                return {'completed':True,'exit_code':0}
            def start_healthy_waiter(remaining_budget):
                return OwnedWaiter(observed[healthy_name]['configuration']['container_id'],
                                   timeout=remaining_budget,docker=docker)
            def prepare_healthy_observer(remaining_budget):
                return ContainerdObserver(containerd_control['ctr'],containerd_control['address'],
                                          containerd_control['namespace'],remaining_budget)
            def bind_healthy_observer(observer,remaining_budget):
                configuration = observed[healthy_name]['configuration']
                return observer.bind(configuration['container_id'],configuration['host_init_pid'],remaining_budget)
            def stalled_healthy_startup(remaining_budget):
                left=started+timeout-time.monotonic()
                if (not ready.is_set() or busy_name not in observed or guard is None
                        or abort.is_set() or getattr(guard,'closed',False) or left<=0):
                    return {'outcome':'busy-worker-inactive'}
                # Inspecting this container may block behind the startup path
                # being diagnosed. Capture the eligible daemon first; no
                # unaudited healthy PID is supplied to a privileged helper.
                guard_process=getattr(guard,'process',None)
                if guard_process is not None and guard_process.poll() is not None:
                    return {'outcome':'busy-worker-inactive'}
                return capture_daemon_trace(min(remaining_budget,left))
            active_role = 'healthy'
            healthy_diagnostics = {}
            try:
                healthy = json.loads(run_container(args(healthy_name), timeout=remaining,
                    startup_audit=lambda inventory: observe(healthy_name,inventory),
                    environment=environment,diagnostics=healthy_diagnostics,completion_observer=completed_healthy,completion_start=start_healthy_waiter if containerd_control is None else None,
                    completion_prepare=prepare_healthy_observer if containerd_control is not None else None,
                    completion_bind=bind_healthy_observer if containerd_control is not None else None,
                    completion_stall=capture_daemon_trace,startup_stall=stalled_healthy_startup))
            except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as failure:
                # Capture this actual worker before finally removes it. Do
                # not ask the outer driver to inspect the exited primary.
                failure.deadline_guard_cleanup_verified = cancel_busy()
                failure.worker_role = 'healthy'
                failure.worker_diagnostics = healthy_diagnostics
                try:
                    state = inspect(healthy_name)
                    failure.worker_state = safe_worker_state(state)
                except (OSError,ValueError,RuntimeError,subprocess.TimeoutExpired):
                    failure.worker_state = {'outcome':'unavailable'}
                raise
            healthy['host_threads'] = observed[healthy_name]['host_threads']
            healthy['cleanup_complete'] = True
            if not accept(healthy, architecture) or healthy.get('host_canary_absent') is not True:
                raise RuntimeError('healthy restricted worker failed evidence acceptance')
            if inspect(busy_name).get('Running') is not True:
                raise RuntimeError('busy worker ended before healthy worker completed')
            active_role = 'busy'
            if guard is None:
                raise RuntimeError('worker deadline guard was not armed')
            termination = guard.completion()
            stopped['kill_requested_ms'] = round(timeout*1000) + termination['kill_lateness_ms']
            stopped['physical_exit_ms'] = round(timeout*1000) + termination['physical_exit_lateness_ms']
            # Physical termination is already proved by the retained pidfd.
            # Docker's eventual exit status and resource retirement remain
            # mandatory independent checks, never the deadline oracle.
            command(['wait', observed[busy_name]['configuration']['container_id']])
            state = inspect(busy_name)
            if (state.get('Running') is not False or type(state.get('ExitCode')) is not int
                    or state['ExitCode'] != 137 or type(state.get('FinishedAt')) is not str
                    or not state['FinishedAt'] or state['FinishedAt'].startswith('0001-')):
                raise RuntimeError('daemon worker termination unconfirmed')
            stopped['terminated_exit'] = state['ExitCode']
            stopped['stop_confirmed_ms'] = round(1000*(time.monotonic()-started))
            try:
                future.result(timeout=6)
            except subprocess.TimeoutExpired:
                pass  # CLI may reach its own same deadline first.
            except RuntimeError as error:
                if not str(error).startswith('worker exited 137:'):
                    raise
            else:
                raise RuntimeError('CPU-bound worker completed before deadline')
            protocol_completed_ms = round(1000*(time.monotonic()-started))
            if (busy_diagnostics.get('protocol_phase') != 'waiting-worker-completion'
                    or '[compat-lifecycle] cpu-loop' not in busy_diagnostics.get('stderr', '')):
                raise RuntimeError('busy worker failed before application execution')
            repeats.append({'healthy_completed_while_busy_running':True,
                            'deadline_seconds':timeout,
                            'cpu_loop_entered_ms':stopped['cpu_loop_entered_ms'],
                            'healthy_started_ms':healthy_started_ms, 'terminated_exit':stopped['terminated_exit'],
                            'kill_requested_ms':stopped['kill_requested_ms'],
                            'stop_confirmed_ms':stopped['stop_confirmed_ms'],
                            'physical_exit_ms':stopped['physical_exit_ms'],
                            'termination':termination,
                            'protocol_completed_ms':protocol_completed_ms,
                            'busy_host_threads':observed[busy_name]['host_threads'],
                            'healthy_host_threads':observed[healthy_name]['host_threads'],
                            'configuration_verified':True,
                            'healthy_completion':healthy_diagnostics.get('daemon_completion'),
                            'healthy_waiter_cleanup_verified':healthy_diagnostics.get('waiter_cleanup_verified')})
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as failure:
            retired = cancel_busy()
            failure.deadline_guard_cleanup_verified = retired and getattr(failure,'deadline_guard_cleanup_verified',True) is True
            if not hasattr(failure,'worker_role'):
                failure.worker_role = active_role
                failure.worker_diagnostics = healthy_diagnostics if active_role == 'healthy' else busy_diagnostics
                name = healthy_name if active_role == 'healthy' else busy_name
                try:
                    state = inspect(name)
                    failure.worker_state = safe_worker_state(state)
                except (OSError,ValueError,RuntimeError,subprocess.TimeoutExpired):
                    failure.worker_state = {'outcome':'unavailable'}
            raise
        finally:
            original = sys.exception()
            guard_cleanup_verified = cancel_busy()
            pool.shutdown(wait=True, cancel_futures=True)
            cleanup = []
            for name in reversed(created):
                # Attempt every owned resource even if another cleanup fails.
                # Unknown ownership is deliberately not treated as absence.
                outcome = 'inspection-unverified'
                try:
                    inspect(name)
                    outcome = 'removal-unverified'
                    command(['rm', '-f', name])
                    outcome = 'removed'
                except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
                    pass
                cleanup.append({'worker_role':'healthy' if name == healthy_name else 'busy',
                                'outcome':outcome})
            verified = guard_cleanup_verified and getattr(original,'deadline_guard_cleanup_verified',True) is True and all(item['outcome'] == 'removed' for item in cleanup)
            if original is not None:
                original.lifecycle_cleanup = cleanup
                original.lifecycle_cleanup_verified = verified
                original.deadline_guard_cleanup_verified = guard_cleanup_verified and getattr(original,'deadline_guard_cleanup_verified',True) is True
            elif not verified:
                failure = RuntimeError('lifecycle owned worker cleanup incomplete')
                failure.lifecycle_cleanup = cleanup
                failure.lifecycle_cleanup_verified = False
                raise failure
    return {'passed':True, 'repeats':repeats}

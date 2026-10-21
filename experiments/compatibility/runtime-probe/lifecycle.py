"""Deadline proof across Docker CLI and owned daemon worker boundaries."""
from concurrent.futures import ThreadPoolExecutor
import json
import math
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
from engine_state import EngineStateUnverified

OWNER_LABEL = 'fleur.compatibility.runtime-owner'
PREPARATION_BUDGET_SECONDS = 20
# Reuse the former sequential wait(5s) + inspect(5s) host budget.
RETIREMENT_CONFIRMATION_BUDGET_SECONDS = 10


def safe_worker_state(state):
    if (type(state) is dict and type(state.get('Running')) is bool
            and type(state.get('ExitCode')) is int and 0 <= state['ExitCode'] <= 255
            and type(state.get('FinishedAt')) is str
            and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z',state['FinishedAt'])):
        return {key:state[key] for key in ('Running','ExitCode','FinishedAt')}
    return {'outcome':'output-invalid'}


def run_lifecycle(image_id, tag, architecture, environment, observe_worker,
                  timeout=30, docker='docker', containerd_control=None, deadline_factory=None, create_worker=None, aggregate_preparation_budget=False, inspect_worker_state=None, broker_ack_delay=0, host_binding=None):
    def trace(remaining):
        return capture_daemon_trace(remaining,host_binding=host_binding) if host_binding is not None else capture_daemon_trace(remaining)
    if type(image_id) is not str or not re.fullmatch('sha256:[0-9a-f]{64}',image_id):
        raise ValueError('lifecycle immutable image invalid')
    if type(aggregate_preparation_budget) is not bool or (aggregate_preparation_budget and create_worker is None):
        raise ValueError('trusted preparation adapter required')
    if (type(broker_ack_delay) not in (int,float) or not math.isfinite(broker_ack_delay)
            or not 0<=broker_ack_delay<=11 or broker_ack_delay>=timeout):
        raise ValueError('bounded host broker pause invalid')
    repeats = []
    def command(args, deadline=None, maximum=5, phase='preparation'):
        allowance=maximum if deadline is None else min(maximum,deadline-time.monotonic())
        if allowance<=0: raise RuntimeError('lifecycle '+phase+' deadline expired')
        result = subprocess.run([docker, *args], env=environment,
                                capture_output=True, text=True, timeout=allowance)
        if result.returncode or len(result.stdout) > 65536:
            raise RuntimeError('owned lifecycle Docker command failed')
        if deadline is not None and time.monotonic()>=deadline:
            raise RuntimeError('lifecycle '+phase+' deadline expired')
        return result.stdout
    def checked_metadata(value,name,identifier=None):
        if type(value) is not dict: raise RuntimeError('lifecycle container identity mismatch')
        config=value.get('Config')
        labels=config.get('Labels') if type(config) is dict else None
        cid=value.get('Id')
        if (type(labels) is not dict or labels.get(OWNER_LABEL)!=tag
                or value.get('Name')!='/'+name or value.get('Image')!=image_id
                or type(cid) is not str or not re.fullmatch('[0-9a-f]{64}',cid)
                or identifier is not None and cid!=identifier
                or type(value.get('State')) is not dict):
            raise RuntimeError('lifecycle container identity mismatch')
        return value
    def metadata(name, identifier=None, deadline=None, maximum=5, phase='preparation'):
        value = json.loads(command(['inspect', identifier or name, '--format', '{{json .}}'],deadline,maximum,phase))
        return checked_metadata(value,name,identifier)
    def inspect(name):
        return metadata(name,prepared.get(name))['State']
    def create_args(name, busy=False):
        result = ['create', '-i', '--name', name, '--label', OWNER_LABEL+'='+tag,
                  '--network=none', '--read-only', '--cap-drop=ALL',
                  '--security-opt=no-new-privileges', '--security-opt=seccomp=unconfined',
                  '--cpus=1', '--memory=512m', '--memory-swap=512m',
                  '--pids-limit=64', '--ulimit=core=0', '--pull=never', image_id]
        return result + (['busy'] if busy else [])
    def start_args(name):
        return [docker,'start','-a','-i',prepared[name]]
    for repeat in range(2):
        busy_name = tag + '-busy-' + str(repeat)
        healthy_name = tag + '-healthy-' + str(repeat)
        created = []
        prepared = {}
        preparation={'budget_seconds':PREPARATION_BUDGET_SECONDS,'duration_ms':0,
                     'stopped_workers_verified':0,'passed':False}
        ready = threading.Event()
        observed = {}
        busy_diagnostics = {'preparation':preparation}
        healthy_diagnostics = {'preparation':preparation}
        pause={'requested_ms':round(broker_ack_delay*1000),'duration_ms':0,
               'after_restriction_audit':False,'registered_request_verified':False,'completed':False}
        busy_diagnostics['broker_ack_pause']=pause
        healthy_diagnostics['broker_ack_pause']=pause
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
            configuration=evidence.get('configuration')
            if type(configuration) is not dict or configuration.get('container_id')!=prepared.get(name):
                raise RuntimeError('prepared worker identity changed before application approval')
            observed[name] = evidence
            if name == busy_name:
                guard = (deadline_factory or HostDeadlineGuard)(
                    configuration.get('container_id'), configuration.get('host_init_pid'), started+timeout,**({'host_binding':host_binding} if host_binding is not None else {}))
            return evidence.get('descriptor_audit')
        def dispatch(request):
            response = fixture_dispatch(request)
            if busy_name not in observed or guard is None:
                raise RuntimeError('broker pause before worker restriction audit')
            pause['after_restriction_audit']=True
            pause['registered_request_verified']=True
            pause_started=time.monotonic()
            remaining=started+timeout-pause_started
            if remaining<=broker_ack_delay:
                raise RuntimeError('broker pause consumes remaining operation deadline')
            try:
                if abort.wait(broker_ack_delay):
                    raise RuntimeError('broker pause cancelled before acknowledgment')
                if time.monotonic()>=started+timeout:
                    raise RuntimeError('broker pause exceeded operation deadline')
                pause['completed']=True
            finally:
                pause['duration_ms']=round(1000*(time.monotonic()-pause_started))
            return response
        def progress(stderr):
            if b'[compat-lifecycle] cpu-loop' in stderr:
                if busy_name not in observed:
                    raise RuntimeError('CPU loop observed before worker restriction audit')
                heap_at=stderr.find(b'[compat-gc] retained-values-verified')
                if heap_at<0 or heap_at>stderr.find(b'[compat-lifecycle] cpu-loop'):
                    raise RuntimeError('CPU loop observed before retained heap verification')
                post_broker_heap_at=stderr.find(b'[compat-gc] post-broker-retained-values-verified')
                if (post_broker_heap_at<0 or post_broker_heap_at<heap_at
                        or post_broker_heap_at>stderr.find(b'[compat-lifecycle] cpu-loop')):
                    raise RuntimeError('CPU loop observed before post-broker retained heap verification')
                if pause['completed'] is not True:
                    raise RuntimeError('CPU loop observed before registered broker acknowledgment')
                if broker_ack_delay>10 and pause['duration_ms']<=10000:
                    raise RuntimeError('idle broker pause did not exceed ten seconds')
                stopped['retained_heap_verified_before_cpu_loop']=True
                if not ready.is_set():
                    stopped['cpu_loop_entered_ms'] = round(1000*(time.monotonic()-started))
                ready.set()
        def busy_run():
            return run_container(start_args(busy_name), dispatch=dispatch,
                                 timeout=timeout, startup_audit=lambda inventory: observe(busy_name,inventory),
                                 environment=environment, diagnostics=busy_diagnostics, on_stderr=progress, cancel_event=abort)
        try:
            preparation_started=time.monotonic()
            preparation_deadline=preparation_started+PREPARATION_BUDGET_SECONDS
            try:
                # Storage preparation creates no worker process. Complete both
                # cold writable layers before starting the timed CPU workload.
                for name,busy in ((busy_name,True),(healthy_name,False)):
                    active_role='busy' if busy else 'healthy'
                    created.append(name)
                    if create_worker is None:
                        identifier=command(create_args(name,busy),preparation_deadline).strip()
                    else:
                        # Trusted owned-host adapter only (the isolated VFS
                        # experiment); never an application-provided callback.
                        create_deadline=preparation_deadline if aggregate_preparation_budget else min(preparation_deadline,time.monotonic()+5)
                        remaining_create=create_deadline-time.monotonic()
                        if remaining_create<=0: raise RuntimeError('lifecycle preparation deadline expired')
                        identifier=create_worker(name,busy,remaining_create)
                        if time.monotonic()>=create_deadline:
                            raise RuntimeError('lifecycle preparation deadline expired')
                    if type(identifier) is not str or not re.fullmatch('[0-9a-f]{64}',identifier):
                        raise RuntimeError('prepared worker identity invalid')
                    state=metadata(name,identifier,preparation_deadline)['State']
                    if (state.get('Status')!='created' or state.get('Running') is not False
                            or type(state.get('Pid')) is not int or state['Pid']!=0):
                        raise RuntimeError('prepared worker already started')
                    prepared[name]=identifier
                    preparation['stopped_workers_verified']+=1
                if time.monotonic()>=preparation_deadline:
                    raise RuntimeError('lifecycle preparation deadline expired')
                preparation['passed']=True
            finally:
                preparation['duration_ms']=round(1000*(time.monotonic()-preparation_started))
            active_role='busy'
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
                                          containerd_control['namespace'],remaining_budget,**({'host_binding':host_binding} if host_binding is not None else {}))
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
                return trace(min(remaining_budget,left))
            active_role = 'healthy'
            try:
                healthy = json.loads(run_container(start_args(healthy_name), timeout=remaining,
                    startup_audit=lambda inventory: observe(healthy_name,inventory),
                    environment=environment,diagnostics=healthy_diagnostics,completion_observer=completed_healthy,completion_start=start_healthy_waiter if containerd_control is None else None,
                    completion_prepare=prepare_healthy_observer if containerd_control is not None else None,
                    completion_bind=bind_healthy_observer if containerd_control is not None else None,
                    completion_stall=trace,startup_stall=stalled_healthy_startup))
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
            busy_diagnostics['healthy_completed_while_busy_running']=True
            busy_diagnostics['healthy_completion']=healthy_diagnostics.get('daemon_completion')
            busy_diagnostics['healthy_waiter_cleanup_verified']=healthy_diagnostics.get('waiter_cleanup_verified')
            active_role = 'busy'
            if guard is None:
                raise RuntimeError('worker deadline guard was not armed')
            termination = guard.completion()
            busy_diagnostics['termination']=dict(termination)
            stopped['kill_requested_ms'] = round(timeout*1000) + termination['kill_lateness_ms']
            stopped['physical_exit_ms'] = round(timeout*1000) + termination['physical_exit_lateness_ms']
            # Physical termination is already proved by the retained pidfd.
            # Docker's eventual exit status and resource retirement remain
            # mandatory independent checks, never the deadline oracle.
            # Docker wait contributes no additional accepted proof: its output
            # was discarded and Docker's not-running wait takes the same state
            # lock as inspect. Spend the existing aggregate host budget on the
            # required immutable owned state itself, once, without retries.
            confirmation_started=time.monotonic()
            confirmation_deadline=confirmation_started+RETIREMENT_CONFIRMATION_BUDGET_SECONDS
            confirmation={'budget_seconds':RETIREMENT_CONFIRMATION_BUDGET_SECONDS,
                          'duration_ms':0,'passed':False}
            busy_diagnostics['retirement_confirmation']=confirmation
            try:
                if inspect_worker_state is None:
                    state=metadata(busy_name,prepared[busy_name],confirmation_deadline,
                                   RETIREMENT_CONFIRMATION_BUDGET_SECONDS,'retirement confirmation')['State']
                    confirmation['source']='docker-cli-inspect'
                else:
                    remaining_confirmation=confirmation_deadline-time.monotonic()
                    if remaining_confirmation<=0:
                        raise RuntimeError('lifecycle retirement confirmation deadline expired')
                    try:
                        value,transport=inspect_worker_state(prepared[busy_name],remaining_confirmation)
                        confirmation['transport']=transport
                    except EngineStateUnverified as error:
                        confirmation['transport']=dict(error.observations)
                        raise
                    state=checked_metadata(value,busy_name,prepared[busy_name])['State']
                    confirmation['source']='verified-default-engine-unix-api'
                safe=safe_worker_state(state)
                if (safe.get('Running') is not False or safe.get('ExitCode')!=137
                        or safe.get('FinishedAt','0001-').startswith('0001-')):
                    raise RuntimeError('daemon worker termination unconfirmed')
                if time.monotonic()>=confirmation_deadline:
                    raise RuntimeError('lifecycle retirement confirmation deadline expired')
                confirmation['passed']=True
            finally:
                confirmation['duration_ms']=round(1000*(time.monotonic()-confirmation_started))
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
            repeats.append({'preparation':dict(preparation),
                            'broker_ack_pause':dict(pause),
                            'retained_heap_verified_before_cpu_loop':stopped['retained_heap_verified_before_cpu_loop'],
                            'retirement_confirmation':dict(confirmation),
                            'healthy_completed_while_busy_running':True,
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
                    owned=metadata(name,prepared.get(name))
                    outcome = 'removal-unverified'
                    command(['rm', '-f', owned['Id']])
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

"""Trusted controller for one retained execution slot.

The slot owns one application container whose init is an idle trusted process
and one guard host container. Every operation runs in a fresh audited
application process; at most one exists at a time. Application processes
never receive this channel, the Docker socket or the guard. Any uncertain
ownership, admission, retirement or cleanup quarantines the whole slot.
"""
import collections
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from configuration import audit_configuration, OWNER_LABEL
from controller import frame, send, command, owned_remove, MAX
from descriptor_audit import inspect_event_inventory
from docker_api import DockerError, call, inspect_container, inspect_exec, require, run_exec, start_exec
from threads import inspect_threads

EXECUTION_LABEL = 'dev.fleur.execution-owner'
ADMISSION_WINDOW = 30
APPLICATION_USER = '65534:65534'
APPLICATION_PROCESS = {'tty': False, 'entrypoint': 'bun', 'arguments': ['/probe/bootstrap.js'], 'privileged': False, 'user': APPLICATION_USER}
FAILURES = (RuntimeError, ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError)


class Quarantine(RuntimeError):
    """Uncertain state: no further admission in this slot."""


class ArmingExpired(RuntimeError):
    """The run's deadline expired before its guard reported it armed."""


def create(arguments):
    # Docker may print host capability warnings; identity comes from the audit.
    result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=False)
    if result.returncode or not re.fullmatch(rb'[a-f0-9]{64}\n?', result.stdout):
        raise Quarantine('CREATION_UNCONFIRMED')


def milliseconds(start):
    return max(0, round(1000*(time.monotonic()-start)))


def stream_frame(stream, deadline):
    size = struct.unpack('!I', stream.read_exact(4, deadline))[0]
    if not 0 < size <= MAX:
        raise RuntimeError('FRAME_BOUND')
    return json.loads(stream.read_exact(size, deadline))


def audit_guard_host(metadata, name, owner, image, environment):
    config, host = metadata['Config'], metadata['HostConfig']
    if (metadata['Name'] != '/'+name or metadata['Image'] != image or metadata['Mounts'] != []
            or config['Image'] != image or config['User'] != '0:0' or config['Labels'].get(OWNER_LABEL) != owner
            or config['Labels'].get(EXECUTION_LABEL) != owner
            or config['Entrypoint'] != ['/bin/sleep'] or config['Cmd'] != ['infinity'] or config['Env'] != environment
            or config.get('Volumes') not in (None, {}) or host['Privileged'] is not False or host['ReadonlyRootfs'] is not True
            or host['CapDrop'] != ['ALL'] or sorted(cap.removeprefix('CAP_') for cap in host['CapAdd'] or []) != ['KILL', 'SYS_PTRACE']
            or sorted(host['SecurityOpt'] or []) not in (['no-new-privileges'], ['label=disable', 'no-new-privileges']) or host['NetworkMode'] != 'none'
            or host['PidMode'] != 'host' or host['CgroupnsMode'] != 'host'
            # Trusted guard overhead has its own explicit ceilings.
            or host.get('NanoCpus') != 1000000000 or host.get('Memory') != 268435456
            or host.get('MemorySwap') != 268435456 or host.get('PidsLimit') != 32
            or any(host.get(key) not in (None, []) for key in ('Binds', 'Mounts', 'Devices', 'DeviceRequests', 'VolumesFrom'))
            or host['RestartPolicy']['Name'] != 'no' or metadata['State']['Running'] is not True
            or not re.fullmatch(r'[a-f0-9]{64}', metadata['Id'])):
        raise Quarantine('GUARD_PROFILE_REJECTED')
    return metadata['Id']


def require_retirement(record, operation, start, outcomes):
    if (type(record) is not dict or record.get('kind') != 'result' or record.get('operation') != operation or record.get('start') != start
            or record.get('physical_exit_confirmed') is not True or record.get('retired') is not True or record.get('outcome') not in outcomes
            or any(type(record.get(key)) is not int or not 0 <= record[key] <= 250 for key in ('kill_lateness_ms', 'physical_exit_lateness_ms'))):
        raise Quarantine('TERMINATION_UNCONFIRMED')
    return record


class Slot:
    def __init__(self, worker_image, controller_image, owner):
        self.worker_image, self.controller_image, self.owner = worker_image, controller_image, owner
        self.worker_name, self.guard_name = 'fleur-exec-'+owner+'-worker', 'fleur-exec-'+owner+'-guard'
        self.worker = self.guard = self.init = None
        self.boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        self.prepared = None
        self.environment = None
        # Recently failed operations: a host decision that crossed the
        # failure report is dropped, never applied to another operation.
        self.retired = collections.deque(maxlen=16)

    def runner(self, deadline):
        return lambda arguments: run_exec(self.worker, arguments, APPLICATION_USER, max(.001, min(5, deadline-time.monotonic())))

    def create(self):
        labels = ['--label', OWNER_LABEL+'='+self.owner, '--label', EXECUTION_LABEL+'='+self.owner]
        create(['docker', 'run', '--detach', '--name', self.worker_name, *labels,
                 '--network=none', '--read-only', '--ipc=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                 '--security-opt=seccomp=unconfined', '--cpus=1', '--memory=512m', '--memory-swap=512m',
                 '--pids-limit=64', '--ulimit=core=0', '--pull=never', '--entrypoint=/bin/sleep', self.worker_image, 'infinity'])
        create(['docker', 'run', '--detach', '--name', self.guard_name, *labels,
                 '--network=none', '--pid=host', '--cgroupns=host', '--read-only', '--cap-drop=ALL', '--user=0:0',
                 '--cap-add=SYS_PTRACE', '--cap-add=KILL', '--security-opt=no-new-privileges', '--pull=never',
                 '--cpus=1', '--memory=256m', '--memory-swap=256m', '--pids-limit=32',
                 '--entrypoint=/bin/sleep', self.controller_image, 'infinity'])
        self.environment = require(*call('GET', '/images/'+self.controller_image+'/json'))['Config']['Env']
        self.verify()
        return {'worker': self.worker, 'init': self.init, 'guard': self.guard, 'boot': self.boot}

    def verify(self):
        """Re-audit both retained containers before each application process."""
        audited = audit_configuration(inspect_container(self.worker_name), self.owner, self.worker_name, self.worker_image, retained=True)
        if self.worker is not None and (audited['container_id'] != self.worker or audited['host_init_pid'] != self.init):
            raise Quarantine('WORKER_IDENTITY_CHANGED')
        guard = audit_guard_host(inspect_container(self.guard_name), self.guard_name, self.owner, self.controller_image, self.environment)
        if self.guard is not None and guard != self.guard:
            raise Quarantine('GUARD_IDENTITY_CHANGED')
        self.worker, self.init, self.guard = audited['container_id'], audited['host_init_pid'], guard

    def prepare(self, operation):
        if self.prepared is not None:
            raise Quarantine('SLOT_BUSY')
        started = time.monotonic()
        deadline = started+ADMISSION_WINDOW
        self.verify()
        exec_id, stream = start_exec(self.worker, ['bun', '/probe/bootstrap.js'], APPLICATION_USER)
        # Ownership exists from exec creation; failures below quarantine the slot.
        self.prepared = {'operation': operation, 'exec': exec_id, 'stream': stream, 'started': started}
        audit = json.loads(stream.line(16384, deadline))
        if type(audit) is not dict or set(audit) != {'kind', 'inventory', 'pid'} or audit['kind'] != 'startup-audit' or type(audit['pid']) is not int:
            raise Quarantine('STARTUP_REJECTED')
        info = inspect_exec(exec_id)
        pid, namespace_pid = info.get('Pid'), audit['pid']
        if (info.get('ContainerID') != self.worker or info.get('Running') is not True or info.get('ProcessConfig') != APPLICATION_PROCESS
                or type(pid) is not int or pid <= 1 or pid == self.init or not 1 < namespace_pid <= 2**22):
            raise Quarantine('STARTUP_REJECTED')
        launched = milliseconds(started)
        audited = time.monotonic()
        rows = inspect_threads(self.worker, namespace_pid, self.runner(deadline))
        if not 2 <= len(rows) <= 64 or not any(row['pid'] == namespace_pid for row in rows) or any(
                row['no_new_privs'] != 1 or row['seccomp'] != 2 or row['seccomp_filters'] != 1 for row in rows):
            raise Quarantine('STARTUP_REJECTED')
        descriptors = inspect_event_inventory(self.worker, audit['inventory'], namespace_pid, self.runner(deadline))
        if descriptors.get('passed') is not True or descriptors.get('category') != 'verified' or descriptors.get('descriptor_count') != len(audit['inventory']):
            raise Quarantine('STARTUP_REJECTED')
        self.prepared.update(pid=pid, namespace=namespace_pid)
        return {'kind': 'prepared', 'operation': operation, 'process': {'pid': pid, 'namespacePid': namespace_pid},
                'timings': {'launch': launched, 'audit': milliseconds(audited)}}

    def arm(self, operation, deadline):
        prepared = self.prepared
        arguments = [self.worker, str(prepared['pid']), str(prepared['namespace']), str(self.init), repr(deadline), self.boot, operation]
        # Starting the guard is trusted overhead with its own bound: a guard
        # that starts after the deadline still retires the unadmitted process.
        exec_id, stream = start_exec(self.guard, ['/usr/bin/python3', '-I', '-u', '/controller/retained_guard.py', *arguments], '0:0',
                                     timeout=max(.001, deadline+ARMING_GRACE-time.monotonic()), stderr_limit=4096)
        prepared.update(guard_exec=exec_id, guard_stream=stream)
        try:
            armed = json.loads(stream.line(1024, deadline))
        except FAILURES:
            if time.monotonic() < deadline:
                raise
            raise ArmingExpired() from None
        if type(armed) is not dict or set(armed) != {'kind', 'operation', 'start'} or armed['kind'] != 'armed' or armed['operation'] != operation or type(armed['start']) is not str:
            if time.monotonic() >= deadline and type(armed) is dict and armed.get('kind') == 'result':
                raise ArmingExpired(armed)
            raise Quarantine('GUARD_UNCONFIRMED')
        info = inspect_exec(exec_id)
        if (info.get('ContainerID') != self.guard or info.get('Running') is not True or info.get('ProcessConfig') != {
                'tty': False, 'entrypoint': '/usr/bin/python3', 'arguments': ['-I', '-u', '/controller/retained_guard.py', *arguments],
                'privileged': False, 'user': '0:0'}):
            raise Quarantine('GUARD_PROFILE_REJECTED')
        prepared['start'] = armed['start']
        return {'operation': operation, 'worker': self.worker, 'init': self.init, 'pid': prepared['pid'], 'namespacePid': prepared['namespace'],
                'start': armed['start'], 'guard': self.guard, 'guardExec': exec_id, 'deadline': deadline, 'boot': self.boot}

    def retire(self, outcomes, end, completed=False, record=None):
        """Wait for the bound guard's record and the exact process exits."""
        prepared = self.prepared
        stream = prepared['guard_stream']
        try:
            if record is None:
                record = json.loads(stream.line(1024, end))
        except FAILURES:
            raise Quarantine('TERMINATION_UNCONFIRMED') from None
        require_retirement(record, prepared['operation'], prepared['start'], outcomes)
        for exec_id, success in ((prepared['exec'], completed), (prepared['guard_exec'], True)):
            limit = time.monotonic()+1
            while (info := inspect_exec(exec_id)).get('Running') is not False:
                if time.monotonic() >= limit:
                    raise Quarantine('TERMINATION_UNCONFIRMED')
                time.sleep(.005)
            if success and info.get('ExitCode') != 0:
                raise Quarantine('PROCESS_EXIT_UNCONFIRMED')
        prepared['stream'].close(); stream.close()
        self.prepared = None
        return record

    def expire(self, record, deadline):
        """Arming outlived the budget: the guard retires the never-admitted process."""
        prepared = self.prepared
        end = deadline+ARMING_GRACE
        try:
            if record is None:
                record = json.loads(prepared['guard_stream'].line(1024, end))
            if type(record) is dict and set(record) == {'kind', 'operation', 'start'} and record['kind'] == 'armed' and record['operation'] == prepared['operation']:
                # Armed just as the deadline passed: it kills at that deadline.
                prepared['start'] = record['start']
                record = None
            elif type(record) is dict and type(record.get('start')) is str and re.fullmatch(r'[0-9]{1,20}', record['start']):
                # The guard verified this start identity when it bound the process.
                prepared['start'] = record['start']
            else:
                raise Quarantine('TERMINATION_UNCONFIRMED')
        except FAILURES:
            raise Quarantine('TERMINATION_UNCONFIRMED') from None
        return self.retire(('unadmitted', 'deadline', 'cancelled', 'premature-exit'), end, record=record)

    def cancel(self, deadline):
        """Cancel this slot's own process through its bound guard."""
        prepared = self.prepared
        if 'guard_stream' not in prepared:
            self.arm(prepared['operation'], deadline)
        prepared['guard_stream'].close_stdin()
        return self.retire(('cancelled', 'deadline', 'premature-exit'), deadline+3*TOLERANCE)

    def run(self, request, host_in, host_out):
        prepared = self.prepared
        if (prepared is None or type(request) is not dict or set(request) != {'kind', 'operation', 'budgetMs', 'command'}
                or request['operation'] != prepared['operation'] or 'pid' not in prepared or type(request['budgetMs']) is not int
                or not 0 < request['budgetMs'] <= 5000):
            raise Quarantine('REQUEST_DENIED')
        if time.monotonic()-prepared['started'] >= ADMISSION_WINDOW:
            raise Quarantine('ADMISSION_EXPIRED')
        started = time.monotonic()
        deadline = started+request['budgetMs']/1000
        operation = prepared['operation']
        try:
            binding = self.arm(operation, deadline)
        except ArmingExpired as expired:
            # Never admitted: the caller's timeout, not slot uncertainty.
            record = self.expire(expired.args[0] if expired.args else None, deadline)
            self.retired.append(operation)
            return {'kind': 'failure', 'operation': operation, 'code': 'QUERY_TIMEOUT', 'physicalExitConfirmed': True, 'deadline': record,
                    'timings': {'guard': milliseconds(started)}}
        armed = time.monotonic()
        send(host_out, {'kind': 'guard', 'value': binding})
        try:
            admitted = frame(host_in, deadline)
        except RuntimeError as error:
            if str(error) != 'QUERY_TIMEOUT':
                raise
            # The host's acknowledgement outlived the budget; the armed guard
            # kills the still-gated process at its deadline.
            record = self.retire(('deadline', 'cancelled', 'premature-exit'), deadline+3*TOLERANCE)
            self.retired.append(operation)
            return {'kind': 'failure', 'operation': operation, 'code': 'QUERY_TIMEOUT', 'physicalExitConfirmed': True, 'deadline': record,
                    'timings': {'guard': round(1000*(armed-started))}}
        if admitted != {'kind': 'admit', 'value': None, 'operation': operation}:
            raise Quarantine('GUARD_PARENT_ACK_REQUIRED')
        timings = {'guard': round(1000*(armed-started))}
        executing = time.monotonic()
        stream = prepared['stream']
        try:
            stream.write(b'startup:approved\n')
            send(stream, request['command'])
            sequence = 0
            while True:
                value = stream_frame(stream, deadline)
                # The host independently validates the complete application protocol.
                send(host_out, {'kind': 'worker', 'value': value})
                decision = frame(host_in, deadline)
                if (type(decision) is not dict or set(decision) != {'kind', 'value', 'operation'} or decision['operation'] != operation
                        or decision['kind'] not in ('reply', 'finish')):
                    raise RuntimeError('REQUEST_DENIED')
                if decision['kind'] == 'finish':
                    break
                sequence += 1
                if sequence > 500:
                    raise RuntimeError('QUERY_LIMIT')
                send(stream, decision['value'])
        except FAILURES:
            code = 'QUERY_TIMEOUT' if time.monotonic() >= deadline else 'INTERNAL_FAILURE'
            timings['execute'] = milliseconds(executing)
            retiring = time.monotonic()
            record = self.cancel(deadline)
            timings['retire'] = milliseconds(retiring)
            self.retired.append(operation)
            return {'kind': 'failure', 'operation': operation, 'code': code, 'physicalExitConfirmed': True, 'deadline': record, 'timings': timings}
        timings['execute'] = milliseconds(executing)
        retiring = time.monotonic()
        # Final bytes precede the process exit_group(0). Keep the independent
        # guard armed until its pidfd observes exit and only init remains.
        record = self.retire(('premature-exit',), deadline+3*TOLERANCE, completed=True)
        timings['retire'] = milliseconds(retiring)
        return {'kind': 'retired', 'operation': operation, 'physicalExitConfirmed': True, 'deadline': record, 'timings': timings}

    def discard(self, operation):
        if self.prepared is None or self.prepared['operation'] != operation:
            raise Quarantine('REQUEST_DENIED')
        return {'kind': 'discarded', 'operation': operation, 'deadline': self.cancel(time.monotonic()+2)}

    def close(self):
        """Verified removal. The worker goes first, so no process outlives its guard."""
        if self.prepared is not None and 'pid' in self.prepared:
            self.cancel(time.monotonic()+2)
        if self.prepared is not None:
            raise Quarantine('CLEANUP_UNCONFIRMED')
        self.remove()

    def remove(self):
        if self.prepared is not None:
            for key in ('stream', 'guard_stream'):
                if key in self.prepared:
                    self.prepared[key].close()
        found = command(['docker', 'ps', '--all', '--quiet', '--filter', 'name=^/'+self.worker_name+'$'])
        if found:
            owned_remove(self.worker_name, self.owner, self.worker_image)
        found = command(['docker', 'ps', '--all', '--quiet', '--filter', 'name=^/'+self.guard_name+'$'])
        if found:
            owned_remove(self.guard_name, self.owner, self.controller_image)


TOLERANCE = .25
# After a run's deadline, its guard has this long to report an unadmitted
# retirement; one completed within the tolerance is written well before then.
ARMING_GRACE = 3*TOLERANCE


def main():
    if len(sys.argv) != 4 or any(not re.fullmatch(r'sha256:[a-f0-9]{64}', value) for value in sys.argv[1:3]) or not re.fullmatch(r'[a-f0-9-]{36}', sys.argv[3]):
        raise RuntimeError('IMMUTABLE_IMAGES_REQUIRED')
    host_in, host_out = sys.stdin.buffer, sys.stdout.buffer
    slot = Slot(sys.argv[1], sys.argv[2], sys.argv[3])
    try:
        send(host_out, {'kind': 'ready', 'slot': slot.create()})
        while True:
            try:
                request = frame(host_in, time.monotonic()+10**9)
            except RuntimeError as error:
                if str(error) != 'TRANSPORT_EOF':
                    raise
                slot.close()
                send(host_out, {'kind': 'closed'})
                return
            if type(request) is not dict or type(request.get('operation')) is not str or not re.fullmatch(r'[a-f0-9-]{36}', request['operation']):
                raise Quarantine('REQUEST_DENIED')
            if (request.get('kind') in ('admit', 'reply', 'finish', 'cancel') and set(request) == {'kind', 'value', 'operation'}
                    and request['operation'] in slot.retired):
                continue
            if request.get('kind') == 'prepare' and set(request) == {'kind', 'operation'}:
                send(host_out, slot.prepare(request['operation']))
            elif request.get('kind') == 'run':
                send(host_out, slot.run(request, host_in, host_out))
            elif request.get('kind') == 'discard' and set(request) == {'kind', 'operation'}:
                send(host_out, slot.discard(request['operation']))
            else:
                raise Quarantine('REQUEST_DENIED')
    except (Quarantine, DockerError, *FAILURES) as error:
        # Removing the application container retires every process inside it.
        try:
            slot.remove()
            removed = True
        except FAILURES:
            removed = False
        code = str(error) if re.fullmatch(r'[A-Z_]{1,64}', str(error)) else 'INTERNAL_FAILURE'
        try:
            send(host_out, {'kind': 'quarantined', 'code': code, 'removed': removed})
        finally:
            raise SystemExit(1)


if __name__ == '__main__':
    main()

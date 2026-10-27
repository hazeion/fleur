"""One-shot deadline guard for one operation process in a retained container.

Arguments bind one immutable operation, container, init, boot, process and
deadline. No input can extend the deadline or select another target: any
control byte or EOF cancels this operation's process. Retirement requires the
pidfd exit plus a container cgroup containing only its idle init again.

The controller admits a process only after this guard reports it armed. If the
deadline expires before arming, the process is still waiting at its startup
gate: the guard retires it as unadmitted instead of failing.
"""
import json
import os
from pathlib import Path
import re
import select
import signal
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker_deadline import bind_owned_pidfd, supervise, TERMINATION_TOLERANCE

RECORD_LIMIT = 1024


def cgroup_directory(pid, container_id, proc=Path('/proc'), root=Path('/sys/fs/cgroup')):
    text = (proc/str(pid)/'cgroup').read_text()
    match = re.fullmatch(r'0::(/(?:[^\n:]*/)?(?:docker-'+container_id+r'\.scope|docker/'+container_id+r'))\n?', text)
    if len(text) > 4096 or match is None:
        raise RuntimeError('container identity unverified')
    return root/match[1].lstrip('/')


def members(directory):
    text = (directory/'cgroup.procs').read_text()
    if len(text) > 4096 or not re.fullmatch(r'(?:[1-9][0-9]*\n)*', text):
        raise RuntimeError('container membership unverified')
    return sorted(int(value) for value in text.split())


def identity(pid, proc=Path('/proc')):
    """Return (start time, innermost namespace pid) for one live process."""
    stat = (proc/str(pid)/'stat').read_text()
    if len(stat) > 4096 or not stat.startswith(str(pid)+' (') or ') ' not in stat:
        raise RuntimeError('process identity unverified')
    fields = stat.rsplit(') ', 1)[1].split()
    if len(fields) < 20 or fields[0] == 'Z' or not fields[19].isdigit():
        raise RuntimeError('process identity unverified')
    namespace = None
    for line in (proc/str(pid)/'status').read_text().splitlines():
        if line.startswith('NSpid:'):
            values = line.split()[1:]
            if values and all(value.isdigit() for value in values):
                namespace = int(values[-1])
    if namespace is None:
        raise RuntimeError('process identity unverified')
    return fields[19], namespace


def retired(directory, init_pid, end):
    """Only the idle init remains: no process or task survives the operation."""
    while True:
        try:
            if members(directory) == [init_pid] and (directory/'pids.current').read_text().strip() == '1':
                return True
        except (OSError, RuntimeError):
            return False
        if time.monotonic() >= end:
            return False
        time.sleep(.002)


def retire_unadmitted(container_id, pid, deadline, bind):
    """Retire a process whose deadline expired before this guard armed.

    Binding re-verifies its start identity; any failure stays uncertain.
    Lateness is measured from the operation deadline, like every retirement.
    """
    fd = bind(container_id, pid)
    try:
        requested = time.monotonic()
        signal.pidfd_send_signal(fd, signal.SIGKILL)
        bound = deadline+TERMINATION_TOLERANCE
        exited = bool(select.select([fd], [], [], max(0, bound-time.monotonic()))[0])
        stopped = time.monotonic()
    finally:
        os.close(fd)
    return {'kind': 'result', 'outcome': 'unadmitted' if exited and stopped <= bound else 'late-termination',
            'physical_exit_confirmed': exited, 'kill_lateness_ms': max(0, round(1000*(requested-deadline))),
            'physical_exit_lateness_ms': max(0, round(1000*(stopped-deadline)))}


def main():
    def write(record):
        data = json.dumps(record, separators=(',', ':')).encode()+b'\n'
        if len(data) > RECORD_LIMIT or os.write(1, data) != len(data):
            raise RuntimeError('guard output failed')
    try:
        if len(sys.argv) != 8 or os.geteuid() != 0:
            raise RuntimeError('guard arguments rejected')
        container_id, host_pid, namespace_pid, init_pid, deadline, boot, operation = sys.argv[1:]
        if (not re.fullmatch(r'[a-f0-9]{64}', container_id) or not re.fullmatch(r'[a-f0-9-]{36}', operation)
                or any(not re.fullmatch(r'[1-9][0-9]{0,9}', value) for value in (host_pid, namespace_pid, init_pid))
                or Path('/proc/sys/kernel/random/boot_id').read_text().strip() != boot):
            raise RuntimeError('guard arguments rejected')
        host_pid, namespace_pid, init_pid, deadline = int(host_pid), int(namespace_pid), int(init_pid), float(deadline)
        directory = cgroup_directory(init_pid, container_id)
        if host_pid == init_pid or namespace_pid == 1 or cgroup_directory(host_pid, container_id) != directory:
            raise RuntimeError('operation identity unverified')
        start, observed_namespace = identity(host_pid)
        # Exactly one operation process may exist beside init before arming.
        if observed_namespace != namespace_pid or members(directory) != sorted([init_pid, host_pid]):
            raise RuntimeError('operation identity unverified')
        def bind(container, pid):
            fd = bind_owned_pidfd(container, pid)
            try:
                if identity(pid)[0] != start:
                    raise RuntimeError('operation identity changed during binding')
            except BaseException:
                os.close(fd)
                raise
            return fd
        records, armed = [], []
        def emit(record):
            if record['kind'] == 'armed':
                armed.append(record)
                write(dict(record, operation=operation, start=start))
            else:
                records.append(record)
        try:
            supervise(container_id, host_pid, deadline, bind, lambda fd: signal.pidfd_send_signal(fd, signal.SIGKILL), os.close, 0, emit)
        except RuntimeError as error:
            # Only a deadline that expired before binding leaves the process
            # untouched at its startup gate; anything else stays uncertain.
            if armed or str(error) != 'worker deadline expired before binding':
                raise
            records.append(retire_unadmitted(container_id, host_pid, deadline, bind))
        if len(records) != 1:
            raise RuntimeError('guard result missing')
        record = records[0]
        clean = record.get('physical_exit_confirmed') is True and retired(directory, init_pid, time.monotonic()+TERMINATION_TOLERANCE)
        write(dict(record, operation=operation, start=start, retired=clean))
    except (OSError, ValueError, RuntimeError, AttributeError):
        try:
            write({'kind': 'error', 'category': 'deadline-guard-failed'})
        except (OSError, RuntimeError):
            pass
        sys.exit(1)


if __name__ == '__main__':
    main()

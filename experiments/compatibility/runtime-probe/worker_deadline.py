"""Host-owned Linux pidfd deadline enforcement, independent of Docker cleanup."""
import inspect
import json
import math
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import time

TERMINATION_TOLERANCE = .250


def bind_owned_pidfd(container_id, pid, proc=Path('/proc'), opener=None):
    """Bind only the audited container init, rejecting PID reuse during binding."""
    if (type(container_id) is not str or not re.fullmatch(r'[a-f0-9]{64}', container_id)
            or type(pid) is not int or pid <= 1):
        raise RuntimeError('worker identity unverified')
    def identity():
        directory = proc / str(pid)
        cgroups = (directory/'cgroup').read_text()
        # Native probe hosts require cgroup v2. Match a complete container
        # component, never a substring or a caller-provided arbitrary host PID.
        expected = r'0::/(?:[^\n:]*/)?(?:docker-'+container_id+r'\.scope|docker/'+container_id+r')\n?'
        if len(cgroups) > 4096 or not re.fullmatch(expected, cgroups):
            raise RuntimeError('worker identity unverified')
        stat = (directory/'stat').read_text()
        if len(stat) > 4096 or not stat.startswith(str(pid)+' (') or ') ' not in stat:
            raise RuntimeError('worker identity unverified')
        fields = stat.rsplit(') ', 1)[1].split()
        if len(fields) < 20 or fields[0] == 'Z' or not fields[19].isdigit():
            raise RuntimeError('worker identity unverified')
        return fields[19], cgroups
    before = identity()
    fd = (opener or os.pidfd_open)(pid, 0)
    try:
        if identity() != before or select.select([fd], [], [], 0)[0]:
            raise RuntimeError('worker identity changed during binding')
        return fd
    except BaseException:
        os.close(fd)
        raise


def supervise(container_id, pid, deadline, bind, kill, close, control_fd, emit):
    """Run a bound worker deadline; OS operations are the test boundary."""
    if type(deadline) not in (int, float) or not math.isfinite(deadline) or deadline <= time.monotonic():
        raise RuntimeError('worker deadline expired before binding')
    fd = bind(container_id, pid)
    killed = False
    try:
        if time.monotonic() >= deadline:
            raise RuntimeError('worker deadline expired while binding')
        emit({'kind':'armed'})
        ready = select.select([fd, control_fd], [], [], max(0, deadline-time.monotonic()))[0]
        if fd in ready:
            emit({'kind':'result','outcome':'premature-exit','physical_exit_confirmed':True,
                  'kill_lateness_ms':0,'physical_exit_lateness_ms':0})
            return
        cancelled = control_fd in ready
        if cancelled:
            # EOF or any control byte retires this already-bound worker. There
            # is no command that can select another process or extend its time.
            os.read(control_fd, 1)
        requested = time.monotonic()
        kill(fd)
        killed = True
        bound = (requested if cancelled else deadline) + TERMINATION_TOLERANCE
        exited = bool(select.select([fd], [], [], max(0, bound-time.monotonic()))[0])
        stopped = time.monotonic()
        outcome = 'cancelled' if cancelled else 'deadline'
        if not exited or stopped > bound: outcome = 'late-termination'
        emit({'kind':'result','outcome':outcome,'physical_exit_confirmed':exited,
              'kill_lateness_ms':max(0, round(1000*(requested-deadline))),
              'physical_exit_lateness_ms':max(0, round(1000*(stopped-deadline)))})
    finally:
        if not killed and not select.select([fd], [], [], 0)[0]:
            kill(fd)
        close(fd)


def root_main():
    import sys
    def emit(record):
        data = json.dumps(record, separators=(',', ':')).encode()+b'\n'
        if len(data) > 512 or os.write(1, data) != len(data):
            raise RuntimeError('deadline output failed')
    try:
        if os.geteuid() != 0: raise RuntimeError('root guard required')
        container_id, pid, deadline = sys.argv[1:]
        supervise(container_id, int(pid), float(deadline), bind_owned_pidfd,
                  lambda fd: signal.pidfd_send_signal(fd, signal.SIGKILL),
                  os.close, 0, emit)
    except (OSError, ValueError, RuntimeError, AttributeError):
        try: emit({'kind':'error','category':'deadline-guard-failed'})
        except (OSError, RuntimeError): pass
        sys.exit(1)


ROOT_GUARD = ('import json,math,os,re,select,signal,time\nfrom pathlib import Path\n'
              +'TERMINATION_TOLERANCE='+repr(TERMINATION_TOLERANCE)+'\n'
              +inspect.getsource(bind_owned_pidfd)+'\n'+inspect.getsource(supervise)+'\n'
              +inspect.getsource(root_main)+'\nroot_main()\n')


class HostDeadlineGuard:
    """Arm before application ACK; success requires observed kernel termination."""
    def __init__(self, container_id, pid, deadline, launcher=None):
        self.deadline = deadline
        self.process = None
        self.buffer = bytearray()
        self.result = None
        self.closed = False
        if (type(container_id) is not str or not re.fullmatch(r'[a-f0-9]{64}', container_id)
                or type(pid) is not int or pid <= 1 or type(deadline) not in (float, int)
                or not math.isfinite(deadline) or deadline <= time.monotonic()):
            raise RuntimeError('worker identity or deadline invalid')
        command = ['/usr/bin/sudo','-n','/usr/bin/python3','-I','-c',ROOT_GUARD,
                   container_id,str(pid),str(deadline)]
        try:
            self.process = (launcher or subprocess.Popen)(command, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            if self._read(min(deadline, time.monotonic()+2)) != {'kind':'armed'}:
                raise RuntimeError('worker deadline guard not armed')
        except BaseException as failure:
            try:
                self.close()
                failure.deadline_guard_cleanup_verified = True
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                failure.deadline_guard_cleanup_verified = False
            raise

    def _read(self, end):
        while b'\n' not in self.buffer:
            if len(self.buffer) > 1024:
                raise RuntimeError('worker deadline output exceeded bound')
            if not select.select([self.process.stdout], [], [], max(0,end-time.monotonic()))[0]:
                raise RuntimeError('worker deadline guard timed out')
            chunk = os.read(self.process.stdout.fileno(), 1024)
            if not chunk: raise RuntimeError('worker deadline guard ended without evidence')
            self.buffer.extend(chunk)
        line, _, rest = self.buffer.partition(b'\n')
        self.buffer = bytearray(rest)
        if len(line) > 512: raise RuntimeError('worker deadline output exceeded bound')
        try: return json.loads(line)
        except (ValueError, UnicodeError): raise RuntimeError('worker deadline output invalid') from None

    def completion(self):
        record = self._read(self.deadline + TERMINATION_TOLERANCE + .5)
        fields = {'kind','outcome','physical_exit_confirmed','kill_lateness_ms','physical_exit_lateness_ms'}
        if (type(record) is not dict or set(record) != fields or record['kind'] != 'result'
                or record['outcome'] != 'deadline' or record['physical_exit_confirmed'] is not True
                or any(type(record[key]) is not int or not 0 <= record[key] <= 250
                       for key in ('kill_lateness_ms','physical_exit_lateness_ms'))):
            raise RuntimeError('worker termination missed deadline or was unverified')
        self.result = record
        self.close()
        return dict(record, source='linux-pidfd', guard_reaped=True)

    def close(self):
        if self.closed or self.process is None: return
        # EOF belongs to the root helper, which cancels only its retained pidfd.
        if self.process.stdin is not None:
            self.process.stdin.close(); self.process.stdin = None
        try:
            self.process.wait(timeout=1)
            if self.result is not None and self.process.returncode != 0:
                raise RuntimeError('worker deadline guard failed after termination')
        finally:
            self.process.stdout.close()
            self.closed = self.process.poll() is not None
        if not self.closed: raise RuntimeError('worker deadline guard reap unverified')

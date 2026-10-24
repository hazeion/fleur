"""Bounded commands using the existing retained-SSH leader/PGID mechanism."""
import os
import re
from types import SimpleNamespace
import selectors
import signal
import subprocess
import sys
import time
import types


_native_waitid = None
if not hasattr(os, "waitid"):
    if sys.platform != "darwin":
        raise RuntimeError("waitid unavailable")
    import ctypes
    if (ctypes.sizeof(ctypes.c_void_p) != 8 or ctypes.sizeof(ctypes.c_int) != 4
            or ctypes.sizeof(ctypes.c_long) != 8 or sys.byteorder != "little"
            or getattr(os, "WNOHANG", 1) != 1 or getattr(os, "WEXITED", 4) != 4
            or getattr(os, "WNOWAIT", 32) != 32):
        raise RuntimeError("waitid ABI unsupported")
    # Darwin SDK sys/signal.h and sys/wait.h define the stable six-int prefix.
    # Buffer256 exceeds the LP64 siginfo_t104, preserving alignment and bounds.
    _libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    _native_waitid = _libc.waitid
    _native_waitid.argtypes = [ctypes.c_int, ctypes.c_uint, ctypes.c_void_p, ctypes.c_int]
    _native_waitid.restype = ctypes.c_int


def exited(child):
    if _native_waitid is None:
        return os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    info = (ctypes.c_long * 32)()
    if _native_waitid(1, child.pid, ctypes.byref(info), 4 | 1 | 32) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    fields = ctypes.cast(info, ctypes.POINTER(ctypes.c_int))
    if not fields[3]:
        return None
    if fields[3] != child.pid:
        raise RuntimeError("waitid child differs")
    if (fields[0] != signal.SIGCHLD or fields[1] != 0 or fields[2] not in (1, 2, 3)
            or not 0 <= fields[5] <= 255 or (fields[2] != 1 and not 0 < fields[5] < signal.NSIG)):
        raise RuntimeError("waitid ABI response")
    return types.SimpleNamespace(si_code=fields[2], si_status=fields[5])


def inventory(pid):
    deadline = time.monotonic() + 1
    def check_budget():
        if time.monotonic() >= deadline:
            raise RuntimeError("inventory deadline")
    # No command arguments or ambient loader/configuration variables are read.
    args = (["/bin/ps", "-x", "-g", str(pid), "-o", "pid=,pgid=,stat="]
            if sys.platform == "darwin" else ["/bin/ps", "-axo", "pid=,pgid=,stat="])
    check_budget()
    probe = subprocess.Popen(args, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             env={"LC_ALL": "C", "LANG": "C", "PATH": "/usr/bin:/bin"})
    selector = None
    try:
        check_budget()
        selector = selectors.DefaultSelector()
        check_budget()
        selector.register(probe.stdout, selectors.EVENT_READ)
        check_budget()
        data = bytearray()
        while selector.get_map():
            check_budget()
            for key, _ in selector.select(0.02):
                part = os.read(key.fileobj.fileno(), 8192)
                check_budget()
                if not part:
                    selector.unregister(key.fileobj)
                else:
                    data.extend(part)
                    if len(data) > 2 * 1024 * 1024:
                        raise RuntimeError("inventory size")
        while True:
            check_budget()
            observed = exited(probe)
            check_budget()
            if observed is not None:
                break
            time.sleep(0.01)
    finally:
        try:
            # A successful fresh WNOWAIT proves this parent still owns the
            # reservation. Lost/uncertain custody authorizes no PID signal/reap.
            exited(probe)
            try:
                os.kill(probe.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            probe.wait(timeout=1)
        finally:
            try:
                if selector is not None:
                    selector.close()
            finally:
                probe.stdout.close()
    if probe.returncode != 0:
        raise RuntimeError("inventory exit")
    check_budget()
    seen = set()
    found = False
    live = 0
    for line in data.decode("ascii").splitlines():
        check_budget()
        match = re.fullmatch(r"\s*([0-9]+)\s+([0-9]+)\s+([!-~]{1,32})\s*", line)
        if not match:
            raise RuntimeError("inventory schema")
        member, group, state = int(match[1]), int(match[2]), match[3]
        if member in seen or member > 2147483647 or group > 2147483647:
            raise RuntimeError("inventory identity")
        seen.add(member)
        if member == pid and group != pid:
            raise RuntimeError("leader group")
        if group != pid:
            continue
        # State in another group supplies no authority about this group. The
        # exact retained leader and every owned member still require known state.
        if not re.fullmatch(r"[RSDTtXZIUW][<>NnLl+sSAEVWXCTJP-]*", state):
            raise RuntimeError("inventory owned state")
        if member == pid:
            found = True
        elif state[0] not in ("Z", "X"):
            live += 1
    check_budget()
    if not found:
        raise RuntimeError("leader absent")
    return live



def bounded(args, timeout=5, limit=1048576, env=None, cwd=None):
    if type(timeout) not in (int,float) or timeout<=1 or type(limit) is not int or not 0<limit<=4194304:raise ValueError('bounded command budget')
    end=time.monotonic()+timeout
    child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env=env,cwd=cwd)
    selector=selectors.DefaultSelector();buffers={child.stdout:bytearray(),child.stderr:bytearray()};status=None
    for stream in buffers:selector.register(stream,selectors.EVENT_READ)
    try:
        while selector.get_map() or status is None:
            if time.monotonic()>=end-1:raise RuntimeError('COMMAND_DEADLINE_EXPIRED')
            if status is None:
                info=exited(child)
                if info is not None:status=info.si_status if info.si_code==getattr(os,'CLD_EXITED',1) else 128+info.si_status
            for key,_ in selector.select(min(.02,max(0,end-1-time.monotonic()))):
                block=os.read(key.fileobj.fileno(),8192)
                if not block:selector.unregister(key.fileobj)
                else:
                    if sum(map(len,buffers.values()))+len(block)>limit:raise RuntimeError('COMMAND_OUTPUT_BOUND')
                    buffers[key.fileobj].extend(block)
        return SimpleNamespace(returncode=status,stdout=bytes(buffers[child.stdout]),stderr=bytes(buffers[child.stderr]))
    finally:
        # Leader is retained until the complete owned PGID is signalled and observed.
        try:
            if exited(child) is None or inventory(child.pid)>0:
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
            while exited(child) is None or inventory(child.pid)>0:
                if time.monotonic()>=end:raise RuntimeError('COMMAND_RETIREMENT_UNCONFIRMED')
                time.sleep(.01)
            child.wait(timeout=max(.01,end-time.monotonic()))
        finally:
            selector.close();child.stdout.close();child.stderr.close()

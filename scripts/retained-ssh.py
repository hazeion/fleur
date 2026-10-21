"""Retain the actual SSH leader until its host completes owned group signals."""
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time
import types


def emit(value):
    os.write(3, (json.dumps(value, separators=(",", ":")) + "\n").encode())


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
    # No command arguments or ambient loader/configuration variables are read.
    probe = subprocess.Popen(["/bin/ps", "-axo", "pid=,pgid=,stat="], stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             env={"LC_ALL": "C", "LANG": "C", "PATH": "/usr/bin:/bin"})
    selector = selectors.DefaultSelector()
    selector.register(probe.stdout, selectors.EVENT_READ)
    data = bytearray()
    deadline = time.monotonic() + 1
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise RuntimeError("inventory deadline")
            for key, _ in selector.select(0.02):
                part = os.read(key.fileobj.fileno(), 8192)
                if not part:
                    selector.unregister(key.fileobj)
                else:
                    data.extend(part)
                    if len(data) > 2 * 1024 * 1024:
                        raise RuntimeError("inventory size")
        while exited(probe) is None:
            if time.monotonic() >= deadline:
                raise RuntimeError("inventory deadline")
            time.sleep(0.01)
    finally:
        try:
            os.kill(probe.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        probe.wait(timeout=1)
        selector.close()
        probe.stdout.close()
    if probe.returncode != 0:
        raise RuntimeError("inventory exit")
    seen = set()
    found = False
    live = 0
    for line in data.decode("ascii").splitlines():
        match = re.fullmatch(r"\s*([0-9]+)\s+([0-9]+)\s+([RSDTtXZIUW][<>NnLl+sSAEVWXCTJP-]*)\s*", line)
        if not match:
            raise RuntimeError("inventory schema")
        member, group, state = int(match[1]), int(match[2]), match[3]
        if member in seen or member > 2147483647 or group > 2147483647:
            raise RuntimeError("inventory identity")
        seen.add(member)
        if member == pid:
            if group != pid:
                raise RuntimeError("leader group")
            found = True
        elif group == pid and state[0] not in ("Z", "X"):
            live += 1
    if not found:
        raise RuntimeError("leader absent")
    return live


child = None
released = False
try:
    emit({"kind": "ready"})
    initial = sys.stdin.buffer.readline(65537)
    if not initial:
        sys.exit(0)
    if len(initial) > 65536 or not initial.endswith(b"\n"):
        raise RuntimeError("host input bound")
    initial = json.loads(initial)
    args = initial.get("args")
    if (initial.get("kind") != "start" or not isinstance(args, list) or not 1 <= len(args) <= 64
            or args[0] != "ssh" or any(type(value) is not str or "\x00" in value for value in args)):
        raise RuntimeError("host input schema")
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    emit({"kind": "pid", "pid": child.pid})
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin, selectors.EVENT_READ, 0)
    selector.register(child.stdout, selectors.EVENT_READ, 1)
    selector.register(child.stderr, selectors.EVENT_READ, 2)
    pending = bytearray()
    status = None
    pipes = 2
    while True:
        if status is None:
            observed = exited(child)
            if observed is not None:
                status = observed.si_status if observed.si_code == getattr(os, "CLD_EXITED", 1) else 128 + observed.si_status
                detail = None if observed.si_code == getattr(os, "CLD_EXITED", 1) else signal.Signals(observed.si_status).name
                emit({"kind": "status", "code": status, "signal": detail})
                emit({"kind": "exit", "code": status, "survivor": inventory(child.pid) > 0})
        for key, _ in selector.select(0.02):
            block = os.read(key.fileobj.fileno(), 8192)
            if key.data:
                if block:
                    view = memoryview(block)
                    while view:
                        view = view[os.write(key.data, view):]
                else:
                    selector.unregister(key.fileobj)
                    pipes -= 1
                    if not pipes:
                        os.close(1)
                        os.close(2)
                        emit({"kind": "pipes"})
                continue
            if not block:
                raise RuntimeError("host closed")
            pending.extend(block)
            if len(pending) > 1024:
                raise RuntimeError("host input bound")
            while b"\n" in pending:
                line, _, remaining = pending.partition(b"\n")
                pending = bytearray(remaining)
                command = json.loads(line)
                if command.get("kind") == "inspect" and type(command.get("id")) is int:
                    emit({"kind": "inventory", "id": command["id"], "live": inventory(child.pid)})
                elif command == {"kind": "release"}:
                    if status is None or pipes or inventory(child.pid):
                        raise RuntimeError("release refused")
                    released = True
                    child.wait(timeout=1)
                    sys.exit(0)
                else:
                    raise RuntimeError("host input schema")
except Exception as error:
    try:
        stage = str(error)
        allowed = {"inventory deadline", "inventory size", "inventory exit", "inventory schema", "inventory identity", "leader group", "leader absent", "release refused", "host closed", "host input bound", "host input schema", "waitid unavailable", "waitid child differs", "waitid ABI unsupported", "waitid ABI response"}
        emit({"kind": "error", "stage": stage if stage in allowed else "unknown"})
    except OSError:
        pass
    # Keep the reservation while the host cancels timers and surrenders control.
    try:
        while os.read(0, 1024):
            pass
    except OSError:
        pass
finally:
    if child is not None and not released:
        # Best effort after host failure. It never converts a denied host signal
        # into a successful receipt. The unreaped leader still reserves this ID.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass

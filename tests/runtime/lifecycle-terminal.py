"""Test-only real PTY/session death through the public CLI, never runtime internals."""
import json
import os
import pty
import select
import signal
import sys
import time

mode = sys.argv[4] if len(sys.argv) > 4 else "foreground"
pid, terminal = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], sys.argv[2], "dev", "--project", sys.argv[3], "--json"] + (["--background"] if mode == "background" else []))
received = b""
deadline = time.monotonic() + 90
try:
    def ready_output():
        for line in received.decode(errors="replace").splitlines():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            data = item.get("data") or {}
            if item.get("event") == "ready" or data.get("ready") or (data.get("result") or {}).get("data", {}).get("ready"):
                return True
        return False
    while not ready_output():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("foreground readiness not observed")
        ready, _, _ = select.select([terminal], [], [], remaining)
        if ready:
            received += os.read(terminal, 65536)
        if len(received) > 1048576:
            raise RuntimeError("terminal output exceeded bound")
    exited, _ = os.waitpid(pid, os.WNOHANG)
    if not exited:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    pid = None
    events = [json.loads(line) for line in received.decode().splitlines() if line.startswith("{\"formatVersion\":") ]
    print(json.dumps({"ready": True, "sessionKilled": True, "events": events}))
finally:
    os.close(terminal)
    if pid is not None:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except ProcessLookupError:
            pass

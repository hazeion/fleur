"""Trusted registered fixture dispatcher. This is not PostgreSQL evidence."""
import json
import os
import selectors
import subprocess
import time

REQUEST = {"kind": "broker-request", "operation": "compat.query",
           "token": "probe-query", "action": "readExercise", "input": {"id": 1}}


def fixture_dispatch(request):
    # Compare canonical serialized types too: True must never match integer 1.
    if json.dumps(request, sort_keys=True) != json.dumps(REQUEST, sort_keys=True):
        raise ValueError("unregistered broker authority")
    return {"kind": "broker-response", "ok": True,
            "value": {"id": 1, "name": "Squat"}}


def run_container(args, dispatch=fixture_dispatch, timeout=30):
    """Perform one actual pipe request/response and await final worker evidence."""
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)
    started = time.monotonic()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            line = bytearray()
            while not line.endswith(b"\n"):
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0 or not selector.select(remaining):
                    raise subprocess.TimeoutExpired(args, timeout)
                byte = os.read(process.stdout.fileno(), 1)
                if not byte:
                    raise RuntimeError("worker ended before broker request")
                line.extend(byte)
                if len(line) > 4096:
                    raise RuntimeError("broker request exceeded bound")
        response = dispatch(json.loads(line))
        if json.dumps(response, sort_keys=True) != json.dumps({"kind": "broker-response", "ok": True,
                        "value": {"id": 1, "name": "Squat"}}, sort_keys=True):
            raise RuntimeError("registered broker reply failed")
        process.stdin.write(b"registered:Squat\n")
        process.stdin.flush()
        process.stdin.close()
        process.stdin = None
        output, errors = bytearray(), bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, output)
            selector.register(process.stderr, selectors.EVENT_READ, errors)
            while selector.get_map():
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(args, timeout)
                ready = selector.select(remaining)
                if not ready:
                    raise subprocess.TimeoutExpired(args, timeout)
                for key, _ in ready:
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    key.data.extend(chunk)
                    if len(output) > 16384 or len(errors) > 4096:
                        raise RuntimeError("worker output exceeded bound")
        process.wait(timeout=max(0.001, timeout-(time.monotonic()-started)))
        if process.returncode:
            raise RuntimeError(f"worker exited {process.returncode}: " + errors.decode(errors="replace")[-3000:])
        return output.decode()
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()

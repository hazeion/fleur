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


def run_container(args, dispatch=fixture_dispatch, timeout=30, observer=None, diagnostics=None, environment=None, on_stderr=None):
    """Perform one actual pipe request/response and await final worker evidence."""
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=environment)
    started = time.monotonic()
    output, errors = bytearray(), bytearray()
    phase = 'waiting-broker-request'
    def deadline_error():
        error = subprocess.TimeoutExpired(args, timeout, output=bytes(output[:16384]), stderr=bytes(errors[:4096]))
        error.protocol_phase = phase
        return error
    def read_error_chunk():
        chunk = os.read(process.stderr.fileno(),4096)
        errors.extend(chunk)
        if len(errors) > 4096:
            raise RuntimeError('worker stderr exceeded bound')
        if chunk and on_stderr is not None:
            on_stderr(bytes(errors))
        return chunk
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, 'request')
            selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
            line = bytearray()
            while not line.endswith(b"\n"):
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise deadline_error()
                ready = selector.select(remaining)
                if not ready:
                    raise deadline_error()
                for key, _ in ready:
                    if key.data == 'stderr':
                        if not read_error_chunk():
                            selector.unregister(process.stderr)
                        continue
                    byte = os.read(process.stdout.fileno(), 1)
                    if not byte:
                        raise RuntimeError("worker ended before broker request")
                    line.extend(byte)
                    if len(line) > 4096:
                        raise RuntimeError("broker request exceeded bound")
        request = json.loads(line)
        phase = 'host-observer'
        if observer is not None:
            observer(request)
        phase = 'broker-dispatch'
        response = dispatch(request)
        if time.monotonic() - started >= timeout:
            raise deadline_error()
        if json.dumps(response, sort_keys=True) != json.dumps({"kind": "broker-response", "ok": True,
                        "value": {"id": 1, "name": "Squat"}}, sort_keys=True):
            raise RuntimeError("registered broker reply failed")
        phase = 'broker-ack'
        process.stdin.write(b"registered:Squat\n")
        process.stdin.flush()
        process.stdin.close()
        process.stdin = None
        phase = 'waiting-worker-completion'
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, output)
            selector.register(process.stderr, selectors.EVENT_READ, errors)
            while selector.get_map():
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise deadline_error()
                ready = selector.select(remaining)
                if not ready:
                    raise deadline_error()
                for key, _ in ready:
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    key.data.extend(chunk)
                    if len(output) > 16384 or len(errors) > 4096:
                        raise RuntimeError("worker output exceeded bound")
                    if chunk and key.data is errors and on_stderr is not None:
                        on_stderr(bytes(errors))
        process.wait(timeout=max(0.001, timeout-(time.monotonic()-started)))
        if process.returncode:
            raise RuntimeError(f"worker exited {process.returncode}: " + errors.decode(errors="replace")[-3000:])
        return output.decode()
    except subprocess.TimeoutExpired as error:
        # Preserve only already-drained bounded bytes. Callback timeouts keep
        # their own exception category but acquire the worker's observed phase.
        error.output = bytes(output[:16384])
        error.stderr = bytes(errors[:4096])
        error.protocol_phase = phase
        raise
    finally:
        if diagnostics is not None:
            diagnostics.update({'protocol_phase':phase,
                                'duration_ms':round(1000*(time.monotonic()-started)),
                                'timeout_seconds':timeout,
                                'stdout':bytes(output[:16384]).decode('utf-8',errors='replace'),
                                'stderr':bytes(errors[:4096]).decode('utf-8',errors='replace')})
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()

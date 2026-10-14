"""Trusted registered fixture dispatcher. This is not PostgreSQL evidence."""
import json
import os
import selectors
import subprocess
import sys
import time

REQUEST = {"kind": "broker-request", "operation": "compat.query",
           "token": "probe-query", "action": "readExercise", "input": {"id": 1}}


def fixture_dispatch(request):
    # Compare canonical serialized types too: True must never match integer 1.
    if json.dumps(request, sort_keys=True) != json.dumps(REQUEST, sort_keys=True):
        raise ValueError("unregistered broker authority")
    return {"kind": "broker-response", "ok": True,
            "value": {"id": 1, "name": "Squat"}}


class StartupAuditRejected(RuntimeError):
    def __init__(self, category):
        admitted = {'class-mismatch','unexpected-fd','missing-fd','invalid-inventory',
                    'inspection-failed','output-invalid'}
        self.category = category if type(category) is str and category in admitted else 'output-invalid'
        super().__init__('startup descriptor audit rejected: '+self.category)


def startup_inventory(request):
    if type(request) is not dict or set(request) != {'kind','inventory'} or request['kind'] != 'startup-audit':
        raise StartupAuditRejected('invalid-inventory')
    rows = request['inventory']
    if type(rows) is not list or not 2 <= len(rows) <= 192:
        raise StartupAuditRejected('invalid-inventory')
    seen = set()
    for row in rows:
        if (type(row) is not dict or set(row) != {'fd','kind'} or type(row['fd']) is not int
                or not 2 < row['fd'] <= 2147483647 or type(row['kind']) is not str
                or row['kind'] not in ('eventfd','eventpoll','timerfd') or row['fd'] in seen):
            raise StartupAuditRejected('invalid-inventory')
        seen.add(row['fd'])
    return rows


def run_container(args, dispatch=fixture_dispatch, timeout=30, observer=None, diagnostics=None, environment=None, on_stderr=None, startup_audit=None, completion_observer=None, completion_start=None, completion_stall=None, completion_prepare=None, completion_bind=None, cancel_event=None):
    """Perform one actual pipe request/response and await final worker evidence."""
    started = time.monotonic()
    process = None
    output, errors = bytearray(), bytearray()
    waiter = None
    phase = 'waiting-broker-request'
    def check_cancelled():
        if cancel_event is not None and cancel_event.is_set():
            raise RuntimeError('worker operation cancelled')
    def pipe_wait(remaining):
        return min(remaining,.05) if cancel_event is not None else remaining
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
        check_cancelled()
        if completion_prepare is not None:
            if completion_start is not None or completion_bind is None or startup_audit is None or completion_observer is None:
                raise RuntimeError('prepared observer contract invalid')
            phase = 'preparing-init-exit-observer'
            waiter = completion_prepare(timeout-(time.monotonic()-started))
            if waiter is None or not callable(getattr(waiter,'completion',None)) or not callable(getattr(waiter,'close',None)):
                if not callable(getattr(waiter,'close',None)): waiter = None
                raise RuntimeError('prepared observer startup invalid')
            if time.monotonic()-started >= timeout: raise deadline_error()
            phase = 'awaiting-subscription-readiness'
            if not callable(getattr(waiter,'ready',None)):
                raise RuntimeError('subscription readiness unverified')
            prepared = waiter.ready(timeout-(time.monotonic()-started))
            if type(prepared) is not dict or prepared != {'ready':True} or type(prepared.get('ready')) is not bool:
                raise RuntimeError('subscription readiness unverified')
        if time.monotonic()-started >= timeout: raise deadline_error()
        check_cancelled()
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=environment)
        def read_request(limit):
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ, 'request')
                selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
                line = bytearray()
                while not line.endswith(b"\n"):
                    check_cancelled()
                    remaining = timeout - (time.monotonic() - started)
                    if remaining <= 0:
                        raise deadline_error()
                    ready = selector.select(pipe_wait(remaining))
                    if not ready:
                        if cancel_event is not None:
                            check_cancelled()
                            continue
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
                        if len(line) > limit:
                            raise RuntimeError("broker request exceeded bound")
            return json.loads(line)
        if startup_audit is not None:
            phase = 'waiting-startup-audit'
            inventory = startup_inventory(read_request(16384))
            phase = 'startup-audit'
            audited = startup_audit(inventory)
            if (type(audited) is not dict or audited.get('passed') is not True
                    or audited.get('category') != 'verified' or type(audited.get('descriptor_count')) is not int
                    or audited['descriptor_count'] != len(inventory)):
                raise StartupAuditRejected(audited.get('category') if type(audited) is dict else 'output-invalid')
            if time.monotonic() - started >= timeout:
                raise deadline_error()
            if completion_start is not None:
                phase = 'starting-owned-waiter'
                waiter = completion_start(timeout-(time.monotonic()-started))
                if waiter is None or not callable(getattr(waiter,'completion',None)) or not callable(getattr(waiter,'close',None)):
                    if not callable(getattr(waiter,'close',None)): waiter = None
                    raise RuntimeError('owned waiter startup invalid')
                if time.monotonic()-started >= timeout:
                    raise deadline_error()
            if completion_bind is not None:
                phase = 'binding-init-task-start'
                try:
                    bound = completion_bind(waiter,timeout-(time.monotonic()-started))
                except (OSError,ValueError,RuntimeError,subprocess.TimeoutExpired):
                    # A failed registration is the only permission to request
                    # the helper's bounded host-only diagnostic. Never signal
                    # a healthy observer or replace the original bind error.
                    if callable(getattr(waiter,'diagnose_registration',None)):
                        try: waiter.diagnose_registration()
                        except (OSError,ValueError,RuntimeError,subprocess.SubprocessError): pass
                    raise
                if type(bound) is not dict or bound.get('registered') is not True:
                    raise RuntimeError('init task start registration unverified')
                if time.monotonic()-started >= timeout: raise deadline_error()
            phase = 'startup-ack'
            process.stdin.write(b'startup:approved\n')
            process.stdin.flush()
        phase = 'waiting-broker-request'
        request = read_request(4096)
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
        checked_at = 0.0
        pending_since = None
        stall_captured = False
        def complete_frame():
            if b'\n' not in output:
                return None
            if output.count(b'\n') != 1 or not output.endswith(b'\n'):
                raise RuntimeError('worker output is not one bounded evidence frame')
            try:
                frame = json.loads(output)
            except (ValueError,UnicodeError):
                raise RuntimeError('worker evidence frame invalid') from None
            if type(frame) is not dict or frame.get('kind') != 'runtime-evidence':
                raise RuntimeError('worker evidence frame kind invalid')
            return frame
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, output)
            selector.register(process.stderr, selectors.EVENT_READ, errors)
            def drain(ready):
                for key, _ in ready:
                    chunk = os.read(key.fileobj.fileno(),4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    key.data.extend(chunk)
                    if len(output) > 16384 or len(errors) > 4096:
                        raise RuntimeError('worker output exceeded bound')
                    if key.data is errors and on_stderr is not None:
                        on_stderr(bytes(errors))
            while selector.get_map() or completion_observer is not None:
                check_cancelled()
                remaining = timeout - (time.monotonic()-started)
                if remaining <= 0:
                    raise deadline_error()
                frame = complete_frame() if completion_observer is not None else None
                if frame is None and not selector.get_map():
                    raise RuntimeError('worker closed transport without a complete evidence frame')
                if frame is not None and time.monotonic()-checked_at >= 0.1:
                    completed = completion_observer(frame,remaining)
                    if type(completed) is not dict or type(completed.get('completed')) is not bool:
                        raise RuntimeError('owned worker completion observer result invalid')
                    if completed['completed'] and (type(completed.get('exit_code')) is not int or completed['exit_code'] != 0):
                        raise RuntimeError('owned worker did not complete successfully')
                    if time.monotonic()-started >= timeout:
                        raise deadline_error()
                    accepted = completed['completed']
                    if waiter is not None and accepted:
                        completed = waiter.completion(timeout-(time.monotonic()-started))
                    if type(completed) is not dict or type(completed.get('completed')) is not bool:
                        raise RuntimeError('owned worker completion observer result invalid')
                    if waiter is not None and accepted and completed['completed'] is False:
                        if pending_since is None: pending_since = time.monotonic()
                        if completion_stall is not None and not stall_captured and time.monotonic()-pending_since >= 2:
                            stall_captured = True
                            trace = completion_stall(timeout-(time.monotonic()-started))
                            if diagnostics is not None: diagnostics['daemon_stall_trace'] = trace
                    checked_at = time.monotonic()
                    remaining = timeout-(checked_at-started)
                    if remaining <= 0:
                        raise deadline_error()
                    if type(completed) is not dict or type(completed.get('completed')) is not bool:
                        raise RuntimeError('owned worker completion observer result invalid')
                    if completed['completed']:
                        if type(completed.get('exit_code')) is not int or completed['exit_code'] != 0:
                            raise RuntimeError('owned worker did not complete successfully')
                        # Only an accepted frame AND actual owned daemon stop
                        # permit retiring the separate attached host client.
                        if process.poll() is None:
                            process.kill()
                        process.wait(timeout=min(5,remaining))
                        while selector.get_map():
                            available = selector.select(0)
                            if not available:
                                break
                            drain(available)
                        complete_frame()
                        if time.monotonic()-started >= timeout:
                            raise deadline_error()
                        check_cancelled()
                        phase = 'verified-worker-complete'
                        if diagnostics is not None:
                            diagnostics['daemon_completion'] = completed
                            if waiter is not None: diagnostics['completion_source'] = 'registered-containerd-init-exit' if completion_prepare is not None else 'startup-bound-docker-wait'
                            diagnostics['local_client_exit_code'] = process.returncode
                        return output.decode()
                ready = selector.select(pipe_wait(min(remaining,0.1) if frame is not None else remaining))
                if not ready:
                    if cancel_event is not None:
                        check_cancelled()
                        continue
                    if frame is not None:
                        continue
                    raise deadline_error()
                drain(ready)
        while True:
            check_cancelled()
            remaining=timeout-(time.monotonic()-started)
            if remaining<=0: raise deadline_error()
            try:
                process.wait(timeout=pipe_wait(remaining))
                break
            except subprocess.TimeoutExpired:
                if cancel_event is None: raise
        check_cancelled()
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
        original = sys.exception()
        waiter_cleanup_error = None
        if waiter is not None:
            if diagnostics is not None and callable(getattr(waiter,'snapshot',None)):
                try: diagnostics['waiter_observations'] = waiter.snapshot()
                except (OSError,RuntimeError,ValueError): diagnostics['waiter_observations'] = {'outcome':'unavailable'}
            try:
                if completion_prepare is not None:
                    if waiter.close(timeout-(time.monotonic()-started)) is not True:
                        raise RuntimeError('init exit observer cleanup unverified')
                else: waiter.close()
                if diagnostics is not None:
                    diagnostics['waiter_cleanup_verified'] = True
                    if completion_prepare is not None and callable(getattr(waiter,'snapshot',None)):
                        try: diagnostics['observer_after_close'] = waiter.snapshot()
                        except (OSError,RuntimeError,ValueError): diagnostics['observer_after_close'] = {'outcome':'unavailable'}
            except (OSError,RuntimeError,subprocess.TimeoutExpired) as cleanup_error:
                if diagnostics is not None:
                    diagnostics['waiter_cleanup_verified'] = False
                    if completion_prepare is not None and callable(getattr(waiter,'snapshot',None)):
                        try: diagnostics['observer_after_close'] = waiter.snapshot()
                        except (OSError,RuntimeError,ValueError): diagnostics['observer_after_close'] = {'outcome':'unavailable'}
                waiter_cleanup_error = cleanup_error
                if original is not None: original.waiter_cleanup_verified = False
        if diagnostics is not None:
            diagnostics.update({'protocol_phase':phase,
                                'duration_ms':round(1000*(time.monotonic()-started)),
                                'timeout_seconds':timeout,
                                'stdout':bytes(output[:16384]).decode('utf-8',errors='replace'),
                                'stderr':bytes(errors[:4096]).decode('utf-8',errors='replace')})
        if process is not None:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
        if waiter_cleanup_error is not None and original is None:
            raise waiter_cleanup_error
        if waiter is not None and original is None and time.monotonic()-started >= timeout:
            raise deadline_error()

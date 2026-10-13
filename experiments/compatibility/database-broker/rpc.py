"""Bounded host-only RPC. Never disclose database environment to the worker."""
import json
import os
import selectors
import subprocess
import time


class TrustedBroker:
    def __init__(self, command, cwd, environment, timeout=8):
        self.timeout = timeout
        self.process = subprocess.Popen(command, cwd=cwd, env=environment,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def dispatch(self, request):
        encoded = json.dumps(request, separators=(',', ':')).encode() + b'\n'
        if len(encoded) > 4096:
            raise RuntimeError('Trusted broker request exceeded bound')
        started = time.monotonic()
        try:
            if self.process.poll() is not None:
                raise RuntimeError('Trusted broker is unavailable')
            self.process.stdin.write(encoded)
            self.process.stdin.flush()
            response = bytearray()
            with selectors.DefaultSelector() as selector:
                selector.register(self.process.stdout, selectors.EVENT_READ)
                while not response.endswith(b'\n'):
                    remaining = self.timeout - (time.monotonic() - started)
                    if remaining <= 0 or not selector.select(remaining):
                        raise RuntimeError('Trusted broker RPC deadline')
                    byte = os.read(self.process.stdout.fileno(), 1)
                    if not byte:
                        raise RuntimeError('Trusted broker ended before reply')
                    response.extend(byte)
                    if len(response) > 4096:
                        raise RuntimeError('Trusted broker response exceeded bound')
            value = json.loads(response)
            if not isinstance(value, dict) or set(value) != {'kind', 'ok', 'value'} or value['kind'] != 'broker-response' or value['ok'] is not True:
                raise RuntimeError('Trusted broker did not establish success')
            row = value['value']
            if not isinstance(row, dict) or set(row) != {'id', 'name', 'version'} or type(row['id']) is not int or row['id'] != 1 or row['name'] != 'Squat' or type(row['version']) is not int or row['version'] != 1:
                raise RuntimeError('Registered database result differs')
            # Native shim expects only its admitted id/name projection.
            return {'kind': 'broker-response', 'ok': True, 'value': {'id': row['id'], 'name': row['name']}}
        except (OSError, ValueError, RuntimeError):
            self.close()
            raise RuntimeError('Trusted broker RPC failed closed') from None

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=1)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()

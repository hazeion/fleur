"""Bounded independent exit notification for a startup-verified immutable ID."""
import math
import os
import re
import selectors
import subprocess
import time


class WaitUnverified(RuntimeError):
    """Only stable categories and safe byte counts cross the reporting boundary."""
    def __init__(self, category, observations):
        self.category = category
        self.observations = dict(observations)
        super().__init__('owned worker wait unverified (' + category + ')')


class OwnedWaiter:
    def __init__(self, container_id, timeout, docker='docker'):
        self._process = None
        self._selector = selectors.DefaultSelector()
        self._stdout, self._stderr = bytearray(), bytearray()
        self._closed = False
        if (type(container_id) is not str or re.fullmatch('[0-9a-f]{64}', container_id) is None
                or type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0
                or type(docker) is not str or not docker):
            self._selector.close()
            raise WaitUnverified('arguments-invalid', {})
        self._deadline = time.monotonic() + timeout
        try:
            self._process = subprocess.Popen([docker, 'wait', container_id], stdin=subprocess.DEVNULL,
                                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for stream, output in ((self._process.stdout, self._stdout), (self._process.stderr, self._stderr)):
                os.set_blocking(stream.fileno(), False)
                self._selector.register(stream, selectors.EVENT_READ, output)
        except (OSError, ValueError):
            self.close()
            raise WaitUnverified('launch-failed', self._observations()) from None

    def _observations(self):
        return {'stdout_bytes': len(self._stdout), 'stderr_bytes': len(self._stderr),
                'cli_returncode': self._process.returncode if self._process is not None else None}

    def completion(self, remaining):
        if (self._closed or type(remaining) not in (int, float) or not math.isfinite(remaining)
                or remaining <= 0 or time.monotonic() >= self._deadline):
            raise WaitUnverified('wait-timeout', self._observations())
        try:
            while True:
                ready = self._selector.select(0)
                if not ready:
                    break
                for key, _ in ready:
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        self._selector.unregister(key.fileobj)
                    else:
                        key.data.extend(chunk)
                        if len(self._stdout) > 16 or len(self._stderr) > 4096:
                            raise WaitUnverified('output-invalid', self._observations())
            status = self._process.poll()
            if status is None or self._selector.get_map():
                return {'completed': False}
            if status != 0:
                raise WaitUnverified('cli-nonzero', self._observations())
            if bytes(self._stdout) != b'0\n' or self._stderr:
                raise WaitUnverified('exit-notification-invalid', self._observations())
            if time.monotonic() >= self._deadline:
                raise WaitUnverified('wait-timeout', self._observations())
            return {'completed': True, 'exit_code': 0}
        except (OSError, ValueError):
            raise WaitUnverified('observation-failed', self._observations()) from None

    def close(self):
        if self._closed:
            return
        try:
            if self._process is not None and self._process.poll() is None:
                self._process.kill()
                self._process.wait(timeout=1)
            self._closed = True
        except (OSError, subprocess.TimeoutExpired):
            raise WaitUnverified('waiter-cleanup', self._observations()) from None
        finally:
            self._selector.close()
            if self._process is not None:
                for stream in (self._process.stdout, self._process.stderr):
                    if stream is not None:
                        stream.close()

"""Confirm successful owned worker exit independently of Docker attach EOF."""
from datetime import datetime
import json
import math
import os
import re
import selectors
import subprocess
import time

OWNER_LABELS = {'fleur.compatibility.runtime-owner',
                'fleur.compatibility.native-database-owner'}
FINISHED = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$')


def inspect_owned_completion(container, owner, image_id, owner_label, timeout,
                             docker='docker'):
    """Return only pending or independently verified zero-exit completion."""
    process = None
    try:
        if (type(container) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', container)
                or type(owner) is not str or not owner
                or type(image_id) is not str or not image_id
                or owner_label not in OWNER_LABELS
                or type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError('invalid observer arguments')
        deadline = time.monotonic() + min(5, timeout)
        process = subprocess.Popen([docker, 'inspect', container, '--format', '{{json .}}'],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE)
        output, errors = bytearray(), bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, output)
            selector.register(process.stderr, selectors.EVENT_READ, errors)
            while selector.get_map():
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('inspection deadline')
                ready = selector.select(remaining)
                if not ready:
                    raise TimeoutError('inspection deadline')
                for key, _ in ready:
                    chunk = os.read(key.fileobj.fileno(),4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        key.data.extend(chunk)
                        if len(output)>65536 or len(errors)>4096:
                            raise ValueError('inspection bound')
        remaining = deadline-time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            raise ValueError('inspection unsuccessful')
        metadata = json.loads(output.decode('utf-8'))
        if (type(metadata) is not dict or metadata.get('Name') != '/'+container
                or metadata.get('Image') != image_id
                or type(metadata.get('Config')) is not dict
                or type(metadata['Config'].get('Labels')) is not dict
                or metadata['Config']['Labels'].get(owner_label) != owner):
            raise ValueError('inspection ownership')
        state = metadata.get('State')
        if (type(state) is not dict or type(state.get('Running')) is not bool
                or type(state.get('ExitCode')) is not int
                or type(state.get('FinishedAt')) is not str
                or not FINISHED.fullmatch(state['FinishedAt'])):
            raise ValueError('inspection state')
        finished = datetime.fromisoformat(state['FinishedAt'].replace('Z','+00:00'))
        if state['Running']:
            return {'completed':False}
        if state['ExitCode'] != 0 or finished.year == 1:
            raise ValueError('inspection unsuccessful exit')
        return {'completed':True, 'exit_code':0}
    except (OSError, ValueError, TypeError, TimeoutError, subprocess.TimeoutExpired):
        raise RuntimeError('owned worker completion unverified') from None
    finally:
        if process is not None:
            try:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                raise RuntimeError('owned worker completion observer cleanup unverified') from None
            finally:
                for stream in (process.stdout,process.stderr):
                    if stream is not None:
                        stream.close()

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


class CompletionUnverified(RuntimeError):
    """Stable category and bounded safe facts, never raw Docker metadata."""
    def __init__(self, category, observations):
        self.category = category
        self.observations = dict(observations)
        super().__init__('owned worker completion unverified ('+category+')')


def inspect_owned_completion(container, owner, image_id, owner_label, timeout,
                             docker='docker'):
    """Return only pending or independently verified zero-exit completion."""
    process = None
    output, errors = bytearray(), bytearray()
    observations = {'stdout_bytes':0,'stderr_bytes':0,'cli_returncode':None}
    category = 'arguments-invalid'
    try:
        if (type(container) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', container)
                or type(owner) is not str or not owner
                or type(image_id) is not str or not image_id
                or owner_label not in OWNER_LABELS
                or type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError('invalid observer arguments')
        category = 'cli-nonzero'
        deadline = time.monotonic() + min(5, timeout)
        process = subprocess.Popen([docker, 'inspect', container, '--format', '{{json .}}'],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE)
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, output)
            selector.register(process.stderr, selectors.EVENT_READ, errors)
            while selector.get_map():
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    category = 'inspection-timeout'
                    raise TimeoutError('inspection deadline')
                ready = selector.select(remaining)
                if not ready:
                    category = 'inspection-timeout'
                    raise TimeoutError('inspection deadline')
                for key, _ in ready:
                    chunk = os.read(key.fileobj.fileno(),4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        key.data.extend(chunk)
                        if len(output)>65536 or len(errors)>4096:
                            category = 'output-invalid'
                            raise ValueError('inspection bound')
        remaining = deadline-time.monotonic()
        category = 'inspection-timeout'
        if remaining <= 0:
            raise ValueError('inspection unsuccessful')
        returncode = process.wait(timeout=remaining)
        observations['cli_returncode'] = returncode
        category = 'cli-nonzero'
        if returncode != 0:
            raise ValueError('inspection unsuccessful')
        category = 'output-invalid'
        metadata = json.loads(output.decode('utf-8'))
        if type(metadata) is not dict:
            raise ValueError('inspection output')
        category = 'ownership-name'
        if metadata.get('Name') != '/'+container:
            raise ValueError('inspection ownership')
        category = 'ownership-image'
        if metadata.get('Image') != image_id:
            raise ValueError('inspection ownership')
        category = 'ownership-label'
        if (type(metadata.get('Config')) is not dict
                or type(metadata['Config'].get('Labels')) is not dict
                or metadata['Config']['Labels'].get(owner_label) != owner):
            raise ValueError('inspection ownership')
        category = 'state-invalid'
        state = metadata.get('State')
        if type(state) is dict:
            if type(state.get('Running')) is bool:
                observations['state_running'] = state['Running']
            if type(state.get('ExitCode')) is int:
                observations['state_exit_code'] = state['ExitCode']
        if (type(state) is not dict or type(state.get('Running')) is not bool
                or type(state.get('ExitCode')) is not int
                or type(state.get('FinishedAt')) is not str
                or not FINISHED.fullmatch(state['FinishedAt'])):
            raise ValueError('inspection state')
        finished = datetime.fromisoformat(state['FinishedAt'].replace('Z','+00:00'))
        observations['state_finished_at'] = state['FinishedAt']
        if state['Running']:
            return {'completed':False}
        if state['ExitCode'] != 0:
            category = 'nonzero-exit'
            raise ValueError('inspection unsuccessful exit')
        if finished.year == 1:
            raise ValueError('inspection unsuccessful exit')
        return {'completed':True, 'exit_code':0}
    except (OSError, ValueError, TypeError, TimeoutError, subprocess.TimeoutExpired):
        observations.update(stdout_bytes=len(output),stderr_bytes=len(errors),
                            cli_returncode=process.returncode if process is not None else None)
        raise CompletionUnverified(category,observations) from None
    finally:
        if process is not None:
            try:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                observations.update(stdout_bytes=len(output),stderr_bytes=len(errors),
                                    cli_returncode=process.returncode)
                raise CompletionUnverified('observer-cleanup',observations) from None
            finally:
                for stream in (process.stdout,process.stderr):
                    if stream is not None:
                        stream.close()

"""Actual runpy preparer, authenticated ZIP, and a permanently failed stdout sink."""
import json
import os
from pathlib import Path
import runpy
import sys

source, scenario = sys.argv[1:]
original_stdout = sys.stdout
foreign = b'preserved foreign executable'
frames = []
attempted_report = None
broken = False
swapped = False


class FailedEventPipe:
    def write(self, text):
        global broken, swapped, attempted_report
        try:
            value = json.loads(text)
        except (ValueError, TypeError):
            value = None
        if isinstance(value, dict) and value.get('scope') == 'guest-bun-preparation':
            # Observe the attempted report without delivering it. The simulated
            # host pipe remains broken, so this cannot establish host success.
            attempted_report = value
        if (isinstance(value, dict) and value.get('scope') == 'guest-bun-preparation-event'
                and value.get('stage') == 'executable-extraction' and value.get('state') == 'completed'):
            broken = True
            if scenario == 'event-pipe-foreign':
                os.rename('bun', 'owned-moved-partial')
                Path('bun').write_bytes(foreign)
                swapped = True
        if broken:
            raise BrokenPipeError('external fixture event pipe closed')
        if isinstance(value, dict):
            frames.append(value)
        return len(text)

    def flush(self):
        if broken:
            raise BrokenPipeError('external fixture event pipe closed')


if scenario not in ('event-pipe', 'event-pipe-foreign'):
    raise AssertionError('Unknown event pipe fault')
os.environ['FLEUR_GUEST_PREPARATION_EVENTS'] = 'yes'
sys.argv = [source]
sys.stdout = FailedEventPipe()
failure = None
try:
    runpy.run_path(source, run_name='__main__')
except (SystemExit, BrokenPipeError) as error:
    failure = type(error).__name__
finally:
    sys.stdout = original_stdout
locations = []
for path in Path.cwd().rglob('*'):
    if path.is_file() and not path.is_symlink() and path.stat().st_size == len(foreign) and path.read_bytes() == foreign:
        locations.append(str(path.relative_to(Path.cwd())))
print(json.dumps({'eventFailureObserved': broken, 'sourceFailure': failure, 'deliveredFrames': frames,
                  'resultFrameDelivered': any(frame.get('scope') == 'guest-bun-preparation' for frame in frames),
                  'attemptedReport': attempted_report, 'outputExists': Path('bun').exists(),
                  'replacementInjected': swapped, 'foreignLocations': locations,
                  'movedOwnedBytes': Path('owned-moved-partial').stat().st_size if Path('owned-moved-partial').exists() else 0}))

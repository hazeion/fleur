"""External inventory command model; actual SSH child/custody stay real."""
import ctypes
import errno
import json
import os
from pathlib import Path
import runpy
import selectors
import subprocess
import sys
import time

root = Path(os.environ['FIXTURE_ROOT'])
real_popen = subprocess.Popen
leader = None
ssh_child = None
query_number = 0
probe = None
scenario = os.environ.get("INVENTORY_SCENARIO", "unrelated-rows")
real_selector = selectors.DefaultSelector
real_waitpid = os.waitpid
real_kill = os.kill
custody_lost = False
actual_host = sys.platform
capabilities = {'actualHost':actual_host, 'initialWaitidAvailable':hasattr(os, 'waitid'), 'waitidHidden':False, 'libSystemLoaded':False}
real_cdll = ctypes.CDLL
if scenario == 'linux-no-waitid':
    if actual_host == 'darwin':
        if hasattr(os, 'waitid'):
            del os.waitid
        capabilities['waitidHidden'] = True
    def cdll(name, *args, **kwargs):
        library = real_cdll(name, *args, **kwargs)
        if name == '/usr/lib/libSystem.B.dylib':
            capabilities['libSystemLoaded'] = True
        return library
    ctypes.CDLL = cdll

def popen(args, *positional, **kwargs):
    global leader, probe, custody_lost, query_number, ssh_child
    if args[0] == '/bin/ps':
        global_query = args == ['/bin/ps', '-axo', 'pid=,pgid=,stat=']
        group_query = args == ['/bin/ps', '-x', '-g', str(leader), '-o', 'pid=,pgid=,stat=']
        if not (global_query or group_query):
            raise RuntimeError('Unmodeled inventory command')
        query_number += 1
        with (root/'inventory-queries.jsonl').open('a') as stream:
            stream.write(json.dumps({'selection':'global' if global_query else 'owned-group','ordinal':query_number})+'\n')
        if scenario == 'release-third-malformed' and query_number == 3:
            fault = real_popen([sys.executable, '-I', '-c', "import os;os.write(1,b'not-a-row\\n')"], *positional, **kwargs)
            (root/'release-query-fault.json').write_text(json.dumps({'ordinal':query_number,'actualProbeCreated':True}))
            return fault
        if scenario in ('selector-allocation', 'selector-register'):
            probe = real_popen([sys.executable, '-I', '-c', 'import time;time.sleep(2)'], *positional, **kwargs)
            (root/'actual-probe-created').write_text('created')
            return probe
        if scenario in ('lost-query-custody', 'selector-close', 'late-selector'):

            code = "import os,sys;os.write(1,(sys.argv[1]+' '+sys.argv[1]+' Z\\n').encode())"
            probe = real_popen([sys.executable, '-I', '-c', code, str(leader)], *positional, **kwargs)
            (root/'actual-probe-created').write_text('created')
            if scenario == 'lost-query-custody':
                # The OS boundary really reaps this owned child; its Popen
                # object deliberately cannot stand in for a live reservation.
                member, _ = real_waitpid(probe.pid, 0)
                if member != probe.pid:
                    raise RuntimeError('Actual fixture child reap differed')
                custody_lost = True
                (root/'actual-custody-loss.json').write_text(json.dumps({'ownedProbeActuallyReaped':True}))
            return probe
        if scenario in ('owned-overcap', 'malformed', 'missing-leader', 'duplicate'):
            if scenario == 'owned-overcap':
                code = "import os,sys;leader=int(sys.argv[1]);os.write(1,b''.join((str(i)+' '+str(leader)+' S\\n').encode() for i in range(1000000,1200000)))"
            else:
                row = 'not-a-row\n' if scenario == 'malformed' else str(leader+1)+' '+str(leader)+' S\n' if scenario == 'missing-leader' else (str(leader)+' '+str(leader)+' Z\n')*2
                code = 'import os;os.write(1,'+repr(row.encode())+')'
            return real_popen([sys.executable, '-I', '-c', code, str(leader)], *positional, **kwargs)
        # Model the documented selectors, rather than assert a particular argv:
        # many unrelated rows exist globally, while the complete owned group is
        # its genuinely retained exited leader. No native/platform proof claimed.
        code = "import os,sys;leader=int(sys.argv[1]);body=(str(leader)+' '+str(leader)+' Z\\n').encode();body+=b''.join((str(i)+' 1 S\\n').encode() for i in range(1000000,1200000) if i!=leader) if sys.argv[2]=='global' else b'';os.write(1,body)"
        return real_popen([sys.executable, '-I', '-c', code, str(leader), 'global' if global_query else 'group'], *positional, **kwargs)
    child = real_popen(args, *positional, **kwargs)
    if args[0] == 'ssh':
        ssh_child = child
        leader = child.pid
        # Initialize the genuine host waitid/LibSystem controller first. Only
        # the external selector metadata changes at this actual spawn boundary.
        if scenario == 'linux-no-waitid':
            capabilities.update(controllerPlatform=sys.platform, controllerWaitidAvailable=hasattr(os, 'waitid'))
        sys.platform = 'linux' if scenario in ('linux-rows', 'linux-no-waitid') else 'darwin'
        if scenario == 'linux-no-waitid':
            capabilities['selectorPlatform'] = sys.platform
            (root/'platform-capabilities.json').write_text(json.dumps(capabilities))
    return child

class SelectorFault:
    def __init__(self):
        self.actual = real_selector()
    def __getattr__(self, name):
        return getattr(self.actual, name)
    def register(self, *args, **kwargs):
        if scenario == 'selector-register':
            (root/'selector-fault-fired').write_text('after actual probe creation')
            raise OSError('Controlled selector registration failure')
        return self.actual.register(*args, **kwargs)
    def close(self):
        self.actual.close()
        if scenario == 'selector-close':
            (root/'selector-fault-fired').write_text('after actual probe creation')
            raise OSError('Controlled selector closure failure')

def selector():
    if probe is not None:
        if scenario == 'late-selector':
            actual = real_selector()
            time.sleep(1.05)
            (root/'late-selector-finished').write_text('past original one-second work window')
            return actual
        if scenario == 'selector-allocation':
            (root/'selector-fault-fired').write_text('after actual probe creation')
            raise OSError('Controlled selector allocation failure')
        if scenario in ('selector-register', 'selector-close'):
            return SelectorFault()
    return real_selector()

def kill(pid, number):
    if custody_lost and probe is not None and pid == probe.pid and number != 0:
        # Record the unsafe attempt WITHOUT delivering it to a released PID.
        (root/'released-probe-signal.json').write_text(json.dumps({'attempted':True,'delivered':False}))
        raise ProcessLookupError(errno.ESRCH, 'Fixture blocked released PID signal')
    return real_kill(pid, number)

selectors.DefaultSelector = selector
os.kill = kill
# The actual host capabilities/platform initialize the unmodified controller.
# Modeled query selection is not native Darwin or Linux completeness evidence.
subprocess.Popen = popen
try:
    runpy.run_path(sys.argv[2], run_name='__main__')
except SystemExit as completed:
    if scenario in ('helper-nonzero-after-release', 'helper-truncated-after-release') and completed.code == 0:
        if query_number != 3 or ssh_child is None or ssh_child.returncode != 75:
            raise RuntimeError('Genuine source release was not completed')
        (root/'source-release-completed.json').write_text(json.dumps({'queries':query_number,'actualSshChildReaped':True,'sourceExitCode':completed.code}))
        if scenario == 'helper-nonzero-after-release':
            raise SystemExit(23)
        # A real trailing partial OS control write, after genuine source release.
        os.write(3, b'{"kind":')
    raise
finally:
    if probe is not None:
        # Capture actual source retirement/stream state BEFORE fixture backup.
        (root/'probe-retirement.json').write_text(json.dumps({'sourceReaped':probe.returncode is not None,'streamClosed':probe.stdout.closed}))
        if probe.returncode is None:
            # Self-bounded owned child: passive backup only, no numeric signal.
            probe.wait(timeout=3)
        probe.stdout.close()
        (root/"fixture-backup-finished").write_text("retired")

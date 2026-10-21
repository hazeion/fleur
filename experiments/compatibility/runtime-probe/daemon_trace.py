"""Diagnostic only: fixed hosted-daemon signal and redacted stack frames."""
import json
import math
import os
import platform
import re
import selectors
import shlex
import subprocess
import time

INPUT_LIMIT = 1048576
OUTPUT_LIMIT = 65536
PREFIXES = ('runtime.', 'sync.', 'internal/', 'net.', 'net/', 'os.', 'os/', 'io.', 'io/',
            'syscall.', 'time.', 'context.', 'reflect.', 'encoding/', 'bufio.', 'fmt.',
            'bytes.', 'strings.', 'github.com/docker/', 'github.com/moby/',
            'github.com/containerd/', 'google.golang.org/grpc/')
NAME = r'[A-Za-z0-9_./\-]+(?:\(\*[A-Za-z0-9_]+\)\.)?[A-Za-z0-9_.\-]*'
STATES = {'running','runnable','IO wait','semacquire','sync.Mutex.Lock','sync.RWMutex.RLock',
          'chan receive','chan send','select','sleep','syscall','sync.Cond.Wait'}
TRACE_COMMAND = r'''set -eu
IFS= read -r daemon < /var/run/docker.pid || [ -n "$daemon" ]
case "$daemon" in ''|*[!0-9]*|0|1) exit 2 ;; esac
[ "${#daemon}" -le 10 ] && [ "$daemon" -gt 1 ] && [ "$daemon" -le 2147483647 ] || exit 2
IFS= read -r comm < "/proc/$daemon/comm"
[ "$comm" = dockerd ] || exit 3
before=$(printf '%s\n' /var/run/docker/goroutine-stacks-*.log)
kill -USR1 "$daemon"
tries=0
while [ "$tries" -lt 50 ]; do
    for trace in /var/run/docker/goroutine-stacks-*.log; do
        [ -f "$trace" ] && [ ! -L "$trace" ] || continue
        seen=false
        if printf '%s\n' "$before" | grep -F -x -- "$trace" >/dev/null; then seen=true; fi
        if [ "$seen" = false ] && [ -s "$trace" ]; then
            printf 'trace-ready\n'
            head -c 1048576 "$trace"
            rm -f -- "$trace"
            exit 0
        fi
    done
    tries=$((tries + 1))
    sleep .05
done
exit 4
'''


# Runs entirely after sudo: timeout owns its command process group even when
# sudo allocates a separate PTY/session. The outer root shell removes new raw
# files after normal exit or timeout escalation; existing dumps are preserved.
ROOT_SUPERVISOR = r'''set -u
case "$1" in ''|*[!0-9.]* ) exit 2 ;; esac
before=$(printf '%s\n' /var/run/docker/goroutine-stacks-*.log)
cleanup() {
    clean=0
    for trace in /var/run/docker/goroutine-stacks-*.log; do
        # Only new regular, non-symlink files produced by this diagnostic.
        [ -f "$trace" ] && [ ! -L "$trace" ] || continue
        seen=false
        if printf '%s\n' "$before" | grep -F -x -- "$trace" >/dev/null; then seen=true; fi
        if [ "$seen" = false ]; then rm -f -- "$trace" || clean=1; fi
    done
    return "$clean"
}
trap 'cleanup || exit 126' EXIT
/usr/bin/timeout --signal=TERM --kill-after=0.2s "$1" /bin/sh -c ''' + shlex.quote(TRACE_COMMAND) + '\nexit $?\n'


def parse_stacks(output):
    if type(output) is not str or len(output.encode('utf-8')) > INPUT_LIMIT:
        raise ValueError('stack input invalid')
    rows, current = [], None
    truncated = False
    recognized_headers = 0
    for line in output.splitlines():
        match = re.fullmatch(r'goroutine [0-9]+ \[([^\]]{1,100})\]:',line)
        if match:
            recognized_headers += 1
            state = match[1].split(', ',1)[0]
            current = None
            if state in STATES:
                current = {'state':state,'functions':[]}
                rows.append(current)
            continue
        if current is None: continue
        if line.startswith('created by '):
            name = line[11:].split(' in goroutine ',1)[0]
        else:
            frame = re.fullmatch('('+NAME+r')\(.*\)',line)
            if frame is None: continue
            name = frame[1]
        if not name.startswith(PREFIXES) or len(name) > 200 or not re.fullmatch(NAME,name): continue
        if len(current['functions']) < 32: current['functions'].append(name)
        else: truncated = True
    # Preserve relevant daemon/stream stacks ahead of unrelated idle goroutines.
    rows.sort(key=lambda row:not any(any(word in frame for word in ('docker/','moby/','containerd/')) for frame in row['functions']))
    selected, used = [], 100
    for row in rows:
        size = len(json.dumps(row).encode('utf-8')) + 2
        if used+size <= OUTPUT_LIMIT:
            selected.append(row);used += size
        else: truncated = True
    return {'goroutines':selected,'truncated':truncated or len(output.encode('utf-8')) >= INPUT_LIMIT,
            'recognized_header_count':recognized_headers}


def eligible_host():
    expected = {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux',
                'GITHUB_REPOSITORY':'hazeion/fleur','GITHUB_WORKFLOW':'Compatibility experiments',
                'GITHUB_JOB':'runtime-probe'}
    return platform.system() == 'Linux' and all(os.environ.get(key) == value for key,value in expected.items())


def capture_daemon_trace(remaining, *, host_binding=None):
    if host_binding is None and not eligible_host(): return {'outcome':'ineligible-host'}
    if type(remaining) not in (int,float) or not math.isfinite(remaining) or remaining <= 1:
        return {'outcome':'budget-unavailable'}
    budget = min(5,remaining)
    deadline = time.monotonic()+budget
    supervisor=ROOT_SUPERVISOR
    if host_binding is not None:
        from privileged_control import HostDaemonBinding, ROOT_BINDING_SOURCE
        if type(host_binding) is not HostDaemonBinding:raise ValueError('typed host daemon binding required')
        host_binding.verify(deadline-time.monotonic())
        signal_source=ROOT_BINDING_SOURCE+"\nimport sys,signal\npayload=sys.argv[1];binding=json.loads(sys.argv[2]);deadline=min(float(sys.argv[3]),json.loads(payload)['deadlineMonotonic'])\nverify_root_binding(payload,binding,deadline)\nfd=os.pidfd_open(binding['identity']['pid'],0)\ntry:\n    if daemon_identity(binding['address'],binding['ctr'])!=binding['identity'] or time.monotonic()>=deadline:raise ValueError('trace daemon changed')\n    signal.pidfd_send_signal(fd,signal.SIGUSR1)\nfinally:os.close(fd)\n"
        invocation=shlex.join(['/usr/bin/python3','-I','-c',signal_source,*host_binding.root_arguments(deadline),str(deadline)])
        owned_trace=TRACE_COMMAND.replace('kill -USR1 "$daemon"',invocation)
        supervisor=ROOT_SUPERVISOR.replace(shlex.quote(TRACE_COMMAND),shlex.quote(owned_trace))
        budget=deadline-time.monotonic()
        if budget<=.75:return {'outcome':'budget-unavailable'}
    process = None
    output, errors = bytearray(),bytearray()
    outcome = 'unavailable'
    try:
        process = subprocess.Popen(['sudo','-n','/bin/sh','-c',supervisor,'fleur-daemon-trace',format(math.floor((budget-.75)*1000)/1000,'.3f')],stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,
            env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'})
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout,selectors.EVENT_READ,output)
            selector.register(process.stderr,selectors.EVENT_READ,errors)
            while selector.get_map():
                left = deadline-time.monotonic()-.25
                if left <= 0: raise TimeoutError
                ready = selector.select(left)
                if not ready: raise TimeoutError
                for key,_ in ready:
                    chunk = os.read(key.fileobj.fileno(),8192)
                    if not chunk: selector.unregister(key.fileobj)
                    else: key.data.extend(chunk)
                    if len(output) > INPUT_LIMIT+12 or len(errors) > 1024:
                        outcome = 'output-limit';raise ValueError
        left = deadline-time.monotonic()-.25
        if left <= 0: raise TimeoutError
        process.wait(timeout=left)
        if process.returncode == 0 and output.startswith(b'trace-ready\n'):
            result = parse_stacks(output[12:].decode('utf-8'))
            result.update(outcome='captured' if result['goroutines'] else 'empty-stack',
                          snapshot_may_be_partial=True,cli_returncode=process.returncode,
                          stack_input_bytes=len(output)-12)
            while len(json.dumps(result).encode('utf-8')) > OUTPUT_LIMIT:
                result['goroutines'].pop()
                result['truncated'] = True
            return result
        outcome = 'command-failed'
    except (TimeoutError,subprocess.TimeoutExpired): outcome = 'timed-out'
    except (OSError,UnicodeError,ValueError): pass
    finally:
        if process is not None:
            try:
                if process.poll() is None:
                    # Give the privileged inner timeout and EXIT cleanup their
                    # reserved budget even when parsing/read bounds fail.
                    try: process.wait(timeout=max(.001,deadline-time.monotonic()-.05))
                    except subprocess.TimeoutExpired:
                        outcome = 'cleanup-unverified'
                        process.kill()
                        process.wait(timeout=max(.001,deadline-time.monotonic()))
            except (OSError,subprocess.TimeoutExpired): outcome = 'cleanup-unverified'
            for stream in (process.stdout,process.stderr):
                if stream is not None: stream.close()
    return {'outcome':outcome,'stdout_bytes':len(output),'stderr_bytes':len(errors),
            'cli_returncode':process.returncode if process is not None else None}

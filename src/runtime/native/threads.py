"""Trusted host inspection of the owned worker while broker input is paused."""
import subprocess

# Shell builtins only; no process environment, memory, cmdline or other status fields.
STATUS_COMMAND = r"""set -eu
for status in /proc/"$1"/task/[0-9]*/status; do
    printf 'thread\n'
    while IFS=' 	' read -r key value rest; do
        case "$key" in
            Pid:|NoNewPrivs:|Seccomp:|Seccomp_filters:) printf '%s %s\n' "$key" "$value" ;;
        esac
    done < "$status"
    printf 'end\n'
done
"""
FIELDS = {'Pid:':'pid', 'NoNewPrivs:':'no_new_privs',
          'Seccomp:':'seccomp', 'Seccomp_filters:':'seccomp_filters'}


def parse_threads(output, pid=1):
    if type(output) is not str or len(output.encode('utf-8')) > 8192:
        raise ValueError('thread status output invalid or exceeded bound')
    rows, current = [], None
    for line in output.splitlines():
        if line == 'thread':
            if current is not None:
                raise ValueError('nested thread status record')
            current = {}
        elif line == 'end':
            if current is None or set(current) != set(FIELDS.values()):
                raise ValueError('incomplete thread status record')
            rows.append(current)
            current = None
        else:
            fields = line.split()
            if current is None or len(fields) != 2 or fields[0] not in FIELDS:
                raise ValueError('unadmitted thread status field')
            key, value = FIELDS[fields[0]], fields[1]
            if key in current or not value.isascii() or not value.isdecimal():
                raise ValueError('duplicate or noninteger thread status field')
            current[key] = int(value)
    if current is not None or not 2 <= len(rows) <= 64:
        raise ValueError('incomplete all-thread inspection')
    ids = [row['pid'] for row in rows]
    if pid not in ids or len(set(ids)) != len(ids) or any(pid <= 0 for pid in ids):
        raise ValueError('thread identity invalid')
    if any(row['no_new_privs'] != 1 or row['seccomp'] != 2 or row['seccomp_filters'] != 1 for row in rows):
        raise ValueError('existing thread lacks the sole native restriction filter')
    return rows


def docker_exec(container, command):
    result = subprocess.run(['docker','exec','--user','65534:65534',container,*command],
                            capture_output=True,text=True,timeout=5,check=False)
    return result.returncode, result.stdout


def inspect_threads(container, pid=1, runner=None):
    # Container is the successfully launched, owned worker's exact name. This
    # named fixed read operation runs outside its irreversible native filter.
    # A retained container inspects its exact operation process, never init.
    if type(pid) is not int or not 0 < pid <= 2**22:
        raise ValueError('thread identity invalid')
    returncode, output = (runner or (lambda command: docker_exec(container, command)))(['/bin/sh','-c',STATUS_COMMAND,'sh',str(pid)])
    if returncode:
        raise RuntimeError('owned worker task-status inspection failed')
    return parse_threads(output, pid)

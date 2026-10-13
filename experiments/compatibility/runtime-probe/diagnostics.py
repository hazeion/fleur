"""Temporary fixed read-only diagnostic for the owned worker, no secret fields."""
import subprocess

SNAPSHOT_COMMAND = r"""set -eu
for status in /proc/1/task/[0-9]*/status; do
    printf 'task\n'
    while IFS=' 	' read -r key value rest; do
        case "$key" in
            Pid:|State:|NoNewPrivs:|Seccomp:|Seccomp_filters:) printf '%s %s\n' "$key" "$value" ;;
        esac
    done < "$status"
    printf 'end\n'
done
while IFS=' 	' read -r key value rest; do
    case "$key" in
        usage_usec|user_usec|system_usec|nr_periods|nr_throttled|throttled_usec) printf 'cpu %s %s\n' "$key" "$value" ;;
    esac
done < /sys/fs/cgroup/cpu.stat
while IFS=' 	' read -r key value rest; do
    case "$key" in
        low|high|max|oom|oom_kill|oom_group_kill) printf 'memory %s %s\n' "$key" "$value" ;;
    esac
done < /sys/fs/cgroup/memory.events
IFS= read -r value < /sys/fs/cgroup/memory.current
printf 'memory_current %s\n' "$value"
IFS= read -r value < /sys/fs/cgroup/pids.current
printf 'pids_current %s\n' "$value"
"""
FIELDS = {'Pid:':'pid','State:':'state','NoNewPrivs:':'no_new_privs',
          'Seccomp:':'seccomp','Seccomp_filters:':'seccomp_filters'}
COUNTERS = {'cpu':{'usage_usec','user_usec','system_usec','nr_periods','nr_throttled','throttled_usec'},
            'memory':{'low','high','max','oom','oom_kill','oom_group_kill'}}


def integer(value):
    if not value.isascii() or not value.isdecimal():
        raise ValueError('noninteger diagnostic counter')
    return int(value)


def parse_snapshot(output):
    if type(output) is not str or len(output.encode('utf-8')) > 16384:
        raise ValueError('diagnostic output invalid or exceeded bound')
    snapshot = {'tasks':[],'cpu':{},'memory':{}}
    current = None
    for line in output.splitlines():
        fields = line.split()
        if line == 'task':
            if current is not None: raise ValueError('nested diagnostic task')
            current = {}
        elif line == 'end':
            if current is None or set(current) != set(FIELDS.values()): raise ValueError('incomplete diagnostic task')
            snapshot['tasks'].append(current)
            current = None
        elif current is not None:
            if len(fields) != 2 or fields[0] not in FIELDS: raise ValueError('unadmitted diagnostic task field')
            key, value = FIELDS[fields[0]], fields[1]
            if key in current: raise ValueError('duplicate diagnostic task field')
            if key == 'state':
                if value not in ('R','S','D','T','t','Z','X','I'): raise ValueError('unknown task state')
                current[key] = value
            else: current[key] = integer(value)
        elif len(fields) == 3 and fields[0] in COUNTERS and fields[1] in COUNTERS[fields[0]]:
            group, key, value = fields
            if key in snapshot[group]: raise ValueError('duplicate cgroup counter')
            snapshot[group][key] = integer(value)
        elif len(fields) == 2 and fields[0] in ('memory_current','pids_current'):
            if fields[0] in snapshot: raise ValueError('duplicate cgroup size')
            snapshot[fields[0]] = integer(fields[1])
        else: raise ValueError('unadmitted diagnostic field')
    rows = snapshot['tasks']
    ids = [row['pid'] for row in rows]
    if current is not None or not 1 <= len(rows) <= 64 or 1 not in ids or len(ids) != len(set(ids)) or any(pid <= 0 for pid in ids):
        raise ValueError('incomplete diagnostic thread identity')
    if set(snapshot['cpu']) != COUNTERS['cpu'] or set(snapshot['memory']) != COUNTERS['memory'] or 'memory_current' not in snapshot or 'pids_current' not in snapshot:
        raise ValueError('missing cgroup diagnostic state')
    return snapshot


def snapshot_worker(container):
    result = subprocess.run(['docker','exec','--user','65534:65534',container,
                             '/bin/sh','-c',SNAPSHOT_COMMAND], capture_output=True,
                            text=True,timeout=5,check=False)
    if result.returncode: raise RuntimeError('owned worker diagnostic snapshot failed')
    return parse_snapshot(result.stdout)

"""Fixed trusted host audit before restricted application entry.

Caller proves owned container/configuration and all-thread TSYNC first. The
worker supplies only a bounded typed inventory; the host independently checks
actual descriptor classes after descriptor creation/duplication are denied.
"""
import re
import subprocess

from threads import docker_exec

INVENTORY_LIMIT = 192
OUTPUT_LIMIT = 16384
KINDS = {'eventfd', 'eventpoll', 'timerfd'}
LINE = re.compile(r'(0|[1-9][0-9]{0,9}) (eventfd|eventpoll|timerfd|unadmitted|missing)')
# All targets stay in this fixed inspector process. Only canonical class labels
# are emitted. The count cap bounds output even with unexpectedly many FDs;
# overflow cannot be accepted as a successful full-set audit.
AUDIT_COMMAND = r'''set -eu
count=0
for descriptor in /proc/"$1"/fd/[0-9]*; do
    count=$((count + 1))
    if [ "$count" -gt 195 ]; then printf 'overflow\n'; exit 0; fi
    number=${descriptor##*/}
    if target=$(readlink "$descriptor" 2>/dev/null); then
        case "$target" in
            'anon_inode:[eventfd]') class=eventfd ;;
            'anon_inode:[eventpoll]') class=eventpoll ;;
            'anon_inode:[timerfd]') class=timerfd ;;
            *) class=unadmitted ;;
        esac
    else
        class=missing
    fi
    printf '%s %s\n' "$number" "$class"
done
'''


def _expected_inventory(inventory):
    if type(inventory) is not list or not 1 <= len(inventory) <= INVENTORY_LIMIT:
        raise ValueError('invalid-inventory')
    expected = {}
    for row in inventory:
        if type(row) is not dict or set(row) != {'fd', 'kind'}:
            raise ValueError('invalid-inventory')
        fd, kind = row['fd'], row['kind']
        if type(fd) is not int or not 2 < fd <= 2147483647 or type(kind) is not str or kind not in KINDS or fd in expected:
            raise ValueError('invalid-inventory')
        expected[fd] = kind
    return expected


def parse_descriptor_inventory(output):
    if type(output) is not str or len(output.encode('utf-8')) > OUTPUT_LIMIT:
        raise ValueError('output-invalid')
    actual = {}
    for line in output.splitlines():
        match = LINE.fullmatch(line)
        if match is None:
            raise ValueError('output-invalid')
        fd = int(match[1])
        if fd > 2147483647 or fd in actual or len(actual) >= INVENTORY_LIMIT + 3:
            raise ValueError('output-invalid')
        actual[fd] = match[2]
    if not {0, 1, 2}.issubset(actual):
        raise ValueError('output-invalid')
    return actual


def inspect_event_inventory(container, inventory, pid=1, runner=None):
    try:
        expected = _expected_inventory(inventory)
    except ValueError:
        return {'passed': False, 'category': 'invalid-inventory'}
    if type(container) is not str or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', container) is None:
        return {'passed': False, 'category': 'inspection-failed'}
    if type(pid) is not int or not 0 < pid <= 2**22:
        return {'passed': False, 'category': 'inspection-failed'}
    try:
        returncode, output = (runner or (lambda command: docker_exec(container, command)))(['/bin/sh', '-c', AUDIT_COMMAND, 'sh', str(pid)])
        if returncode:
            return {'passed': False, 'category': 'inspection-failed'}
        actual = parse_descriptor_inventory(output)
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return {'passed': False, 'category': 'inspection-failed'}
    except ValueError:
        return {'passed': False, 'category': 'output-invalid'}
    actual_nonstdio = set(actual) - {0, 1, 2}
    if actual_nonstdio - set(expected):
        return {'passed': False, 'category': 'unexpected-fd'}
    if set(expected) - actual_nonstdio or any(actual[fd] == 'missing' for fd in actual):
        return {'passed': False, 'category': 'missing-fd'}
    if any(actual[fd] != kind for fd, kind in expected.items()):
        return {'passed': False, 'category': 'class-mismatch'}
    return {'passed': True, 'category': 'verified', 'descriptor_count': len(expected)}

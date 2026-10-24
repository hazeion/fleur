"""Trusted Linux controller. Application processes never receive this channel."""
import json
import os
from pathlib import Path
import re
import select
import struct
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from configuration import inspect_worker_configuration, OWNER_LABEL
from descriptor_audit import inspect_event_inventory
from threads import inspect_threads

MAX = 2 * 1024 * 1024

def read_exact(stream, length, deadline):
    data = bytearray()
    while len(data) < length:
        if not select.select([stream], [], [], max(0, deadline-time.monotonic()))[0]:
            raise RuntimeError('QUERY_TIMEOUT')
        block = os.read(stream.fileno(), min(65536, length-len(data)))
        if not block:
            raise RuntimeError('TRANSPORT_EOF')
        data.extend(block)
    return bytes(data)

def line(stream, limit, deadline):
    data = bytearray()
    while True:
        block = read_exact(stream, 1, deadline)
        if block == b'\n':
            return bytes(data)
        data.extend(block)
        if len(data) > limit:
            raise RuntimeError('FRAME_BOUND')

def frame(stream, deadline):
    size = struct.unpack('!I', read_exact(stream, 4, deadline))[0]
    if not 0 < size <= MAX:
        raise RuntimeError('FRAME_BOUND')
    return json.loads(read_exact(stream, size, deadline))

def send(stream, value):
    data = json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()
    if not 0 < len(data) <= MAX:
        raise RuntimeError('FRAME_BOUND')
    stream.write(struct.pack('!I', len(data)) + data)
    stream.flush()

def command(args, timeout=5):
    result = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    if result.returncode or len(result.stdout) > 65536 or result.stderr:
        raise RuntimeError('CONTROL_UNCONFIRMED')
    return result.stdout.decode().strip()

def owned_remove(name, owner, image):
    value = json.loads(command(['docker', 'inspect', name, '--format', '{{json .}}']))
    if value['Name'] != '/'+name or value['Image'] != image or value['Config']['Labels'].get(OWNER_LABEL) != owner:
        raise RuntimeError('CLEANUP_OWNERSHIP_UNCONFIRMED')
    cid = value['Id']
    command(['docker', 'rm', '--force', cid])
    remaining = command(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', 'id='+cid])
    if remaining:
        raise RuntimeError('CLEANUP_UNCONFIRMED')

def audit_guard(name, owner, image, arguments):
    value = json.loads(command(['docker', 'inspect', name, '--format', '{{json .}}']))
    config, host = value['Config'], value['HostConfig']
    environment = json.loads(command(['docker', 'image', 'inspect', image, '--format', '{{json .Config.Env}}']))
    if (value['Name'] != '/'+name or value['Image'] != image or value['Mounts'] != []
            or config['Image'] != image or config['User'] != '0:0' or config['Labels'].get(OWNER_LABEL) != owner
            or config['Entrypoint'] != ['/usr/bin/python3'] or config['Cmd'] != arguments or config['Env'] != environment
            or config.get('Volumes') not in (None, {}) or host['Privileged'] is not False or host['ReadonlyRootfs'] is not True
            or host['CapDrop'] != ['ALL'] or sorted(cap.removeprefix('CAP_') for cap in host['CapAdd']) != ['KILL', 'SYS_PTRACE']
            or sorted(host['SecurityOpt']) not in (['no-new-privileges'], ['label=disable', 'no-new-privileges']) or host['NetworkMode'] != 'none'
            or host['PidMode'] != 'host' or host['CgroupnsMode'] != 'host'
            or any(host.get(key) not in (None, []) for key in ('Binds', 'Mounts', 'Devices', 'DeviceRequests', 'VolumesFrom'))
            or host['RestartPolicy']['Name'] != 'no' or value['State']['Running'] is not True):
        raise RuntimeError('GUARD_PROFILE_REJECTED')
    return value['Id']

def main():
    if len(sys.argv) != 4 or any(not re.fullmatch(r'sha256:[a-f0-9]{64}', value) for value in sys.argv[1:3]) or not re.fullmatch(r'[a-f0-9-]{36}', sys.argv[3]):
        raise RuntimeError('IMMUTABLE_IMAGES_REQUIRED')
    worker_image, controller_image = sys.argv[1:3]
    owner = 'fleur-read-'+sys.argv[3]
    worker_name, guard_name = owner+'-worker', owner+'-guard'
    worker = guard = None
    guard_record = None
    failure = None
    worker_created = guard_created = False
    deadline = time.monotonic()+30
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    try:
        worker = subprocess.Popen(['docker', 'run', '-i', '--name', worker_name, '--label', OWNER_LABEL+'='+owner,
            '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--security-opt=seccomp=unconfined', '--cpus=1', '--memory=512m', '--memory-swap=512m',
            '--pids-limit=64', '--ulimit=core=0', '--pull=never', worker_image],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        worker_created = True
        audit = json.loads(line(worker.stdout, 16384, deadline))
        if type(audit) is not dict or set(audit) != {'kind', 'inventory'} or audit['kind'] != 'startup-audit':
            raise RuntimeError('STARTUP_REJECTED')
        configuration = inspect_worker_configuration(worker_name, owner, worker_image)
        rows = inspect_threads(worker_name)
        if not 2 <= len(rows) <= 64 or not any(row['pid'] == 1 for row in rows) or len({row['pid'] for row in rows}) != len(rows) or any(
            row['no_new_privs'] != 1 or row['seccomp'] != 2 or row['seccomp_filters'] != 1 for row in rows):
            raise RuntimeError('STARTUP_REJECTED')
        descriptors = inspect_event_inventory(worker_name, audit['inventory'])
        if descriptors.get('passed') is not True or descriptors.get('category') != 'verified' or descriptors.get('descriptor_count') != len(audit['inventory']):
            raise RuntimeError('STARTUP_REJECTED')
        worker_binding = {'id': configuration['container_id'], 'pid': configuration['host_init_pid'], 'boot': boot}
        send(sys.stdout.buffer, {'kind': 'ready', 'worker': worker_binding})
        request = frame(sys.stdin.buffer, deadline)
        if type(request) is not dict or set(request) != {'budgetMs', 'command'} or type(request['budgetMs']) is not int or not 0 < request['budgetMs'] <= 5000:
            raise RuntimeError('REQUEST_DENIED')
        deadline = time.monotonic()+request['budgetMs']/1000
        guard_arguments = ['-I', '-u', '/controller/guard.py', configuration['container_id'], str(configuration['host_init_pid']), str(deadline), boot]
        guard = subprocess.Popen(['docker', 'run', '-i', '--name', guard_name, '--label', OWNER_LABEL+'='+owner,
            '--network=none', '--pid=host', '--cgroupns=host', '--read-only', '--cap-drop=ALL', '--user=0:0',
            '--cap-add=SYS_PTRACE', '--cap-add=KILL', '--security-opt=no-new-privileges', '--pull=never',
            '--entrypoint=/usr/bin/python3', controller_image, *guard_arguments],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        guard_created = True
        if json.loads(line(guard.stdout, 512, deadline)) != {'kind': 'armed'}:
            raise RuntimeError('GUARD_UNCONFIRMED')
        guard_id = audit_guard(guard_name, owner, controller_image, guard_arguments)
        send(sys.stdout.buffer, {'kind': 'guard', 'value': dict(worker_binding, guard=guard_id, deadline=deadline)})
        if frame(sys.stdin.buffer, deadline) != {'kind': 'admit', 'value': None}:
            raise RuntimeError('GUARD_PARENT_ACK_REQUIRED')
        worker.stdin.write(b'startup:approved\n')
        worker.stdin.flush()
        send(worker.stdin, request['command'])
        sequence = 0
        while True:
            value = frame(worker.stdout, deadline)
            # The host independently validates the complete application protocol.
            send(sys.stdout.buffer, {'kind': 'worker', 'value': value})
            decision = frame(sys.stdin.buffer, deadline)
            if type(decision) is not dict or set(decision) != {'kind', 'value'} or decision['kind'] not in ('reply', 'finish'):
                raise RuntimeError('REQUEST_DENIED')
            if decision['kind'] == 'finish':
                break
            sequence += 1
            if sequence > 500:
                raise RuntimeError('QUERY_LIMIT')
            send(worker.stdin, decision['value'])
        # The pidfd, rather than Docker attach exit, proves physical retirement.
        # Final bytes precede the worker's exit_group(0). Keep the independent
        # guard armed until its pidfd observes exit; EOF here would kill a healthy
        # worker in that interval and turn its successful exit into status 137.
        guard_record = json.loads(line(guard.stdout, 512, deadline+.25))
        if type(guard_record) is not dict or guard_record.get('physical_exit_confirmed') is not True or guard_record.get('outcome') not in ('premature-exit', 'cancelled'):
            raise RuntimeError('TERMINATION_UNCONFIRMED')
        guard.wait(timeout=1)
        if guard.returncode:
            raise RuntimeError('GUARD_UNCONFIRMED')
        worker.wait(timeout=1)
        if worker.returncode != 0:
            raise RuntimeError('WORKER_EXIT_UNCONFIRMED')
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError, KeyError, TypeError):
        failure = 'QUERY_TIMEOUT' if time.monotonic() >= deadline else 'INTERNAL_FAILURE'
    finally:
        if guard is not None and not guard.stdin.closed:
            guard.stdin.close()
        if guard is not None and guard_record is None:
            try:
                guard_record = json.loads(line(guard.stdout, 512, deadline+.75))
            except (RuntimeError, ValueError, OSError):
                pass
        if worker is not None and not worker.stdin.closed:
            worker.stdin.close()
        if worker_created:
            owned_remove(worker_name, owner, worker_image)
        # An uncertain independent guard must survive loss of its manager.
        if guard_created and guard_record and guard_record.get('physical_exit_confirmed') is True:
            owned_remove(guard_name, owner, controller_image)
        for process in (worker, guard):
            if process is not None:
                process.wait(timeout=2)
                process.stdout.close()
    if guard_created and (not guard_record or guard_record.get('physical_exit_confirmed') is not True
            or guard_record.get('outcome') not in ('premature-exit', 'cancelled', 'deadline')
            or any(type(guard_record.get(key)) is not int or not 0 <= guard_record[key] <= 250
                   for key in ('kill_lateness_ms', 'physical_exit_lateness_ms'))):
        raise RuntimeError('TERMINATION_UNCONFIRMED')
    if failure:
        send(sys.stdout.buffer, {'kind': 'failure', 'code': failure, 'physicalExitConfirmed': True, 'deadline': guard_record})
    else:
        send(sys.stdout.buffer, {'kind': 'retired', 'physicalExitConfirmed': True, 'deadline': guard_record})

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError, KeyError, TypeError):
        try:
            send(sys.stdout.buffer, {'kind': 'failure', 'code': 'INTERNAL_FAILURE'})
        finally:
            raise SystemExit(1)

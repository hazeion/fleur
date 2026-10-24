"""Conformance probes for the private interruption supervisor, inside an owned guest.

All synthetic processes use the ordinary fixture UID. No package action occurs.
"""
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys
import time
import types


def line(stream, deadline):
    result = bytearray()
    while time.monotonic() < deadline:
        if select.select([stream], [], [], min(0.05, max(0, deadline - time.monotonic())))[0]:
            part = os.read(stream.fileno(), 1)
            if not part:
                raise RuntimeError('Synthetic family handshake ended early')
            result.extend(part)
            if len(result) > 128:
                raise RuntimeError('Synthetic family handshake exceeded bound')
            if part == b'\n':
                return result.decode().strip()
    raise TimeoutError('Synthetic family handshake deadline expired')


def cleanup(helper, leader):
    # The reserved Popen status always belongs to Popen, never a wait-any call.
    if leader is not None and leader.returncode is None:
        os.kill(leader.pid, signal.SIGKILL)
        leader.wait(timeout=2)
    deadline = time.monotonic() + 3
    while True:
        table = helper.process_table()
        owned = helper.descendants(table, os.getpid())
        if not owned:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('Synthetic owned child cleanup is unconfirmed')
        for pid in owned:
            row = table[pid]
            if row['uid'] != os.getuid():
                raise RuntimeError('Synthetic fixture unexpectedly acquired privileged children')
            current = helper.process_identity(pid)
            if not helper.same_process(row, current):
                raise RuntimeError('Synthetic child identity changed before cleanup')
            # A live direct child cannot be reaped/reused by another parent.
            # Kill direct owned synthetic children first; deeper children become
            # direct through subreaper adoption before they can be signaled.
            if current['ppid'] != os.getpid():
                continue
            if current['state'] not in ('Z', 'X'):
                os.kill(pid, signal.SIGKILL)
            elif current['ppid'] == os.getpid():
                observed = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if observed is not None:
                    os.waitpid(pid, 0)
        time.sleep(0.005)


def family(helper, kind):
    if helper.descendants(helper.process_table(), os.getpid()):
        raise RuntimeError('Conformance supervisor was not idle')
    previous = helper.subreaper()
    child = None
    readfd = writefd = None
    observations = {}
    try:
        helper.subreaper(1)
        readfd, writefd = os.pipe()
        source = """import ctypes,os,sys,time
fd=int(sys.argv[1]);kind=sys.argv[2]
branch=os.fork()
if branch==0:
    if os.read(fd,1)!=b'1':os._exit(10)
    os.close(fd)
    leaf=os.fork()
    if leaf==0:
        if kind=='nested':
            if ctypes.CDLL(None).prctl(36,1,0,0,0)!=0:os._exit(11)
            grand=os.fork()
            if grand==0:time.sleep(60);os._exit(0)
        os.write(1,('leaf:'+str(os.getpid())+'\\n').encode())
        time.sleep(0 if kind=='rapid' else 0.05 if kind=='delayed' else 60)
        os._exit(0)
    os._exit(0)
os.close(fd)
os.write(1,('leader:'+str(os.getpid())+'\\n').encode())
while True:time.sleep(1)
"""
        child = subprocess.Popen([sys.executable, '-I', '-c', source, str(readfd), kind],
                                 pass_fds=(readfd,), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        os.close(readfd)
        readfd = None
        leader = helper.process_identity(child.pid)
        if line(child.stdout, time.monotonic() + 2) != 'leader:' + str(child.pid):
            raise RuntimeError('Synthetic reserved leader differs')
        os.kill(child.pid, signal.SIGSTOP)
        deadline = time.monotonic() + 2
        while helper.process_identity(child.pid)['state'] != 'T':
            if time.monotonic() >= deadline:
                raise TimeoutError('Synthetic leader was not stopped')
            time.sleep(0.001)
        table = helper.process_table()
        before = helper.descendants(table, child.pid)
        helper.accumulate(table, child.pid, observations)
        # The double fork cannot begin until the reserved CLI is actually stopped.
        os.write(writefd, b'1')
        os.close(writefd)
        writefd = None
        message = line(child.stdout, time.monotonic() + 2)
        if not message.startswith('leaf:'):
            raise RuntimeError('Synthetic delayed child identity absent')
        leaf = int(message.split(':')[1])
        if leaf in before:
            raise RuntimeError('Synthetic descendant was not born after STOP')
        if not helper.same_process(leader, helper.process_identity(child.pid)):
            raise RuntimeError('Reserved leader changed before SIGKILL')
        os.kill(child.pid, signal.SIGKILL)
        child.wait(timeout=2)
        if child.returncode != -signal.SIGKILL:
            raise RuntimeError('Own Popen SIGKILL/reap receipt was lost')
        if kind in ('nested', 'survivor'):
            try:
                helper.retire_adopted(observations, time.monotonic() + 0.05)
            except TimeoutError:
                pass
            else:
                raise RuntimeError('Live adopted work incorrectly qualified as retired')
            current = helper.process_table()
            if leaf not in current or current[leaf]['state'] in ('Z', 'X'):
                raise RuntimeError('Required live survivor was not actually observed')
            if kind == 'nested' and not helper.descendants(current, leaf):
                raise RuntimeError('Nested subreaper had no retained descendant')
            result = {'case': kind, 'expectedRefusal': True, 'cliOwnSigkillReceipt': True, 'lateDescendantObserved': any(key[0] == leaf for key in observations)}
        else:
            receipts = helper.retire_adopted(observations, time.monotonic() + 2)
            if not any(receipt['pid'] == leaf for receipt in receipts) or not any(key[0] == leaf for key in observations):
                raise RuntimeError('A child born after STOP escaped adopted accounting/reaping')
            result = {'case': kind, 'retired': True, 'cliOwnSigkillReceipt': True, 'lateDescendantObserved': True}
        return result
    finally:
        try:
            cleanup(helper, child)
        finally:
            try:
                for fd in (readfd, writefd):
                    if fd is not None:
                        os.close(fd)
                if child is not None:
                    child.stdout.close()
                    child.stderr.close()
            finally:
                helper.subreaper(previous)


def main():
    if len(sys.argv) < 4 or sys.argv[1] != '--helper-sha256':
        raise RuntimeError('Complete explicit owned helper identity required')
    path = Path.home() / 'lab/fleur-interrupted-guest.py'
    expected = sys.argv[2]
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o022 or not 0 < info.st_size <= 131072:
            raise RuntimeError('Unsafe conformance helper')
        body = os.read(fd, info.st_size + 1)
        if len(body) != info.st_size or hashlib.sha256(body).hexdigest() != expected or (path.lstat().st_dev, path.lstat().st_ino) != (info.st_dev, info.st_ino):
            raise RuntimeError('Conformance helper source differs')
    finally:
        os.close(fd)
    helper = types.ModuleType('qualified_interruption_supervisor')
    helper.__file__ = str(path)
    sys.modules[helper.__name__] = helper
    exec(compile(body, str(path), 'exec'), helper.__dict__)
    helper.guest.GUEST_DEADLINE = time.monotonic() + 30
    nonce, resume, binding, recorded = helper.guest.parse_recorded_guest_invocation(sys.argv[3:])
    if resume is not None or binding is None or not recorded:
        raise RuntimeError('Original complete recorded-helper owned guest binding required')
    helper.guest.verify_owned_binding(binding)
    results = [family(helper, kind) for kind in ('delayed', 'rapid', 'nested', 'survivor')]
    unexpected = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(60)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        try:
            helper.interrupt_setup('once')
        except RuntimeError as error:
            if 'not idle' not in str(error):
                raise
        else:
            raise RuntimeError('An unexpected direct child failed to prevent CLI launch')
        if helper.descendants(helper.process_table(), os.getpid()) != {unexpected.pid}:
            raise RuntimeError('Unexpected-child refusal launched additional work')
        results.append({'case': 'unexpected-direct-child', 'expectedRefusal': True, 'noCliLaunch': True})
    finally:
        unexpected.kill()
        unexpected.wait(timeout=2)
    if helper.descendants(helper.process_table(), os.getpid()):
        raise RuntimeError('Conformance left child processes behind')
    print(json.dumps({'formatVersion': 1, 'scope': 'owned-interruption-supervisor-conformance', 'ok': True, 'runtimeAdmission': False, 'humanConsentProof': False, 'helperSha256': expected, 'cases': results}, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'formatVersion': 1, 'scope': 'owned-interruption-supervisor-conformance', 'ok': False, 'runtimeAdmission': False, 'humanConsentProof': False, 'error': str(error)}, separators=(',', ':')))
        sys.exit(4)

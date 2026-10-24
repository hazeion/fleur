"""Run the unchanged VM pidfd guard and retain its actual bounded records."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time

sys.path.insert(0,'/controller/runtime-probe')
from worker_deadline import ROOT_GUARD


def main():
    if len(sys.argv)!=4 or os.geteuid()!=0:raise RuntimeError('fixed guard request required')
    cid,pid,end=sys.argv[1:]
    if not re.fullmatch('[a-f0-9]{64}',cid) or not re.fullmatch('[1-9][0-9]{0,9}',pid) or not 1<int(pid)<2**31:raise RuntimeError('fixed worker identity required')
    deadline=float(end)
    if not math.isfinite(deadline) or not 0<deadline-time.monotonic()<=30:raise RuntimeError('original VM deadline required')
    binding=json.loads(os.environ['FLEUR_DESKTOP_BINDING'])
    boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    if binding['guardianId'] is not None or binding['bootId']!=boot:raise RuntimeError('guardian VM binding changed')
    path='/tmp/guard-'+cid+'.jsonl'
    journal=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    def record(value):
        data=(json.dumps(value,separators=(',',':'))+'\n').encode()
        if len(data)>2048 or os.write(journal,data)!=len(data):raise RuntimeError('guard journal failed')
        os.fsync(journal)
    record({'kind':'binding','nonce':binding['nonce'],'bootId':boot,'containerId':cid,'pid':int(pid),'deadlineVmMonotonic':deadline,'rootGuardSha256':hashlib.sha256(ROOT_GUARD.encode()).hexdigest()})
    child=None;selector=selectors.DefaultSelector();buffer=bytearray();records=0
    try:
        child=subprocess.Popen(['/usr/bin/python3','-I','-c',ROOT_GUARD,cid,pid,end],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        selector.register(0,selectors.EVENT_READ,'control');selector.register(child.stdout,selectors.EVENT_READ,'guard')
        control=True;output=True
        while output:
            if time.monotonic()>deadline+1:raise RuntimeError('guard transport retirement deadline')
            for key,_ in selector.select(.02):
                block=os.read(key.fd,1024)
                if key.data=='control':
                    # Any byte/EOF retires the one bound worker, exactly as ROOT_GUARD.
                    selector.unregister(0);control=False
                    if block:child.stdin.write(block[:1]);child.stdin.flush()
                    child.stdin.close()
                elif not block:
                    selector.unregister(child.stdout);output=False
                else:
                    buffer.extend(block)
                    if len(buffer)>1024:raise RuntimeError('guard output bound')
                    while b'\n' in buffer:
                        line,_,rest=buffer.partition(b'\n');buffer=bytearray(rest)
                        records+=1
                        if records>2 or len(line)>512:raise RuntimeError('guard frame bound')
                        value=json.loads(line);record({'kind':'record','record':value})
                        try:
                            if os.write(1,line+b'\n')!=len(line)+1:raise RuntimeError('short guard write')
                        except BrokenPipeError:
                            pass  # Manager loss cannot cancel journal retention or VM supervision.
        if buffer:raise RuntimeError('guard output truncated')
        code=child.wait(timeout=max(.01,deadline+1-time.monotonic()))
        record({'kind':'retired','exitCode':code,'records':records})
        return code
    finally:
        if child is not None:
            if not child.stdin.closed:child.stdin.close()
            # Closing the guard's control pipe asks the unchanged guard to kill/confirm.
            try:child.wait(timeout=max(.01,deadline+.25-time.monotonic()))
            except subprocess.TimeoutExpired:
                # Refuse; the outer guardian remains alive for independent retirement.
                record({'kind':'error','category':'ROOT_GUARD_RETIREMENT_UNCONFIRMED'})
            child.stdout.close()
        selector.close();os.close(journal)

if __name__=='__main__':raise SystemExit(main())

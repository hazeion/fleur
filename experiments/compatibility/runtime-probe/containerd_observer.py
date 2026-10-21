"""Host-only, registered containerd init-exit evidence. Never validates worker output."""
from datetime import datetime
import json
import inspect
import math
import os
import re
import selectors
import subprocess
import time
from daemon_trace import parse_stacks, PREFIXES, STATES, NAME
from registration_canary import register_canary, retained_exit

# Reuse the existing bounded stack grammar inside the isolated root process.
ROOT_PARSER = ('import json,re\nINPUT_LIMIT=65536\nOUTPUT_LIMIT=4096\n'
               +'PREFIXES='+repr(PREFIXES)+'\nSTATES='+repr(STATES)+'\nNAME='+repr(NAME)+'\n'
               +inspect.getsource(parse_stacks)+"\n"+inspect.getsource(retained_exit)+"\n"+inspect.getsource(register_canary))

# The privileged supervisor owns the child process group. Control EOF and the
# original absolute time allowance both cause root to terminate and reap it.
SUPERVISOR = ROOT_PARSER + r'''
import os,selectors,secrets,signal,stat,subprocess,sys,time
ctr,address,namespace,absolute_deadline=sys.argv[1:]
if os.geteuid()!=0: sys.exit(71)
s=os.stat(ctr); sock=os.stat(address)
if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022 or not stat.S_ISSOCK(sock.st_mode) or sock.st_uid!=0: sys.exit(72)
for path in (ctr,address):
    parent=os.path.dirname(os.path.realpath(path))
    while parent!='/':
        info=os.stat(parent)
        if info.st_uid!=0 or info.st_mode&0o022: sys.exit(72)
        parent=os.path.dirname(parent)
deadline=float(absolute_deadline)
if time.monotonic()>=deadline: sys.exit(75)
errors=0
stdout_bytes=0
diagnostic=False
phase=0
control_bytes=0
pre_retirement_returncode=None
raw_stack=bytearray()
p=None
selector=None
canary_name='fleur-observer-'+secrets.token_hex(16)
canary_owner=secrets.token_hex(16)
def record_error(chunk):
    global errors
    errors+=len(chunk)
    if errors>65536: raise OSError('observer-error-bound')
def forward(chunk):
    global stdout_bytes
    stdout_bytes+=len(chunk)
    if os.write(1,chunk)!=len(chunk): raise OSError('observer-output')
try:
    os.set_blocking(1,False)
    selector=selectors.DefaultSelector()
    selector.register(sys.stdin,selectors.EVENT_READ,'control')
    p=subprocess.Popen([ctr,'--address',address,'--namespace',namespace,'events','topic=="/tasks/start"','topic=="/tasks/exit"','topic=="/namespaces/update",namespace=="'+canary_name+'"'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS':'true'})
    selector.register(p.stdout,selectors.EVENT_READ,'out')
    selector.register(p.stderr,selectors.EVENT_READ,'err')
    phase=1
    while time.monotonic()<deadline:
        if retained_exit(p) is not None: phase=2; break
        stop=False
        for key,_ in selector.select(min(0.025,max(0,deadline-time.monotonic()))):
            chunk=os.read(key.fileobj.fileno(),4096)
            if key.data=='control':
                control_bytes+=len(chunk)
                if chunk==b'prepare-registration\n':
                    result=register_canary(selector,p,ctr,address,namespace,deadline,canary_name,canary_owner,forward,record_error)
                    os.write(1,b'[observer-registration] '+json.dumps(result).encode()+b'\n')
                    if not result['ready']: stop=True
                    break
                diagnostic=chunk==b'diagnose-registration\n'
                phase=4 if diagnostic else 3
                stop=True; break
            if not chunk: selector.unregister(key.fileobj)
            elif key.data=='out':
                stdout_bytes+=len(chunk)
                try:
                    if os.write(1,chunk)!=len(chunk): stop=True; break
                except BlockingIOError: stop=True; break
            elif key.data=='err':
                errors+=len(chunk)
                if errors>65536: stop=True; break
            # Raw ctr diagnostics must never reach artifact logs.
        if stop: break
    # At the operation deadline only failure cleanup may continue. Give the
    # failed caller a bounded control window before retiring the root child.
    if not diagnostic and time.monotonic()>=deadline and retained_exit(p) is None:
        phase=5
        control_deadline=time.monotonic()+0.2
        while time.monotonic()<control_deadline:
            for key,_ in selector.select(max(0,control_deadline-time.monotonic())):
                if key.data=='control':
                    control=os.read(key.fileobj.fileno(),4096)
                    control_bytes+=len(control)
                    diagnostic=control==b'diagnose-registration\n'
                    phase=7 if diagnostic else 6
                    control_deadline=0
                    break
    if phase==5: phase=8
finally:
    try:
        if p is not None:
            pre_retirement_returncode=retained_exit(p)
            try:
                if diagnostic and retained_exit(p) is None:
                    try: os.kill(p.pid,signal.SIGQUIT)
                    except ProcessLookupError: pass
                    capture_deadline=time.monotonic()+0.2
                    os.set_blocking(p.stderr.fileno(),False)
                    while time.monotonic()<capture_deadline and len(raw_stack)<65536:
                        try:
                            chunk=os.read(p.stderr.fileno(),min(4096,65536-len(raw_stack)))
                            if not chunk: break
                            raw_stack.extend(chunk)
                        except BlockingIOError: time.sleep(0.005)
            finally:
                retained_exit(p) # retire a child that already exited during trace capture
                try:
                    if p.returncode is None:os.killpg(p.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                try: p.wait(timeout=0.4 if diagnostic else 0.75) # failure-only reap grace, never operation success
                except subprocess.TimeoutExpired: sys.exit(74)
    finally:
        if p is not None:
            # Count any final stderr bytes without retaining raw diagnostics.
            try:
                os.set_blocking(p.stderr.fileno(),False)
                while errors<65536:
                    chunk=os.read(p.stderr.fileno(),min(4096,65536-errors))
                    if not chunk: break
                    errors+=len(chunk)
            except (OSError,ValueError): pass
            p.stdout.close();p.stderr.close()
        if selector is not None: selector.close()
if diagnostic:
    normalized=[]
    for line in raw_stack.decode('utf-8','replace').splitlines():
        header=re.fullmatch(r'goroutine ([0-9]+)(?: gp=0x[0-9a-f]+ m=(?:nil|[0-9]+ mp=0x[0-9a-f]+))? \[([^\]]{1,100})\]:',line)
        normalized.append('goroutine '+header[1]+' ['+header[2]+']:' if header else line)
    result=parse_stacks('\n'.join(normalized))
    result.update(outcome='captured' if result['goroutines'] else 'empty-stack',
                  phase='quit-after-registration-failure',ctr_stdout_bytes=stdout_bytes,
                  ctr_stderr_bytes=errors+len(raw_stack),child_returncode=p.returncode,
                  snapshot_may_be_partial=True)
    while len(json.dumps(result).encode())>6000 and result['goroutines']:
        result['goroutines'].pop();result['truncated']=True
    try: os.write(1,b'[observer-diagnostic] '+json.dumps(result).encode()+b'\n')
    except BlockingIOError: sys.exit(73)
status={'phase':phase,'pre_retirement_returncode':pre_retirement_returncode,
        'child_returncode':p.returncode,'ctr_stdout_bytes':stdout_bytes,
        'ctr_stderr_bytes':errors+len(raw_stack),'control_bytes':control_bytes,
        'diagnostic_requested':diagnostic}
try: os.write(1,b'[observer-status] '+json.dumps(status).encode()+b'\n')
except BlockingIOError: sys.exit(73)
try: os.write(1,b'[observer-reaped]\n')
except BlockingIOError: sys.exit(73)
'''


class ObserverUnverified(RuntimeError):
    def __init__(self, category, observations=None):
        self.category = category
        self.observations = dict(observations or {})
        super().__init__('containerd exit evidence unverified ('+category+')')


def _budget(value):
    if type(value) not in (int,float) or not math.isfinite(value) or value <= 0:
        raise ObserverUnverified('budget-invalid')
    return value


def _object(pairs):
    result = {}
    for key,value in pairs:
        if key in result: raise ValueError('duplicate key')
        result[key] = value
    return result


class ContainerdObserver:
    """Prepare before Docker run; bind an already host-verified owned CID/PID."""
    def __init__(self, ctr, address, namespace, timeout, launcher=None, *, host_binding=None):
        self.deadline = time.monotonic()+_budget(timeout)
        self.host_binding=host_binding
        if host_binding is not None:
            from privileged_control import HostDaemonBinding
            if type(host_binding) is not HostDaemonBinding:raise ValueError('typed host daemon binding required')
            host_binding.verify_operation(ctr,address,namespace,self.deadline-time.monotonic())
        if (type(ctr) is not str or not os.path.isabs(ctr)
                or type(address) is not str or not os.path.isabs(address)
                or namespace != 'moby'):
            raise ObserverUnverified('arguments-invalid')
        self.namespace = namespace
        self.container = None
        self.pid = None
        self.completed = False
        self.start_seconds = None
        self.start_nanos = 0
        self.events = 0
        self.discarded_exec_exits = 0
        self.phase = 'prepared'
        self.registration_failed = False
        self.diagnostic_requested = False
        self.registration_diagnostic = None
        self.root_supervisor = None
        self.registration = None
        self.ready_requested = False
        self.closed = False
        self.cleanup_verified = False
        self.cleanup_late = False
        self.buffer = bytearray()
        self.total = 0
        self.reaped = False
        command = launcher if launcher is not None else [
            '/usr/bin/sudo','-n','/usr/bin/python3','-I','-u','-c',SUPERVISOR,
            ctr,address,namespace,str(self.deadline)]
        if host_binding is not None:
            from privileged_control import ROOT_BINDING_SOURCE
            owned_source=SUPERVISOR.replace('ctr,address,namespace,absolute_deadline=sys.argv[1:]','ctr,address,namespace,absolute_deadline=sys.argv[1:5]\npayload=sys.argv[5];binding=json.loads(sys.argv[6])\ndef verify_owned(limit):\n    verify_root_binding(payload,binding,min(limit,float(absolute_deadline),json.loads(payload)["deadlineMonotonic"]),ctr,address,namespace)')
            owned_source=owned_source.replace('def record_error(chunk):',"def verify_retained_endpoint(limit):\n    if time.monotonic()>=limit or daemon_identity(address,ctr)!=binding['identity']:raise ValueError('retained cleanup endpoint changed')\n    if time.monotonic()>=limit:raise ValueError('cleanup validation expired')\ndef record_error(chunk):")
            owned_source=owned_source.replace('    p=subprocess.Popen([ctr,','    verify_owned(deadline)\n    p=subprocess.Popen([ctr,',1)
            owned_source=owned_source.replace('canary_owner,forward,record_error)','canary_owner,forward,record_error,verify_owned,verify_retained_endpoint)')
            owned_source=owned_source.replace('                    try: os.kill(p.pid,signal.SIGQUIT)','                    verify_owned(deadline)\n                    try: os.kill(p.pid,signal.SIGQUIT)')
            command=['/usr/bin/sudo','-n','/usr/bin/python3','-I','-u','-c',ROOT_BINDING_SOURCE+owned_source,ctr,address,namespace,str(self.deadline),*host_binding.root_arguments(self.deadline)]
        try:
            self.selector = selectors.DefaultSelector()
        except OSError:
            raise ObserverUnverified('observer-start') from None
        try:
            self.process = subprocess.Popen(command,stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        except OSError:
            self.selector.close()
            raise ObserverUnverified('observer-start') from None
        try:
            self.selector.register(self.process.stdout,selectors.EVENT_READ)
        except (OSError,ValueError):
            self.process.stdin.close()
            try: self.process.wait(timeout=1)
            except subprocess.TimeoutExpired: pass
            finally:
                self.selector.close()
                self.process.stdout.close()
            raise ObserverUnverified('observer-start-cleanup') from None

    def ready(self, remaining):
        """Prove subscription by owned echo and retire its namespace before launch."""
        if self.ready_requested or self.container is not None:
            raise ObserverUnverified('readiness-order')
        self.ready_requested=True
        limit=self._limit(remaining)
        if self.host_binding is not None:self.host_binding.verify(limit-time.monotonic())
        self.process.stdin.write(b'prepare-registration\n')
        self.process.stdin.flush()
        while True:
            line=self._line(limit)
            if not self._registration(line): continue
            value=self.registration
            if not value['ready'] or not value['cleanup_verified'] or value['category']!='verified':
                raise ObserverUnverified('readiness-unverified',value)
            if time.monotonic()>=limit: raise ObserverUnverified('event-timeout')
            self.phase='ready'
            return {'ready':True}

    def _registration(self,line):
        if not line.startswith(b'[observer-registration] '): return False
        try:
            value=json.loads(line[24:],object_pairs_hook=_object)
            if type(value) is not dict or set(value)!={'ready','cleanup_verified','category','command_count','duration_ms'}: raise ValueError
            if type(value['ready']) is not bool or type(value['cleanup_verified']) is not bool: raise ValueError
            if type(value['category']) is not str or value['category'] not in {'verified','canary-unverified','canary-timeout','canary-cancelled',
                    'canary-output-bound','canary-event-bound','canary-event-invalid','canary-subscriber-ended',
                    'canary-command','canary-ownership','canary-preexisting','canary-cleanup'}: raise ValueError
            for key in ('command_count','duration_ms'):
                if type(value[key]) is not int or not 0<=value[key]<=2**31: raise ValueError
            self.registration=value
        except (ValueError,UnicodeError):
            raise ObserverUnverified('readiness-invalid') from None
        return True

    def _status(self, line):
        if not line.startswith(b'[observer-status] '): return False
        try:
            value=json.loads(line[18:],object_pairs_hook=_object)
            expected={'phase','pre_retirement_returncode','child_returncode',
                      'ctr_stdout_bytes','ctr_stderr_bytes','control_bytes','diagnostic_requested'}
            if type(value) is not dict or set(value)!=expected: raise ValueError
            if type(value['phase']) is not int or not 0<=value['phase']<=8: raise ValueError
            for key in ('pre_retirement_returncode','child_returncode'):
                if value[key] is not None and (type(value[key]) is not int or not -127<=value[key]<=255): raise ValueError
            for key in ('ctr_stdout_bytes','ctr_stderr_bytes','control_bytes'):
                if type(value[key]) is not int or not 0<=value[key]<=2**31: raise ValueError
            if type(value['diagnostic_requested']) is not bool: raise ValueError
            self.root_supervisor=value
            return True
        except (ValueError,UnicodeError):
            raise ObserverUnverified('supervisor-status-invalid') from None

    def _limit(self, remaining):
        return min(self.deadline,time.monotonic()+_budget(remaining))

    def _line(self, limit):
        while True:
            if time.monotonic() >= limit: raise ObserverUnverified('event-timeout')
            if b'\n' in self.buffer:
                line,_,tail=self.buffer.partition(b'\n')
                if len(line)>4096 or self.total>65536: raise ObserverUnverified('stream-bound')
                self.buffer=bytearray(tail)
                if self._status(line): continue
                if line == b'[observer-reaped]':
                    self.reaped = True
                    raise ObserverUnverified('stream-ended')
                return line
            if len(self.buffer)>4096 or self.total>65536:
                raise ObserverUnverified('stream-bound')
            ready=self.selector.select(max(0,limit-time.monotonic()))
            if not ready: raise ObserverUnverified('event-timeout')
            chunk=os.read(self.process.stdout.fileno(),4096)
            if not chunk: raise ObserverUnverified('stream-ended')
            self.total += len(chunk)
            self.buffer.extend(chunk)

    def _event(self, limit):
        line=self._line(limit)
        try:
            text=line.decode('utf-8')
            prefix,payload=text.split(' {',1)
            # ctr prints Go's time.Time, namespace and topic, followed by JSON.
            stamp,namespace,topic=prefix.rsplit(' ',2)
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})? [+-]\d{4} [A-Za-z0-9_+/-]+',stamp):
                raise ValueError('timestamp')
            # Parse calendar/timezone, not merely its textual shape.
            clock,offset,_=stamp.rsplit(' ',2)
            whole,_,fraction=clock.partition('.')
            stamp_seconds=int(datetime.strptime(whole+' '+offset,'%Y-%m-%d %H:%M:%S %z').timestamp())
            stamp_nanos=int((fraction+'0'*9)[:9]) if fraction else 0
            event=json.loads('{'+payload,object_pairs_hook=_object)
            if type(event) is not dict: raise ValueError('object')
            self.events += 1
            return namespace,topic,event,stamp_seconds,stamp_nanos
        except (ValueError,UnicodeError):
            raise ObserverUnverified('event-malformed') from None

    def bind(self, container, host_pid, remaining):
        if (self.container is not None or type(container) is not str
                or not re.fullmatch('[0-9a-f]{64}',container)
                or type(host_pid) is not int or not 0 < host_pid <= 2**32-1):
            raise ObserverUnverified('identity-invalid')
        limit=self._limit(remaining)
        if self.host_binding is not None:self.host_binding.verify(limit-time.monotonic())
        try:
            while True:
                namespace,topic,event,seconds,nanos=self._event(limit)
                if namespace != self.namespace or event.get('container_id') != container: continue
                if topic != '/tasks/start': raise ObserverUnverified('start-unobserved')
                if set(event) != {'container_id','pid'} or type(event['pid']) is not int or event['pid'] != host_pid:
                    raise ObserverUnverified('start-identity')
                self.container,self.pid = container,host_pid
                self.start_seconds,self.start_nanos = seconds,nanos
                self.phase = 'bound'
                return {'registered':True}
        except ObserverUnverified:
            self.registration_failed = True
            raise

    def diagnose_registration(self):
        if not self.registration_failed or self.container is not None or self.diagnostic_requested:
            raise ObserverUnverified('diagnostic-order')
        self.diagnostic_requested = True
        if self.host_binding is not None:self.host_binding.verify(self.deadline-time.monotonic())
        try:
            self.process.stdin.write(b'diagnose-registration\n')
            self.process.stdin.flush()
        except (OSError,ValueError):
            raise ObserverUnverified('diagnostic-unavailable') from None
        return {'requested':True}

    def completion(self, remaining):
        if self.container is None or self.completed: raise ObserverUnverified('completion-order')
        limit=self._limit(remaining)
        while True:
            namespace,topic,event,seconds,nanos=self._event(limit)
            if namespace != self.namespace or event.get('container_id') != self.container: continue
            if topic != '/tasks/exit': raise ObserverUnverified('event-order')
            status=event.get('exit_status',0) # pinned protobuf omitempty encodes zero by omission
            exited=event.get('exited_at')
            if (not {'container_id','id','pid','exited_at'} <= set(event)
                    or set(event)-{'container_id','id','pid','exit_status','exited_at'}
                    or type(event['id']) is not str or not re.fullmatch('[0-9a-f]{64}',event['id'])
                    or type(event['pid']) is not int or not 0 < event['pid'] <= 2**32-1
                    or type(status) is not int or not 0 <= status <= 2**32-1
                    or type(exited) is not dict or set(exited)-{'seconds','nanos'}
                    or type(exited.get('seconds')) is not int or not 0 < exited['seconds'] <= 253402300799
                    or type(exited.get('nanos',0)) is not int or not 0 <= exited.get('nanos',0) < 1000000000):
                raise ObserverUnverified('exit-invalid')
            if not ((self.start_seconds,self.start_nanos) <= (exited['seconds'],exited.get('nanos',0)) <= (seconds,nanos)):
                raise ObserverUnverified('exit-time-invalid')
            if event['id'] != self.container:
                # Host bootstrap audits use Docker exec in the same container.
                # Their well-formed exits cannot supply init completion proof.
                if event['pid'] == self.pid: raise ObserverUnverified('exit-invalid')
                self.discarded_exec_exits += 1
                continue
            if event['pid'] != self.pid: raise ObserverUnverified('exit-invalid')
            if status != 0: raise ObserverUnverified('nonzero-exit')
            if time.monotonic() >= limit: raise ObserverUnverified('event-timeout')
            self.completed=True
            self.phase = 'completed'
            return {'completed':True,'exit_code':0,'source':'containerd-init-exit'}

    def snapshot(self):
        return {'phase':self.phase,'event_count':self.events,'stdout_bytes':self.total,
                'reaped':self.reaped,'cleanup_verified':self.cleanup_verified,
                'discarded_exec_exits':self.discarded_exec_exits,
                'registration_diagnostic':self.registration_diagnostic,
                'root_supervisor':self.root_supervisor,'registration':self.registration}

    def close(self, remaining=None):
        """Reap on failure too; a separate 1s cleanup grace never grants success."""
        if self.closed:
            if self.cleanup_late:
                raise ObserverUnverified('observer-cleanup-deadline',self.snapshot())
            if not self.cleanup_verified:
                raise ObserverUnverified('observer-cleanup',self.snapshot())
            return True
        now=time.monotonic()
        success_limit=self.deadline
        if remaining is not None:
            if type(remaining) not in (int,float) or not math.isfinite(remaining):
                remaining=0
            success_limit=min(success_limit,now+remaining)
        limit=success_limit
        grace=False
        self.process.stdin.close() # root supervisor owns child kill and reap
        try:
            while not self.reaped:
                while b'\n' in self.buffer:
                    line,_,tail=self.buffer.partition(b'\n')
                    self.buffer=bytearray(tail)
                    self._status(line)
                    self._registration(line)
                    if line.startswith(b'[observer-diagnostic] ') and self.diagnostic_requested:
                        try: self.registration_diagnostic=json.loads(line[22:])
                        except (ValueError,UnicodeError): self.registration_diagnostic={'outcome':'invalid-diagnostic'}
                    if line == b'[observer-reaped]': self.reaped=True; break
                if self.reaped: break
                if time.monotonic()>=limit:
                    if grace: raise ObserverUnverified('observer-cleanup')
                    grace=True
                    limit=time.monotonic()+1
                if not self.selector.select(max(0,limit-time.monotonic())): continue
                chunk=os.read(self.process.stdout.fileno(),4096)
                if not chunk: raise ObserverUnverified('observer-cleanup')
                self.buffer.extend(chunk)
                if len(self.buffer)>8192: self.buffer=self.buffer[-4096:]
            try:
                returncode=self.process.wait(timeout=max(0,limit-time.monotonic()))
            except subprocess.TimeoutExpired:
                if grace: raise
                grace=True
                limit=time.monotonic()+1
                returncode=self.process.wait(timeout=1)
            if returncode != 0: raise ObserverUnverified('observer-cleanup')
            self.closed=True
            self.cleanup_verified=(not self.ready_requested or self.registration is not None and self.registration['cleanup_verified'])
            if not self.cleanup_verified:
                self.phase='closed-cleanup-unverified'
                raise ObserverUnverified('observer-cleanup',self.snapshot())
            self.cleanup_late=grace or time.monotonic()>=success_limit
            self.phase='closed-after-deadline' if self.cleanup_late else 'closed'
            if self.cleanup_late:
                raise ObserverUnverified('observer-cleanup-deadline',self.snapshot())
            return True
        except (subprocess.TimeoutExpired,OSError,ObserverUnverified) as error:
            if isinstance(error,ObserverUnverified) and error.category=='observer-cleanup-deadline': raise
            raise ObserverUnverified('observer-cleanup',self.snapshot()) from None
        finally:
            if self.closed or self.process.poll() is not None:
                self.selector.close()
                self.process.stdout.close()

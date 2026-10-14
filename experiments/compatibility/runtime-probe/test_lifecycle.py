import json, os
from pathlib import Path
import tempfile, unittest, time, threading
import subprocess
from unittest.mock import patch
from types import SimpleNamespace
from lifecycle import run_lifecycle
# Shell avoids unrelated cold Python imports consuming the two-second fixture budget.
FAKE = r'''#!/bin/sh
set -eu
root=${LIFECYCLE_FAKE_ROOT:-${0%/*}}
operation=$1
shift
name=
mode=
owner=owned
case "$operation" in
run)
 while [ "$#" -gt 0 ]; do
  case "$1" in
   --name) name=$2; shift ;;
   --label) owner=${2#*=}; shift ;;
  esac
  mode=$1
  shift
 done
 case "$name" in owned-busy-[01]|owned-healthy-[01]) ;; *) exit 2 ;; esac
 if [ "${LIFECYCLE_FOREIGN:-}" ]; then owner=foreign; fi
 case "$owner" in owned|foreign) ;; *) exit 2 ;; esac
 printf '{"Name":"/%s","Image":"sha256:fixture","State":{"Running":true,"ExitCode":0,"FinishedAt":"0001-01-01T00:00:00Z"},"Config":{"Labels":{"fleur.compatibility.runtime-owner":"%s"}}}\n' "$name" "$owner" > "$root/$name"
 printf '%s\n' "$LIFECYCLE_STARTUP"
 IFS= read -r startup
 [ "$startup" = startup:approved ] || exit 3
 printf '%s\n' "$LIFECYCLE_REQUEST"
 IFS= read -r ack
 if [ "$mode" = busy ]; then
  if [ "${LIFECYCLE_DELAY_LOOP:-}" ]; then sleep "$LIFECYCLE_DELAY_LOOP"; fi
  printf 'entered\n' > "$root/$name-loop"
  printf '[compat-lifecycle] cpu-loop\n' >&2
  exec sleep 30
 else
  number=${name##*-}
  if [ ! -f "$root/owned-busy-$number-loop" ]; then printf '%s\n' "$name" > "$root/healthy-too-early"; fi
  if [ ! "${LIFECYCLE_STALE_HEALTHY_STATE:-}" ]; then
   printf '{"Name":"/%s","Image":"sha256:fixture","State":{"Running":false,"ExitCode":0,"FinishedAt":"2026-10-13T00:00:01Z"},"Config":{"Labels":{"fleur.compatibility.runtime-owner":"%s"}}}\n' "$name" "$owner" > "$root/$name"
  fi
  printf '%s\n' "$LIFECYCLE_EVIDENCE"
  if [ "${LIFECYCLE_KEEP_HEALTHY_OPEN:-}" ]; then
   exec sleep 30
  fi
 fi
 ;;
wait)
 case "$1" in
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) name=owned-healthy-0 ;;
  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) name=owned-healthy-1 ;;
  cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc) name=owned-busy-0 ;;
  dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd) name=owned-busy-1 ;;
  *) exit 3 ;;
 esac
 while :; do
  IFS= read -r state < "$root/$name"
  case "$state" in *'"Running":true'*) sleep .02 ;; *) break ;; esac
 done
 printf '0\n'
 ;;
inspect) IFS= read -r state < "$root/$1"; printf '%s\n' "$state" ;;
kill)
 shift
 name=$1
 printf '%s\n' "$name" > "$root/kill-attempt"
 sleep "${LIFECYCLE_KILL_DELAY:-0}"
 if [ ! "${LIFECYCLE_NO_KILL:-}" ]; then
  sed 's/"Running":true/"Running":false/;s/"ExitCode":0/"ExitCode":137/;s/"FinishedAt":"0001-01-01T00:00:00Z"/"FinishedAt":"2026-10-13T00:00:01Z"/' "$root/$name" > "$root/$name.tmp"
  mv "$root/$name.tmp" "$root/$name"
  if [ "${LIFECYCLE_KEEP_HEALTHY_OPEN:-}" ]; then
   sed 's/"FinishedAt":"0001-01-01T00:00:00Z"/"FinishedAt":"2026-10-13T00:00:01Z"/' "$root/$name" > "$root/$name.tmp"
   mv "$root/$name.tmp" "$root/$name"
   exec sleep 30
  fi
 fi
 printf '%s\n' "$name"
 ;;
rm)
 shift
 name=$1
 if [ "${LIFECYCLE_CLEANUP_FAILURE:-}" ] && [ "$name" = owned-healthy-0 ]; then exit 4; fi
 rm -f "$root/$name" "$root/$name-loop"
 printf '%s\n' "$name"
 ;;
*) exit 2 ;;
esac
'''
class LifecycleTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.cli=self.root/'docker';self.cli.write_text(FAKE);self.cli.chmod(0o700)
  from report import CONTROLS
  from protocol import REQUEST
  self.rows=[{'pid':1,'no_new_privs':1,'seccomp':2,'seccomp_filters':1},{'pid':2,'no_new_privs':1,'seccomp':2,'seccomp_filters':1}]
  e={'kind':'runtime-evidence','architecture':'amd64','negative_controls':CONTROLS['amd64'],'install':0,'html':'<p>restricted render</p>','main':[-1]*24,'thread':-1,'application_open':True,'cgroups':{'cpu':'100000 100000','memory':'536870912','pids':'64'},'descriptors_closed':True,'broker_reply':'registered:Squat','host_canary_absent':True,'event_probe':0,'event_negatives':[-1]*12}
  startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
  self.env=dict(os.environ,LIFECYCLE_STARTUP=json.dumps(startup),LIFECYCLE_FAKE_ROOT=str(self.root),LIFECYCLE_REQUEST=json.dumps(REQUEST),LIFECYCLE_EVIDENCE=json.dumps(e))
 def tearDown(self):self.tmp.cleanup()
 def observe(self,name,owner,inventory):
  data=json.loads((self.root/name).read_text())
  if data['Config']['Labels']['fleur.compatibility.runtime-owner']!=owner:raise RuntimeError('unowned worker')
  return {'configuration':{'container_id':(('c' if name.endswith('-0') else 'd') if '-busy-' in name else ('a' if name.endswith('-0') else 'b'))*64,'host_init_pid':47},'host_threads':self.rows,'configuration_verified':True,'descriptor_audit':{'passed':True,'category':'verified','descriptor_count':len(inventory)}}
 def run_probe(self,timeout=2,containerd_control=None):
  parent=self
  class FixtureDeadline:
   # Explicit host process boundary for fake Docker state. The separate guard
   # tests kill real same-user child processes; native CI uses actual pidfds.
   def __init__(self,cid,pid,deadline):
    self.name='owned-busy-'+str({'c':0,'d':1}[cid[0]])
    self.deadline=deadline;self.done=False;self.cancel=threading.Event();self.error=None;self.result=None
    self.thread=threading.Thread(target=self.enforce);self.thread.start()
   def enforce(self):
    cancelled=self.cancel.wait(max(0,self.deadline-time.monotonic()))
    requested=time.monotonic()
    try:
     (parent.root/'kill-attempt').write_text(self.name+'\n')
     # The injected delay models a late physical stop, independently of CLI
     # loading. Native enforcement has no Docker CLI on its deadline path.
     time.sleep(float(parent.env.get('LIFECYCLE_KILL_DELAY','0')))
     path=parent.root/self.name;metadata=json.loads(path.read_text());state=metadata['State']
     if not parent.env.get('LIFECYCLE_NO_KILL'):
      state.update(Running=False,ExitCode=137,FinishedAt='2026-10-13T00:00:01Z')
      path.write_text(json.dumps(metadata,separators=(',',':'))+'\n')
     stopped=time.monotonic()
     if state['Running'] or (not cancelled and stopped>self.deadline+.25):raise RuntimeError('worker termination missed deadline')
     self.result={'outcome':'deadline','physical_exit_confirmed':True,'kill_lateness_ms':max(0,round(1000*(requested-self.deadline))),
                  'physical_exit_lateness_ms':max(0,round(1000*(stopped-self.deadline))),'source':'fixture-process-boundary','guard_reaped':True}
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as error:self.error=error
    finally:self.done=True
   def completion(self):
    self.thread.join(timeout+6)
    if self.error:raise self.error
    if not self.done:raise RuntimeError('worker termination unverified')
    return self.result
   def close(self):
    self.cancel.set();self.thread.join(6)
    if not self.done:raise RuntimeError('worker deadline guard reap unverified')
  return run_lifecycle('sha256:fixture','owned','amd64',self.env,self.observe,timeout=timeout,docker=str(self.cli),containerd_control=containerd_control,deadline_factory=FixtureDeadline)
 def test_deadline_terminates_daemon_worker_and_preserves_healthy_worker(self):
  result=self.run_probe();self.assertTrue(result['passed']);self.assertEqual(len(result['repeats']),2)
  for row in result['repeats']:self.assertTrue(row['healthy_completed_while_busy_running']);self.assertEqual(row['terminated_exit'],137);self.assertEqual(row['deadline_seconds'],2)
  self.assertEqual(set(self.root.iterdir()),{self.cli,self.root/'kill-attempt'})
 def test_cli_termination_does_not_count_as_daemon_worker_termination(self):
  self.env['LIFECYCLE_NO_KILL']='1'
  with self.assertRaisesRegex(RuntimeError,'termination'):self.run_probe()
  self.assertEqual(set(self.root.iterdir()),{self.cli,self.root/'kill-attempt'})
 def test_late_worker_termination_is_not_accepted_as_on_time(self):
  self.env['LIFECYCLE_KILL_DELAY']='.5'
  with self.assertRaisesRegex(RuntimeError,'deadline|termination'):self.run_probe()
 def test_unverified_ownership_never_sends_daemon_kill(self):
  self.env['LIFECYCLE_FOREIGN']='1'
  with self.assertRaises(RuntimeError):self.run_probe()
  self.assertFalse((self.root/'kill-attempt').exists())
 def test_healthy_worker_starts_after_actual_busy_cpu_loop_entry(self):
  self.env['LIFECYCLE_DELAY_LOOP']='.7'
  # Ordering needs startup margin; strict deadline/termination cases keep 2 s.
  # Production native probes continue using 30 s and the same marker premise.
  result=self.run_probe(timeout=4)
  self.assertTrue(result['passed'])
  self.assertFalse((self.root/'healthy-too-early').exists())
 def test_healthy_timeout_retains_correct_stopped_daemon_state_before_cleanup(self):
  self.env['LIFECYCLE_KEEP_HEALTHY_OPEN']='1'
  with patch('lifecycle.OwnedWaiter',return_value=SimpleNamespace(completion=lambda r:{'completed':False},close=lambda:None)), self.assertRaises(subprocess.TimeoutExpired) as caught:self.run_probe()
  self.assertEqual(getattr(caught.exception,'worker_role',None),'healthy')
  self.assertEqual(caught.exception.worker_state['Running'],False)
  self.assertEqual(caught.exception.worker_state['ExitCode'],0)
  self.assertEqual(caught.exception.worker_state['FinishedAt'],'2026-10-13T00:00:01Z')
  self.assertIn('runtime-evidence',caught.exception.worker_diagnostics['stdout'])
  self.assertEqual(set(self.root.iterdir()),{self.cli,self.root/'kill-attempt'})
 def test_healthy_failure_cancels_busy_worker_without_waiting_deadline(self):
  started=time.monotonic()
  with patch('lifecycle.OwnedWaiter',return_value=SimpleNamespace(completion=lambda r:(_ for _ in ()).throw(RuntimeError('early healthy failure')),close=lambda:None)):
   with self.assertRaisesRegex(RuntimeError,'early healthy failure') as caught:self.run_probe(timeout=30)
  self.assertLess(time.monotonic()-started,3)
  self.assertTrue(caught.exception.deadline_guard_cleanup_verified)
  self.assertTrue(caught.exception.lifecycle_cleanup_verified)

 def test_cleanup_failure_preserves_original_healthy_error_and_observations(self):
  self.env['LIFECYCLE_CLEANUP_FAILURE']='1'
  with patch('lifecycle.OwnedWaiter',return_value=SimpleNamespace(completion=lambda r:(_ for _ in ()).throw(RuntimeError('completion observer fixture failure')),close=lambda:None)):
   with self.assertRaisesRegex(RuntimeError,'completion observer fixture failure') as caught:self.run_probe()
  self.assertEqual(caught.exception.worker_role,'healthy')
  self.assertIn('runtime-evidence',caught.exception.worker_diagnostics['stdout'])
  self.assertFalse(caught.exception.lifecycle_cleanup_verified)
  self.assertEqual(caught.exception.lifecycle_cleanup[0]['worker_role'],'healthy')
  self.assertEqual(caught.exception.lifecycle_cleanup[0]['outcome'],'removal-unverified')

 def test_init_exit_zero_can_pair_with_full_frame_before_docker_cleanup(self):
  self.env['LIFECYCLE_STALE_HEALTHY_STATE']='1'
  events=[];instances=[];parent=self
  class Observer:
   def __init__(self,ctr,address,namespace,timeout):
    self.index=len(instances);instances.append(self)
    parent.assertFalse((parent.root/f'owned-healthy-{self.index}').exists())
    events.append('prepared')
   def ready(self,*args):return {'ready':True}
   def bind(self,cid,pid,remaining):
    parent.assertEqual(cid,('a' if self.index==0 else 'b')*64);parent.assertEqual(pid,47)
    events.append('bound');return {'registered':True}
   def completion(self,remaining):
    parent.assertTrue(json.loads((parent.root/f'owned-healthy-{self.index}').read_text())['State']['Running'])
    events.append('exit');return {'completed':True,'exit_code':0,'source':'containerd-init-exit'}
   def snapshot(self):return {'phase':'completed','event_count':2,'stdout_bytes':100,'reaped':False}
   def close(self,remaining):parent.assertGreater(remaining,0);events.append('closed');return True
  control={'ctr':'/usr/bin/ctr','address':'/run/containerd/containerd.sock','namespace':'moby'}
  with patch('lifecycle.ContainerdObserver',Observer):result=self.run_probe(containerd_control=control)
  self.assertTrue(result['passed'])
  self.assertEqual(events,['prepared','bound','exit','closed']*2)
  for repeat in result['repeats']:
   self.assertTrue(repeat['healthy_completed_while_busy_running'])
   self.assertEqual(repeat['healthy_completion']['source'],'containerd-init-exit')
   self.assertEqual(repeat['deadline_seconds'],2)

 def test_kernel_exit_evidence_cannot_excuse_failed_owned_removal(self):
  self.env['LIFECYCLE_CLEANUP_FAILURE']='1'
  class Observer:
   def __init__(self,*args):pass
   def ready(self,*args):return {'ready':True}
   def bind(self,*args):return {'registered':True}
   def completion(self,*args):return {'completed':True,'exit_code':0,'source':'containerd-init-exit'}
   def close(self,*args):return True
  control={'ctr':'/usr/bin/ctr','address':'/run/containerd/containerd.sock','namespace':'moby'}
  with patch('lifecycle.ContainerdObserver',Observer),self.assertRaisesRegex(RuntimeError,'lifecycle owned worker cleanup incomplete') as caught:
   self.run_probe(containerd_control=control)
  self.assertFalse(caught.exception.lifecycle_cleanup_verified)
  self.assertEqual(caught.exception.lifecycle_cleanup[0]['outcome'],'removal-unverified')

if __name__=='__main__':unittest.main()

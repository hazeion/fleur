import json, os
from pathlib import Path
import tempfile, unittest, time, threading
import subprocess
from unittest.mock import patch
from types import SimpleNamespace
from lifecycle import run_lifecycle
# Shell avoids unrelated cold Python imports consuming the two-second fixture budget.
IMAGE='sha256:'+'e'*64
FAKE = r'''#!/bin/sh
set -eu
root=${LIFECYCLE_FAKE_ROOT:-${0%/*}}
operation=$1
shift
name=
mode=
owner=owned
identify() {
 case "$1" in
  owned-healthy-0|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) name=owned-healthy-0;cid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;mode=healthy ;;
  owned-healthy-1|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) name=owned-healthy-1;cid=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;mode=healthy ;;
  owned-busy-0|cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc) name=owned-busy-0;cid=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc;mode=busy ;;
  owned-busy-1|dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd) name=owned-busy-1;cid=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd;mode=busy ;;
  *) exit 2 ;;
 esac
}
record() {
 if [ "${LIFECYCLE_RECORD_EVENTS:-}" ]; then printf '%s:%s\n' "$1" "$name" >> "$root/events"; fi
}
write_state() {
 {
 if [ "$1" = exited ] && [ "${LIFECYCLE_STATE_PUBLISH_DELAY:-}" ]; then sleep .1; fi
 printf '{"Id":"%s","Name":"/%s","Image":"%s","State":{"Status":"%s","Pid":%s,"Running":%s,"ExitCode":0,"FinishedAt":"%s"},"Config":{"Labels":{"fleur.compatibility.runtime-owner":"%s"}}}\n' "$cid" "$name" "$LIFECYCLE_IMAGE" "$1" "$2" "$3" "$4" "$owner"
 } > "$root/$name.$$.tmp"
 mv "$root/$name.$$.tmp" "$root/$name"
}
provision() {
 if [ "${LIFECYCLE_FOREIGN:-}" ]; then owner=foreign; fi
 case "$owner" in owned|foreign) ;; *) exit 2 ;; esac
 if [ "${LIFECYCLE_REFUSE_CREATE_DURING_BUSY:-}" ] && [ "$mode" = healthy ] && [ -f "$root/owned-busy-${name##*-}-loop" ]; then exit 7; fi
 if [ "${LIFECYCLE_CREATE_DELAY:-}" ]; then sleep "$LIFECYCLE_CREATE_DELAY"; fi
 write_state created 0 false 0001-01-01T00:00:00Z
 record create
 if [ "${LIFECYCLE_FAIL_PREPARE_HEALTHY:-}" ] && [ "$mode" = healthy ]; then exit 7; fi
 if [ "${LIFECYCLE_FAIL_PREPARE_BUSY:-}" ] && [ "$mode" = busy ]; then exit 7; fi
}
launch() {
 record start
 if [ "$mode" = healthy ] && [ ! -f "$root/owned-busy-${name##*-}-loop" ]; then printf '%s\n' "$name" > "$root/healthy-too-early"; fi
 write_state running 47 true 0001-01-01T00:00:00Z
 if [ "$mode" != busy ] && [ "${LIFECYCLE_STALL_HEALTHY_STARTUP:-}" ]; then exec sleep 30; fi
 printf '%s\n' "$LIFECYCLE_STARTUP"
 IFS= read -r startup
 [ "$startup" = startup:approved ] || exit 3
 record approved
 printf '%s\n' "$LIFECYCLE_REQUEST"
 IFS= read -r ack
 if [ "$mode" = busy ]; then
  if [ "${LIFECYCLE_DELAY_LOOP:-}" ]; then sleep "$LIFECYCLE_DELAY_LOOP"; fi
  printf 'entered\n' > "$root/$name-loop"
  if [ ! "${LIFECYCLE_NO_HEAP_MARKER:-}" ]; then printf '[compat-gc] retained-values-verified\n' >&2; fi
  if [ ! "${LIFECYCLE_NO_POST_BROKER_HEAP_MARKER:-}" ]; then printf '[compat-gc] post-broker-retained-values-verified\n' >&2; fi
  printf '[compat-lifecycle] cpu-loop\n' >&2
  exec sleep 30
 else
  if [ ! "${LIFECYCLE_STALE_HEALTHY_STATE:-}" ]; then
   write_state exited 0 false 2026-10-13T00:00:01Z
  fi
  printf '%s\n' "$LIFECYCLE_EVIDENCE"
  if [ "${LIFECYCLE_KEEP_HEALTHY_OPEN:-}" ]; then exec sleep 30; fi
 fi
}
case "$operation" in
run|create)
 while [ "$#" -gt 0 ]; do
  case "$1" in
   --name) name=$2; shift ;;
   --label) owner=${2#*=}; shift ;;
  esac
  shift
 done
 identify "$name"
 provision
 if [ "$operation" = create ]; then printf '%s\n' "$cid"; else launch; fi
 ;;
start)
 [ "$#" -eq 3 ] && [ "$1" = -a ] && [ "$2" = -i ] || exit 8
 identify "$3"
 [ "$3" = "$cid" ] || exit 8
 launch
 ;;
wait)
 identify "$1"
 if [ "$mode" = busy ] && [ "${LIFECYCLE_STALL_BUSY_WAIT:-}" ]; then exec sleep 30; fi
 while :; do
  IFS= read -r state < "$root/$name"
  case "$state" in *'"Running":true'*) sleep .02 ;; *) break ;; esac
 done
 printf '0\n'
 ;;
inspect)
 identify "$1"; IFS= read -r state < "$root/$name"
 case "$mode:$state" in busy:*'"ExitCode":137'*)
  if [ "${LIFECYCLE_BUSY_INSPECT_DELAY:-}" ] && [ ! -f "$root/$name-inspection-delayed" ]; then
   : > "$root/$name-inspection-delayed"
   sleep "$LIFECYCLE_BUSY_INSPECT_DELAY"
  fi ;;
 esac
 printf '%s\n' "$state" ;;
kill)
 shift
 identify "$1"
 printf '%s\n' "$name" > "$root/kill-attempt"
 sleep "${LIFECYCLE_KILL_DELAY:-0}"
 if [ ! "${LIFECYCLE_NO_KILL:-}" ]; then
  sed 's/"Running":true/"Running":false/;s/"ExitCode":0/"ExitCode":137/;s/"FinishedAt":"0001-01-01T00:00:00Z"/"FinishedAt":"2026-10-13T00:00:01Z"/' "$root/$name" > "$root/$name.tmp"
  mv "$root/$name.tmp" "$root/$name"
  if [ "${LIFECYCLE_KEEP_HEALTHY_OPEN:-}" ]; then exec sleep 30; fi
 fi
 printf '%s\n' "$name"
 ;;
rm)
 shift
 identify "$1"
 if [ "${LIFECYCLE_CLEANUP_FAILURE:-}" ] && [ "$name" = owned-healthy-0 ]; then exit 4; fi
 rm -f "$root/$name" "$root/$name-loop" "$root/$name-inspection-delayed"
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
  e={'kind':'runtime-evidence','architecture':'amd64','runtime_gc_verified':True,'negative_controls':CONTROLS['amd64'],'install':0,'html':'<p>restricted render</p>','main':[-1]*24,'thread':-1,'application_open':True,'cgroups':{'cpu':'100000 100000','memory':'536870912','pids':'64'},'descriptors_closed':True,'broker_reply':'registered:Squat','host_canary_absent':True,'event_probe':0,'event_negatives':[-1]*12}
  startup={'kind':'startup-audit','inventory':[{'fd':3,'kind':'eventfd'},{'fd':4,'kind':'eventpoll'}]}
  self.env=dict(os.environ,LIFECYCLE_IMAGE=IMAGE,LIFECYCLE_STARTUP=json.dumps(startup),LIFECYCLE_FAKE_ROOT=str(self.root),LIFECYCLE_REQUEST=json.dumps(REQUEST),LIFECYCLE_EVIDENCE=json.dumps(e))
 def tearDown(self):self.tmp.cleanup()
 def observe(self,name,owner,inventory):
  data=json.loads((self.root/name).read_text())
  if data['Config']['Labels']['fleur.compatibility.runtime-owner']!=owner:raise RuntimeError('unowned worker')
  return {'configuration':{'container_id':data['Id'],'host_init_pid':47},'host_threads':self.rows,'configuration_verified':True,'descriptor_audit':{'passed':True,'category':'verified','descriptor_count':len(inventory)}}
 def run_probe(self,timeout=2,containerd_control=None,create_worker=None,aggregate_preparation_budget=False,inspect_worker_state=None,broker_ack_delay=0):
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
      state.update(Running=False,ExitCode=int(parent.env.get('LIFECYCLE_BUSY_EXIT_CODE','137')),
                  FinishedAt=parent.env.get('LIFECYCLE_BUSY_FINISHED_AT','2026-10-13T00:00:01Z'))
      if parent.env.get('LIFECYCLE_BUSY_REPLACED_ID'):metadata['Id']='f'*64
      publication=path.with_name(path.name+'.guard.tmp')
      publication.write_text(json.dumps(metadata,separators=(',',':'))+'\n')
      publication.replace(path)
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
  return run_lifecycle(IMAGE,'owned','amd64',self.env,self.observe,timeout=timeout,docker=str(self.cli),containerd_control=containerd_control,deadline_factory=FixtureDeadline,create_worker=create_worker,aggregate_preparation_budget=aggregate_preparation_budget,inspect_worker_state=inspect_worker_state,broker_ack_delay=broker_ack_delay)
 def test_idle_broker_pause_is_after_audit_and_inside_original_worker_deadline(self):
  result=self.run_probe(broker_ack_delay=.15)
  self.assertTrue(result['passed'])
  for row in result['repeats']:
   pause=row['broker_ack_pause']
   self.assertEqual(pause['requested_ms'],150)
   self.assertGreaterEqual(pause['duration_ms'],150)
   self.assertTrue(pause['after_restriction_audit']);self.assertTrue(pause['registered_request_verified'])
   self.assertTrue(pause['completed'])
   self.assertTrue(row['retained_heap_verified_before_cpu_loop'])
   self.assertGreaterEqual(row['cpu_loop_entered_ms'],pause['duration_ms'])
   self.assertLessEqual(row['cpu_loop_entered_ms'],row['healthy_started_ms'])
   self.assertEqual(row['deadline_seconds'],2)
   self.assertLessEqual(row['termination']['physical_exit_lateness_ms'],250)

 def test_idle_pause_never_acknowledges_before_restriction_approval(self):
  self.env['LIFECYCLE_RECORD_EVENTS']='1'
  self.observe=lambda *args:{'configuration_verified':False,'host_threads':self.rows}
  with self.assertRaisesRegex(RuntimeError,'configuration or restrictions') as caught:
   self.run_probe(broker_ack_delay=.15)
  pause=caught.exception.worker_diagnostics['broker_ack_pause']
  self.assertFalse(pause['after_restriction_audit']);self.assertFalse(pause['registered_request_verified'])
  self.assertFalse(pause['completed']);self.assertEqual(pause['duration_ms'],0)
  self.assertNotIn('approved:owned-busy-0',(self.root/'events').read_text())
  self.assertTrue(caught.exception.lifecycle_cleanup_verified)

 def test_idle_pause_consumes_same_deadline_when_healthy_completion_stalls(self):
  self.env['LIFECYCLE_KEEP_HEALTHY_OPEN']='1'
  with patch('lifecycle.OwnedWaiter',return_value=SimpleNamespace(completion=lambda r:{'completed':False},close=lambda:None)),self.assertRaises(subprocess.TimeoutExpired) as caught:
   self.run_probe(broker_ack_delay=.25)
  self.assertLessEqual(caught.exception.worker_diagnostics['timeout_seconds'],1.75)
  self.assertGreaterEqual(caught.exception.worker_diagnostics['broker_ack_pause']['duration_ms'],250)
  self.assertTrue(caught.exception.worker_diagnostics['broker_ack_pause']['completed'])
  self.assertTrue(caught.exception.lifecycle_cleanup_verified)

 def test_missing_retained_heap_proof_cannot_launch_healthy_work(self):
  self.env['LIFECYCLE_RECORD_EVENTS']='1';self.env['LIFECYCLE_NO_HEAP_MARKER']='1'
  with self.assertRaisesRegex(RuntimeError,'retained heap verification') as caught:self.run_probe()
  self.assertNotIn('start:owned-healthy-0',(self.root/'events').read_text())
  self.assertTrue(caught.exception.lifecycle_cleanup_verified)

 def test_pre_idle_heap_proof_cannot_substitute_post_broker_collection(self):
  self.env['LIFECYCLE_RECORD_EVENTS']='1';self.env['LIFECYCLE_NO_POST_BROKER_HEAP_MARKER']='1'
  with self.assertRaisesRegex(RuntimeError,'post-broker retained heap verification') as caught:
   self.run_probe(timeout=4,broker_ack_delay=.15)
  self.assertNotIn('start:owned-healthy-0',(self.root/'events').read_text())
  self.assertTrue(caught.exception.lifecycle_cleanup_verified)

 def test_invalid_host_pause_cannot_create_containers(self):
  for delay in (-1,True,float('nan'),12,2):
   with self.subTest(delay=delay),self.assertRaisesRegex(ValueError,'broker pause invalid'):
    self.run_probe(broker_ack_delay=delay)
  self.assertEqual(set(self.root.iterdir()),{self.cli})

 def test_trusted_state_reader_keeps_full_identity_status_and_physical_deadline_checks(self):
  calls=[]
  def reader(cid,remaining):
   self.assertGreater(remaining,0);self.assertLessEqual(remaining,10)
   name='owned-busy-'+str({'c':0,'d':1}[cid[0]])
   calls.append(cid)
   return json.loads((self.root/name).read_text()),{'source':'fixture-engine-api','connection_closed':True,'deadline_timer_reaped':True}
  result=self.run_probe(inspect_worker_state=reader)
  self.assertTrue(result['passed']);self.assertEqual(calls,['c'*64,'d'*64])
  for row in result['repeats']:
   self.assertEqual(row['terminated_exit'],137)
   self.assertLessEqual(row['termination']['physical_exit_lateness_ms'],250)
   self.assertEqual(row['retirement_confirmation']['source'],'verified-default-engine-unix-api')
   self.assertEqual(row['retirement_confirmation']['transport']['source'],'fixture-engine-api')

 def test_trusted_state_reader_cannot_substitute_another_worker_or_wrong_exit(self):
  for field,value in (('Id','f'*64),('Image','sha256:'+'f'*64),('ExitCode',0)):
   with self.subTest(field=field):
    def reader(cid,remaining):
     data=json.loads((self.root/'owned-busy-0').read_text())
     if field=='ExitCode':data['State'][field]=value
     else:data[field]=value
     return data,{'source':'fixture-engine-api'}
    with self.assertRaisesRegex(RuntimeError,'identity mismatch|termination unconfirmed') as caught:
     self.run_probe(inspect_worker_state=reader)
    self.assertTrue(caught.exception.worker_diagnostics['termination']['physical_exit_confirmed'])
    self.assertFalse(caught.exception.worker_diagnostics['retirement_confirmation']['passed'])
    self.assertTrue(caught.exception.lifecycle_cleanup_verified)

 def test_owned_stopped_state_confirms_retirement_without_redundant_wait_rpc(self):
  self.env['LIFECYCLE_STALL_BUSY_WAIT']='1'
  result=self.run_probe()
  self.assertTrue(result['passed'])
  for row in result['repeats']:
   self.assertEqual(row['terminated_exit'],137)
   self.assertTrue(row['termination']['physical_exit_confirmed'])

 def test_host_confirmation_reuses_prior_aggregate_budget_without_extending_execution(self):
  self.env['LIFECYCLE_BUSY_INSPECT_DELAY']='6'
  result=self.run_probe()
  self.assertTrue(result['passed'])
  for row in result['repeats']:
   self.assertEqual(row['deadline_seconds'],2)
   self.assertLessEqual(row['termination']['physical_exit_lateness_ms'],250)
   self.assertEqual(row['retirement_confirmation']['budget_seconds'],10)
   self.assertGreaterEqual(row['retirement_confirmation']['duration_ms'],6000)
   self.assertTrue(row['retirement_confirmation']['passed'])

 def test_expired_confirmation_retains_healthy_and_physical_proof_but_cannot_pass(self):
  self.env['LIFECYCLE_BUSY_INSPECT_DELAY']='.2'
  with patch('lifecycle.RETIREMENT_CONFIRMATION_BUDGET_SECONDS',.05),self.assertRaises(subprocess.TimeoutExpired) as caught:
   self.run_probe()
  evidence=caught.exception.worker_diagnostics
  self.assertTrue(evidence['healthy_completed_while_busy_running'])
  self.assertEqual(evidence['healthy_completion'],{'completed':True,'exit_code':0})
  self.assertTrue(evidence['termination']['physical_exit_confirmed'])
  self.assertLessEqual(evidence['termination']['physical_exit_lateness_ms'],250)
  self.assertFalse(evidence['retirement_confirmation']['passed'])
  self.assertTrue(caught.exception.lifecycle_cleanup_verified)

 def test_physical_exit_does_not_excuse_wrong_docker_status_or_missing_finish(self):
  for key,value in (('LIFECYCLE_BUSY_EXIT_CODE','0'),('LIFECYCLE_BUSY_FINISHED_AT','0001-01-01T00:00:00Z'),('LIFECYCLE_BUSY_FINISHED_AT','invalid')):
   with self.subTest(key=key,value=value):
    self.env[key]=value
    try:
     with self.assertRaisesRegex(RuntimeError,'termination unconfirmed') as caught:self.run_probe()
     self.assertTrue(caught.exception.worker_diagnostics['termination']['physical_exit_confirmed'])
     self.assertFalse(caught.exception.worker_diagnostics['retirement_confirmation']['passed'])
     self.assertTrue(caught.exception.lifecycle_cleanup_verified)
    finally:self.env.pop(key)

 def test_retirement_rejects_replaced_identity_despite_original_physical_exit(self):
  self.env['LIFECYCLE_BUSY_REPLACED_ID']='1'
  with self.assertRaisesRegex(RuntimeError,'identity mismatch') as caught:self.run_probe()
  self.assertTrue(caught.exception.worker_diagnostics['termination']['physical_exit_confirmed'])
  self.assertFalse(caught.exception.worker_diagnostics['retirement_confirmation']['passed'])
  self.assertFalse(caught.exception.lifecycle_cleanup_verified)
  self.assertEqual(json.loads((self.root/'owned-busy-0').read_text())['Id'],'f'*64)
  self.assertFalse((self.root/'owned-healthy-0').exists())

 def test_concurrent_exit_notification_never_reads_partially_published_fixture_state(self):
  self.env['LIFECYCLE_STATE_PUBLISH_DELAY']='1'
  self.assertTrue(self.run_probe()['passed'])

 def test_both_workers_are_prepared_without_processes_before_busy_execution(self):
  self.env['LIFECYCLE_RECORD_EVENTS']='1'
  original=self.observe
  observations=[]
  def inspect_preparation(name,owner,inventory):
   if '-busy-' in name:
    healthy=self.root/name.replace('-busy-','-healthy-')
    self.assertTrue(healthy.exists(),'healthy storage was not prepared before busy execution')
    state=json.loads(healthy.read_text())['State']
    self.assertFalse(state['Running']);self.assertEqual(state['Pid'],0);self.assertEqual(state['Status'],'created')
    self.assertFalse((self.root/'healthy-too-early').exists())
    observations.append('stopped')
   return original(name,owner,inventory)
  self.observe=inspect_preparation
  self.env['LIFECYCLE_REFUSE_CREATE_DURING_BUSY']='1'
  result=self.run_probe()
  self.assertTrue(result['passed']);self.assertEqual(observations,['stopped','stopped'])
  self.assertTrue(all(row['preparation']['stopped_workers_verified']==2 for row in result['repeats']))
  expected=[]
  for index in range(2):
   expected.extend([f'create:owned-busy-{index}',f'create:owned-healthy-{index}',f'start:owned-busy-{index}',f'approved:owned-busy-{index}',f'start:owned-healthy-{index}',f'approved:owned-healthy-{index}'])
  self.assertEqual((self.root/'events').read_text().splitlines(),expected)

 def test_preparation_failure_retires_each_owned_container_without_starting_workers(self):
  self.env['LIFECYCLE_RECORD_EVENTS']='1'
  for role in ('BUSY','HEALTHY'):
   with self.subTest(role=role):
    setting='LIFECYCLE_FAIL_PREPARE_'+role
    self.env[setting]='1'
    (self.root/'events').unlink(missing_ok=True)
    try:
     with self.assertRaises(RuntimeError) as caught:self.run_probe()
     self.assertTrue(caught.exception.lifecycle_cleanup_verified)
     self.assertFalse(caught.exception.worker_diagnostics['preparation']['passed'])
     self.assertFalse(any(line.startswith('start:') for line in (self.root/'events').read_text().splitlines()))
     self.assertFalse((self.root/'kill-attempt').exists())
     self.assertEqual(set(self.root.iterdir()),{self.cli,self.root/'events'})
    finally:self.env.pop(setting)

 def test_prepared_identity_replacement_cannot_receive_application_approval(self):
  self.env['LIFECYCLE_RECORD_EVENTS']='1'
  original=self.observe
  def replace_identity(name,owner,inventory):
   if '-healthy-' in name:
    path=self.root/name;metadata=json.loads(path.read_text());metadata['Id']='f'*64
    path.write_text(json.dumps(metadata,separators=(',',':'))+'\n')
   return original(name,owner,inventory)
  self.observe=replace_identity
  with self.assertRaisesRegex(RuntimeError,'prepared worker identity changed') as caught:self.run_probe()
  self.assertNotIn('approved:owned-healthy-0',(self.root/'events').read_text().splitlines())
  self.assertFalse(caught.exception.lifecycle_cleanup_verified)
  self.assertEqual(json.loads((self.root/'owned-healthy-0').read_text())['Id'],'f'*64)
  self.assertFalse((self.root/'owned-busy-0').exists())

 def test_stopped_creation_adapter_is_bounded_and_still_identity_checked(self):
  calls=[]
  def create(name,busy,remaining):
   self.assertGreater(remaining,0);self.assertLessEqual(remaining,5)
   calls.append(name)
   result=subprocess.run([str(self.cli),'create','--name',name,'--label','fleur.compatibility.runtime-owner=owned',IMAGE],env=self.env,capture_output=True,text=True,check=True,timeout=remaining)
   return result.stdout.strip()
  result=self.run_probe(create_worker=create)
  self.assertTrue(result['passed']);self.assertEqual(len(calls),4)
  self.assertFalse((self.root/'healthy-too-early').exists())

 def test_slow_stopped_preparation_is_reported_outside_unchanged_operation_deadline(self):
  self.env['LIFECYCLE_CREATE_DELAY']='.3'
  result=self.run_probe()
  self.assertTrue(result['passed'])
  for row in result['repeats']:
   self.assertGreaterEqual(row['preparation']['duration_ms'],600)
   self.assertEqual(row['preparation']['budget_seconds'],20)
   self.assertTrue(row['preparation']['passed'])
   self.assertEqual(row['deadline_seconds'],2)
   self.assertLessEqual(row['termination']['physical_exit_lateness_ms'],250)

 def test_late_preparation_adapter_cannot_start_workers_or_claim_success(self):
  def create(name,busy,remaining):
   cid=('c' if busy else 'a')*64
   (self.root/name).write_text(json.dumps({'Id':cid,'Name':'/'+name,'Image':IMAGE,
    'State':{'Status':'created','Pid':0,'Running':False,'ExitCode':0,'FinishedAt':'0001-01-01T00:00:00Z'},
    'Config':{'Labels':{'fleur.compatibility.runtime-owner':'owned'}}})+'\n')
   time.sleep(.06)
   return cid
  with patch('lifecycle.PREPARATION_BUDGET_SECONDS',.03),self.assertRaisesRegex(RuntimeError,'preparation deadline') as caught:
   self.run_probe(create_worker=create)
  self.assertTrue(caught.exception.lifecycle_cleanup_verified)
  self.assertFalse(caught.exception.worker_diagnostics['preparation']['passed'])
  self.assertEqual(set(self.root.iterdir()),{self.cli})

 def test_silent_healthy_startup_captures_once_before_busy_deadline(self):
  self.env['LIFECYCLE_STALL_HEALTHY_STARTUP']='1'
  captures=[]
  def capture(remaining):
   self.assertTrue((self.root/'owned-busy-0-loop').exists())
   self.assertFalse((self.root/'kill-attempt').exists())
   captures.append(remaining)
   return {'outcome':'captured'}
  with patch('lifecycle.capture_daemon_trace',side_effect=capture),self.assertRaises(subprocess.TimeoutExpired) as caught:
   self.run_probe(timeout=3)
  self.assertEqual(len(captures),1)
  self.assertGreater(captures[0],0)
  self.assertEqual(caught.exception.worker_diagnostics['startup_stall_trace'],{'outcome':'captured'})
  self.assertEqual(caught.exception.worker_diagnostics['protocol_phase'],'waiting-startup-audit')
  self.assertTrue(caught.exception.lifecycle_cleanup_verified)

 def test_fast_healthy_startup_never_requests_privileged_diagnostic(self):
  with patch('lifecycle.capture_daemon_trace',side_effect=AssertionError('unexpected healthy diagnostic')) as capture:
   self.assertTrue(self.run_probe()['passed'])
  capture.assert_not_called()

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
    state=json.loads((parent.root/f'owned-healthy-{self.index}').read_text())['State']
    parent.assertFalse(state['Running']);parent.assertEqual(state['Pid'],0);parent.assertEqual(state['Status'],'created')
    parent.assertTrue((parent.root/f'owned-busy-{self.index}-loop').exists())
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

 def test_vfs_stopped_creator_receives_remaining_aggregate_preparation_budget(self):
  calls=[]
  def create(name,busy,remaining):
   self.assertGreater(remaining,5)
   self.assertLessEqual(remaining,20)
   calls.append(name)
   raise RuntimeError('stopped storage boundary sampled')
  with self.assertRaisesRegex(RuntimeError,'stopped storage boundary sampled'):
   self.run_probe(create_worker=create,aggregate_preparation_budget=True)
  self.assertEqual(calls,['owned-busy-0'])

 def test_vfs_cold_stopped_create_can_exceed_five_seconds_within_original_twenty(self):
  def create(name,busy,remaining):
   delay='5.2' if name=='owned-busy-0' else '0'
   environment=dict(self.env,LIFECYCLE_CREATE_DELAY=delay)
   result=subprocess.run([str(self.cli),'create','--name',name,'--label','fleur.compatibility.runtime-owner=owned',IMAGE],env=environment,capture_output=True,text=True,check=True,timeout=remaining)
   return result.stdout.strip()
  result=self.run_probe(create_worker=create,aggregate_preparation_budget=True)
  self.assertTrue(result['passed'])
  self.assertGreaterEqual(result['repeats'][0]['preparation']['duration_ms'],5200)
  for row in result['repeats']:
   self.assertEqual(row['preparation']['budget_seconds'],20)
   self.assertEqual(row['deadline_seconds'],2)
   self.assertTrue(row['healthy_completed_while_busy_running'])

 def test_vfs_aggregate_twenty_second_expiry_still_rejects_stopped_preparation(self):
  clock=[time.monotonic()]
  def create(name,busy,remaining):
   cid='c'*64
   (self.root/name).write_text(json.dumps({'Id':cid,'Name':'/'+name,'Image':IMAGE,
    'State':{'Status':'created','Pid':0,'Running':False,'ExitCode':0,'FinishedAt':'0001-01-01T00:00:00Z'},
    'Config':{'Labels':{'fleur.compatibility.runtime-owner':'owned'}}})+'\n')
   clock[0]+=21
   return cid
  with patch('lifecycle.time.monotonic',side_effect=lambda:clock[0]),self.assertRaisesRegex(RuntimeError,'preparation deadline') as caught:
   self.run_probe(create_worker=create,aggregate_preparation_budget=True)
  self.assertEqual(caught.exception.worker_diagnostics['preparation']['budget_seconds'],20)
  self.assertFalse(caught.exception.worker_diagnostics['preparation']['passed'])
  self.assertTrue(caught.exception.lifecycle_cleanup_verified)
  self.assertEqual(set(self.root.iterdir()),{self.cli})

if __name__=='__main__':unittest.main()

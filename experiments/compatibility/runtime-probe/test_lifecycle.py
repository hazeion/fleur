import json, os
from pathlib import Path
import tempfile, unittest
import subprocess
from unittest.mock import patch
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
  sleep "${LIFECYCLE_DELAY_LOOP:-0}"
  printf 'entered\n' > "$root/$name-loop"
  printf '[compat-lifecycle] cpu-loop\n' >&2
  exec sleep 30
 else
  number=${name##*-}
  if [ ! -f "$root/owned-busy-$number-loop" ]; then printf '%s\n' "$name" > "$root/healthy-too-early"; fi
  printf '%s\n' "$LIFECYCLE_EVIDENCE"
  sed 's/"Running":true/"Running":false/;s/"FinishedAt":"0001-01-01T00:00:00Z"/"FinishedAt":"2026-10-13T00:00:01Z"/' "$root/$name" > "$root/$name.tmp"
  mv "$root/$name.tmp" "$root/$name"
  if [ "${LIFECYCLE_KEEP_HEALTHY_OPEN:-}" ]; then
   sed 's/"FinishedAt":"0001-01-01T00:00:00Z"/"FinishedAt":"2026-10-13T00:00:01Z"/' "$root/$name" > "$root/$name.tmp"
   mv "$root/$name.tmp" "$root/$name"
   exec sleep 30
  fi
 fi
 ;;
inspect) cat "$root/$1" ;;
kill)
 shift
 name=$1
 printf '%s\n' "$name" > "$root/kill-attempt"
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
  return {'host_threads':self.rows,'configuration_verified':True,'descriptor_audit':{'passed':True,'category':'verified','descriptor_count':len(inventory)}}
 def run_probe(self):return run_lifecycle('sha256:fixture','owned','amd64',self.env,self.observe,timeout=2,docker=str(self.cli))
 def test_deadline_terminates_daemon_worker_and_preserves_healthy_worker(self):
  result=self.run_probe();self.assertTrue(result['passed']);self.assertEqual(len(result['repeats']),2)
  for row in result['repeats']:self.assertTrue(row['healthy_completed_while_busy_running']);self.assertEqual(row['terminated_exit'],137)
  self.assertEqual(set(self.root.iterdir()),{self.cli,self.root/'kill-attempt'})
 def test_cli_termination_does_not_count_as_daemon_worker_termination(self):
  self.env['LIFECYCLE_NO_KILL']='1'
  with self.assertRaisesRegex(RuntimeError,'termination'):self.run_probe()
  self.assertEqual(set(self.root.iterdir()),{self.cli,self.root/'kill-attempt'})
 def test_unverified_ownership_never_sends_daemon_kill(self):
  self.env['LIFECYCLE_FOREIGN']='1'
  with self.assertRaises(RuntimeError):self.run_probe()
  self.assertFalse((self.root/'kill-attempt').exists())
 def test_healthy_worker_starts_after_actual_busy_cpu_loop_entry(self):
  self.env['LIFECYCLE_DELAY_LOOP']='.7'
  result=self.run_probe()
  self.assertTrue(result['passed'])
  self.assertFalse((self.root/'healthy-too-early').exists())
 def test_healthy_timeout_retains_correct_stopped_daemon_state_before_cleanup(self):
  self.env['LIFECYCLE_KEEP_HEALTHY_OPEN']='1'
  with patch('lifecycle.inspect_owned_completion',return_value={'completed':False}), self.assertRaises(subprocess.TimeoutExpired) as caught:self.run_probe()
  self.assertEqual(getattr(caught.exception,'worker_role',None),'healthy')
  self.assertEqual(caught.exception.worker_state['Running'],False)
  self.assertEqual(caught.exception.worker_state['ExitCode'],0)
  self.assertEqual(caught.exception.worker_state['FinishedAt'],'2026-10-13T00:00:01Z')
  self.assertIn('runtime-evidence',caught.exception.worker_diagnostics['stdout'])
  self.assertEqual(set(self.root.iterdir()),{self.cli,self.root/'kill-attempt'})
if __name__=='__main__':unittest.main()

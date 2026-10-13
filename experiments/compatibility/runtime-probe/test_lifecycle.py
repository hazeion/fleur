import json, os
from pathlib import Path
import tempfile, unittest
from lifecycle import run_lifecycle
FAKE = '''#!/usr/bin/env python3
import json, os, pathlib, sys, time
root=pathlib.Path(os.environ['LIFECYCLE_FAKE_ROOT']); a=sys.argv[1:]
if a[0]=='run':
 n=a[a.index('--name')+1]; owner=a[a.index('--label')+1].split('=',1)[1]
 (root/n).write_text(json.dumps({'State':{'Running':True,'ExitCode':0,'FinishedAt':''},'Config':{'Labels':{'fleur.compatibility.runtime-owner':owner}}}))
 print(os.environ['LIFECYCLE_REQUEST'],flush=True);sys.stdin.readline()
 if a[-1]=='busy':
  print('[compat-lifecycle] cpu-loop',file=sys.stderr,flush=True)
  while True:time.sleep(.01)
 else:
  print(os.environ['LIFECYCLE_EVIDENCE'],flush=True)
  d=json.loads((root/n).read_text());d['State']['Running']=False;(root/n).write_text(json.dumps(d))
elif a[0]=='inspect':print((root/a[1]).read_text())
elif a[0]=='kill':
 p=root/a[-1];d=json.loads(p.read_text())
 if not os.environ.get('LIFECYCLE_NO_KILL'):d['State'].update(Running=False,ExitCode=137,FinishedAt='2026-10-13T00:00:01Z');p.write_text(json.dumps(d))
 print(a[-1])
elif a[0]=='rm':(root/a[-1]).unlink();print(a[-1])
else:sys.exit(2)
'''
class LifecycleTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.cli=self.root/'docker';self.cli.write_text(FAKE);self.cli.chmod(0o700)
  from report import CONTROLS
  from protocol import REQUEST
  self.rows=[{'pid':1,'no_new_privs':1,'seccomp':2,'seccomp_filters':1},{'pid':2,'no_new_privs':1,'seccomp':2,'seccomp_filters':1}]
  e={'kind':'runtime-evidence','architecture':'amd64','negative_controls':CONTROLS['amd64'],'install':0,'html':'<p>restricted render</p>','main':[-1]*24,'thread':-1,'application_open':True,'cgroups':{'cpu':'100000 100000','memory':'536870912','pids':'64'},'descriptors_closed':True,'broker_reply':'registered:Squat','host_canary_absent':True}
  self.env=dict(os.environ,LIFECYCLE_FAKE_ROOT=str(self.root),LIFECYCLE_REQUEST=json.dumps(REQUEST),LIFECYCLE_EVIDENCE=json.dumps(e))
 def tearDown(self):self.tmp.cleanup()
 def observe(self,name,owner):return {'host_threads':self.rows,'configuration_verified':True}
 def run_probe(self):return run_lifecycle('sha256:fixture','owned','amd64',self.env,self.observe,timeout=2,docker=str(self.cli))
 def test_deadline_terminates_daemon_worker_and_preserves_healthy_worker(self):
  result=self.run_probe();self.assertTrue(result['passed']);self.assertEqual(len(result['repeats']),2)
  for row in result['repeats']:self.assertTrue(row['healthy_completed_while_busy_running']);self.assertEqual(row['terminated_exit'],137)
  self.assertEqual(list(self.root.iterdir()),[self.cli])
 def test_cli_termination_does_not_count_as_daemon_worker_termination(self):
  self.env['LIFECYCLE_NO_KILL']='1'
  with self.assertRaisesRegex(RuntimeError,'termination'):self.run_probe()
  self.assertEqual(list(self.root.iterdir()),[self.cli])
if __name__=='__main__':unittest.main()

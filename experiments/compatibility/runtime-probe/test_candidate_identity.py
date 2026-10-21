"""Candidate observations through filesystem and bounded command protocols."""
import io,json,stat,subprocess,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from candidate_identity import observe_candidate_identity
ENGINE={'Version':'29.9.1','GitCommit':'engine-observed','Components':[
 {'Name':'containerd','Version':'v2.4.2','Details':{'GitCommit':'containerd-observed'}},
 {'Name':'runc','Version':'1.5.2','Details':{'GitCommit':'runc-observed'}}]}
CTR='Client:\n Version: v2.4.2\n Revision: containerd-observed\nServer:\n Version: v2.4.2\n Revision: containerd-observed\n'
class CandidateObservation(unittest.TestCase):
 def observe(self,engine=None,ctr=CTR,active='daemon-owned',change=None,command_error=None):
  calls=[]
  bodies={'/var/run/docker.pid':b'42\n','/proc/42/comm':b'dockerd\n','/proc/42/cmdline':b'/usr/bin/dockerd\0--containerd=/run/containerd/containerd.sock\0','/usr/bin/ctr':b'ctr-bytes','/usr/bin/runc':b'runc-bytes'}
  def metadata(path,**kwargs):
   name=str(path);mode=stat.S_IFSOCK|0o660 if name.endswith('.sock') else stat.S_IFREG|0o644 if name in bodies else stat.S_IFDIR|0o755
   value=SimpleNamespace(st_mode=mode,st_uid=0,st_gid=0,st_dev=1,st_ino=abs(hash(name)),st_size=len(bodies.get(name,b'')),st_mtime_ns=1,st_ctime_ns=1)
   if change:change(name,value)
   return value
  def command(args,**kwargs):
   calls.append((args,kwargs))
   if command_error:raise command_error
   if args[-1]=='{{json .Server}}':return 0,json.dumps(engine or ENGINE),'sensitive stderr excluded'
   if args[-1]=='{{.ID}}':return 0,(active if '--host' not in args else 'daemon-owned')+'\n',''
   if args[-1]=='version':return 0,ctr,''
   if args[-1]=='--version':return 0,'runc version 1.5.2\ncommit: runc-observed\nspec: 1.2.1\n',''
   raise AssertionError(args)
  with patch.object(Path,'resolve',lambda self,**kwargs:self),patch.object(Path,'stat',metadata),patch.object(Path,'exists',lambda self:str(self) in bodies),patch.object(Path,'open',lambda self,*args,**kwargs:io.BytesIO(bodies[str(self)])):
   result=observe_candidate_identity(command)
  self.calls=calls
  return result
 def test_observed_tuple_never_admits_control_or_exposes_sensitive_details(self):
  observed=self.observe()
  self.assertEqual(observed['outcome'],'observed')
  self.assertEqual(observed['engine'],ENGINE)
  self.assertEqual(observed['ctr']['client'],{'Version':'v2.4.2','Revision':'containerd-observed'})
  self.assertEqual(observed['runc']['version'],'1.5.2')
  self.assertFalse(observed['accepted']);self.assertFalse(observed['custodyVerified'])
  self.assertEqual(observed['runtimeSupport'],'unverified')
  self.assertNotIn('sensitive',json.dumps(observed));self.assertNotIn('cmdline',observed)
 def test_external_command_timeout_is_bounded_unavailable_evidence(self):
  result=self.observe(command_error=subprocess.TimeoutExpired('docker',5))
  self.assertEqual(result['outcome'],'unavailable');self.assertTrue(result['timedOut'])
  self.assertFalse(result['accepted'])
 def test_missing_duplicate_and_malformed_components_remain_unavailable(self):
  for components in ([], ENGINE['Components']+ENGINE['Components'],[{'Name':'containerd','Version':'v2.4.2'}],None):
   with self.subTest(components=components):
    result=self.observe(engine=dict(ENGINE,Components=components))
    self.assertEqual(result['outcome'],'unavailable');self.assertFalse(result['accepted'])
 def test_crossed_ctr_and_duplicate_sections_remain_unavailable(self):
  for detail in (CTR.replace('containerd-observed','wrong',1),CTR+'Client:\n Version: v2.4.2\n',CTR.replace('Server:','Server-invalid:')):
   with self.subTest(detail=detail):
    result=self.observe(ctr=detail)
    self.assertEqual(result['outcome'],'unavailable');self.assertEqual(result['failureCategory'],'ctr-identity')
 def test_ambient_daemon_mismatch_refuses_observed_association(self):
  result=self.observe(active='foreign-daemon')
  self.assertEqual(result['outcome'],'unavailable');self.assertNotIn('engine',result)
 def test_unprotected_root_paths_are_refused_before_commands(self):
  for target in ('/usr/bin/ctr','/run/containerd/containerd.sock','/proc/42','/usr'):
   def change(name,value):
    if name==target:value.st_uid=1000
   with self.subTest(target=target):
    result=self.observe(change=change)
    self.assertEqual(result['outcome'],'unavailable');self.assertEqual(self.calls,[])
 def test_every_external_query_has_a_finite_budget_and_no_worker_operations(self):
  self.observe()
  for args,kwargs in self.calls:
   self.assertGreater(kwargs['timeout'],0);self.assertLessEqual(kwargs['timeout'],5)
   self.assertNotIn('run',args);self.assertNotIn('events',args);self.assertNotIn('kill',args)
 def test_swapped_socket_identity_is_refused(self):
  calls={}
  def change(name,value):
   calls[name]=calls.get(name,0)+1
   if name=='/var/run/docker.sock' and calls[name]>1:value.st_ino+=1
  result=self.observe(change=change)
  self.assertEqual(result['outcome'],'unavailable');self.assertFalse(result['accepted'])
 def test_runc_component_cannot_disagree_with_executed_binary(self):
  engine=json.loads(json.dumps(ENGINE));engine['Components'][1]['Details']['GitCommit']='different-commit'
  result=self.observe(engine=engine)
  self.assertEqual(result['outcome'],'unavailable');self.assertEqual(result['failureCategory'],'runc-identity')
if __name__=='__main__':unittest.main()

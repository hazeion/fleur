"""Completion evidence comes from the owned daemon, not worker output or EOF."""
import json
import os
import selectors
import subprocess
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from completion import inspect_owned_completion

LABEL='fleur.compatibility.runtime-owner'
class CompletionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.cli=Path(self.tmp.name)/'docker'
  self.cli.write_text('#!/bin/sh\nprintf "%s\\n" "$COMPLETION_FIXTURE"\n');self.cli.chmod(0o700)
  self.metadata={'Name':'/owned','Image':'sha256:fixture','Config':{'Labels':{LABEL:'scope'}},'State':{'Running':False,'ExitCode':0,'FinishedAt':'2026-10-13T10:20:30.123456789Z'}}
 def tearDown(self):self.tmp.cleanup()
 def inspect(self, metadata=None, **kwargs):
  with patch.dict(os.environ,{'COMPLETION_FIXTURE':json.dumps(self.metadata if metadata is None else metadata)}):
   return inspect_owned_completion('owned','scope','sha256:fixture',LABEL,1,docker=str(self.cli),**kwargs)
 def test_only_daemon_confirmed_owned_stopped_zero_exit_is_complete(self):
  self.assertEqual(self.inspect(),{'completed':True,'exit_code':0})
 def test_running_daemon_remains_pending_even_after_valid_worker_result(self):
  self.metadata['State']['Running']=True
  self.metadata['State']['FinishedAt']='0001-01-01T00:00:00Z'
  self.assertEqual(self.inspect(),{'completed':False})
 def test_nonzero_or_unowned_daemon_cannot_accept_worker_success(self):
  for field,value in [('Image','sha256:foreign'),('Name','/foreign')]:
   original=self.metadata[field];self.metadata[field]=value
   with self.assertRaisesRegex(RuntimeError,'completion unverified'):self.inspect()
   self.metadata[field]=original
  self.metadata['Config']['Labels'][LABEL]='foreign-sensitive-value'
  with self.assertRaisesRegex(RuntimeError,'completion unverified') as error:self.inspect()
  self.assertEqual(getattr(error.exception,'category',None),'ownership-label')
  self.assertNotIn('foreign-sensitive-value',str(error.exception))
  self.metadata['Config']['Labels'][LABEL]='scope';self.metadata['State']['ExitCode']=137
  with self.assertRaisesRegex(RuntimeError,'completion unverified'):self.inspect()
 def test_malformed_state_and_oversized_inspection_fail_closed(self):
  original=dict(self.metadata['State'])
  for key,value in [('Running',0),('ExitCode',False),('FinishedAt','not-a-date'),('FinishedAt','0001-01-01T00:00:00Z')]:
   self.metadata['State']=dict(original,**{key:value})
   with self.assertRaisesRegex(RuntimeError,'completion unverified') as error:self.inspect()
   self.assertEqual(getattr(error.exception,'category',None),'state-invalid')
  with self.assertRaisesRegex(RuntimeError,'completion unverified') as error:self.inspect({'padding':'x'*65536})
  self.assertEqual(getattr(error.exception,'category',None),'output-invalid')
 def test_native_database_owner_label_is_accepted_but_unknown_label_is_refused(self):
  label='fleur.compatibility.native-database-owner'
  self.metadata['Config']['Labels']={label:'scope'}
  with patch.dict(os.environ,{'COMPLETION_FIXTURE':json.dumps(self.metadata)}):
   self.assertEqual(inspect_owned_completion('owned','scope','sha256:fixture',label,1,docker=str(self.cli)),{'completed':True,'exit_code':0})
   with self.assertRaisesRegex(RuntimeError,'completion unverified') as error:
    inspect_owned_completion('owned','scope','sha256:fixture','unregistered-label',1,docker=str(self.cli))
   self.assertEqual(getattr(error.exception,'category',None),'arguments-invalid')
 def test_valid_inspect_payload_cannot_escape_remaining_command_deadline(self):
  self.cli.write_text('#!/bin/sh\nprintf "%s\\n" "$COMPLETION_FIXTURE"\nexec sleep 30\n')
  # This test measures capture/observation after a ready payload, not launch.
  # Other timeout controls continue counting ordinary CLI process startup.
  with patch.dict(os.environ,{'COMPLETION_FIXTURE':json.dumps(self.metadata)}):
   process=subprocess.Popen([str(self.cli)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   try:
    with selectors.DefaultSelector() as ready:
     ready.register(process.stdout,selectors.EVENT_READ)
     self.assertTrue(ready.select(5),'completion payload fixture did not become ready')
    started=time.monotonic()
    with patch('completion.subprocess.Popen',return_value=process):
     with self.assertRaisesRegex(RuntimeError,'completion unverified') as error:
      inspect_owned_completion('owned','scope','sha256:fixture',LABEL,.15,docker=str(self.cli))
    self.assertEqual(getattr(error.exception,'category',None),'inspection-timeout')
    self.assertGreater(getattr(error.exception,'observations',{}).get('stdout_bytes',0),0)
    self.assertLess(time.monotonic()-started,.75)
   finally:
    if process.poll() is None:process.kill();process.wait(timeout=1)
    process.stdout.close();process.stderr.close()
 def test_failure_categories_and_safe_observations_survive_cli_boundary(self):
  for key,value,category in [('Name','/sensitive-name','ownership-name'),('Image','sensitive-image','ownership-image')]:
   original=self.metadata[key];self.metadata[key]=value
   with self.assertRaises(RuntimeError) as error:self.inspect()
   self.assertEqual(getattr(error.exception,'category',None),category)
   self.assertNotIn(value,str(error.exception))
   self.metadata[key]=original
  self.metadata['State']['ExitCode']=137
  with self.assertRaises(RuntimeError) as error:self.inspect()
  self.assertEqual(getattr(error.exception,'category',None),'nonzero-exit')
  observations=getattr(error.exception,'observations',{})
  self.assertEqual(observations.get('state_exit_code'),137)
  self.assertIs(observations.get('state_running'),False)
  self.assertEqual(observations.get('cli_returncode'),0)
  self.assertGreater(observations.get('stdout_bytes',0),0)
  self.assertEqual(observations.get('stderr_bytes'),0)
 def test_inspection_cli_failure_is_classified_without_raw_stderr(self):
  self.cli.write_text('#!/bin/sh\nprintf "sensitive-error-path" >&2\nexit 7\n')
  with self.assertRaises(RuntimeError) as error:self.inspect()
  self.assertEqual(getattr(error.exception,'category',None),'cli-nonzero')
  self.assertNotIn('sensitive-error-path',str(error.exception))
  observations=getattr(error.exception,'observations',{})
  self.assertEqual(observations.get('cli_returncode'),7)
  self.assertEqual(observations.get('stderr_bytes'),20)
if __name__=='__main__':unittest.main()

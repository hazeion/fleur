"""Completion evidence comes from the owned daemon, not worker output or EOF."""
import json
import os
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
  self.assertNotIn('foreign-sensitive-value',str(error.exception))
  self.metadata['Config']['Labels'][LABEL]='scope';self.metadata['State']['ExitCode']=137
  with self.assertRaisesRegex(RuntimeError,'completion unverified'):self.inspect()
 def test_malformed_state_and_oversized_inspection_fail_closed(self):
  original=dict(self.metadata['State'])
  for key,value in [('Running',0),('ExitCode',False),('FinishedAt','not-a-date'),('FinishedAt','0001-01-01T00:00:00Z')]:
   self.metadata['State']=dict(original,**{key:value})
   with self.assertRaisesRegex(RuntimeError,'completion unverified'):self.inspect()
  with self.assertRaisesRegex(RuntimeError,'completion unverified'):self.inspect({'padding':'x'*65536})
 def test_native_database_owner_label_is_accepted_but_unknown_label_is_refused(self):
  label='fleur.compatibility.native-database-owner'
  self.metadata['Config']['Labels']={label:'scope'}
  with patch.dict(os.environ,{'COMPLETION_FIXTURE':json.dumps(self.metadata)}):
   self.assertEqual(inspect_owned_completion('owned','scope','sha256:fixture',label,1,docker=str(self.cli)),{'completed':True,'exit_code':0})
   with self.assertRaisesRegex(RuntimeError,'completion unverified'):
    inspect_owned_completion('owned','scope','sha256:fixture','unregistered-label',1,docker=str(self.cli))
 def test_valid_inspect_payload_cannot_escape_remaining_command_deadline(self):
  self.cli.write_text('#!/bin/sh\nprintf "%s\\n" "$COMPLETION_FIXTURE"\nexec sleep 30\n')
  started=time.monotonic()
  with patch.dict(os.environ,{'COMPLETION_FIXTURE':json.dumps(self.metadata)}):
   with self.assertRaisesRegex(RuntimeError,'completion unverified'):
    inspect_owned_completion('owned','scope','sha256:fixture',LABEL,.15,docker=str(self.cli))
  self.assertLess(time.monotonic()-started,.75)
if __name__=='__main__':unittest.main()

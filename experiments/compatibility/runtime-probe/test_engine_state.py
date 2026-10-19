"""Fixed immutable Engine state reads through a real Unix HTTP boundary."""
import contextlib
import http.server
import json
import os
from pathlib import Path
import socket
import socketserver
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import engine_state

CID='a'*64
STATE={'Id':CID,'Name':'/owned-busy-0','Image':'sha256:'+'e'*64,
       'Config':{'Labels':{'fleur.compatibility.runtime-owner':'owned'}},
       'State':{'Running':False,'ExitCode':137,'FinishedAt':'2026-10-19T00:00:00Z'}}

def identity(info):return [info.st_dev,info.st_ino,info.st_uid,info.st_gid,info.st_mode]

@contextlib.contextmanager
def engine_fixture(*, trickle=0, oversized=False, replace=False, status=200, header_delay=0):
 requests=[]
 class Handler(http.server.BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def do_GET(self):
   requests.append(self.path)
   raw=json.dumps(STATE).encode() if not oversized else b'private-host-state'*5000
   if header_delay:time.sleep(header_delay)
   try:
    self.send_response(status);self.send_header('Content-Length',str(len(raw)));self.end_headers()
    if replace:
     os.rename(self.server.server_address,self.server.server_address+'.old')
     with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as replacement:replacement.bind(self.server.server_address)
    for byte in raw:
     self.wfile.write(bytes([byte]))
     if trickle:self.wfile.flush();time.sleep(trickle)
   except (BrokenPipeError,ConnectionResetError):pass
 class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):daemon_threads=True
 with tempfile.TemporaryDirectory(prefix='fleur-engine-state-',dir='/tmp') as directory:
  path=str(Path(directory)/'engine.sock')
  with Server(path,Handler) as server:
   endpoint={'path':path,'directory_identity':identity(os.stat(directory,follow_symlinks=False)),
             'socket_identity':identity(os.stat(path,follow_symlinks=False))}
   thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.01});thread.start()
   try:yield endpoint,requests
   finally:server.shutdown();thread.join()

class EngineStateTests(unittest.TestCase):
 def test_single_fixed_immutable_inspect_preserves_engine_fields_and_closes_transport(self):
  with engine_fixture() as (endpoint,requests):
   metadata,facts=engine_state.read_owned_container_state(endpoint,CID,timeout=1)
  self.assertEqual(metadata,STATE)
  self.assertEqual(requests,['/v1.48/containers/'+CID+'/json'])
  self.assertEqual(facts['source'],'verified-default-engine-unix-api')
  self.assertTrue(facts['connection_closed']);self.assertTrue(facts['deadline_timer_reaped'])
  self.assertEqual(facts['http_status'],200)
  for key in ('connect_ms','headers_ms','body_ms','close_ms','duration_ms'):
   self.assertIs(type(facts[key]),int);self.assertGreaterEqual(facts[key],0)

 def test_trickled_response_cannot_extend_absolute_budget_and_closes_resources(self):
  with engine_fixture(trickle=.02) as (endpoint,requests):
   started=time.monotonic()
   with self.assertRaises(engine_state.EngineStateUnverified) as caught:
    engine_state.read_owned_container_state(endpoint,CID,timeout=.15)
   self.assertLess(time.monotonic()-started,1)
   self.assertTrue(caught.exception.observations['timed_out'])
   self.assertTrue(caught.exception.observations['connection_closed'])
   self.assertTrue(caught.exception.observations['deadline_timer_reaped'])
   self.assertEqual(requests,['/v1.48/containers/'+CID+'/json'])

 def test_replaced_endpoint_is_rejected_after_read_without_disclosing_private_state(self):
  with engine_fixture(replace=True) as (endpoint,requests):
   with self.assertRaises(engine_state.EngineStateUnverified) as caught:
    engine_state.read_owned_container_state(endpoint,CID,timeout=1)
   self.assertNotIn(CID,json.dumps(caught.exception.observations))
   self.assertNotIn('owned-busy',str(caught.exception))
   self.assertTrue(caught.exception.observations['connection_closed'])

 def test_bad_status_and_oversized_response_cannot_pass(self):
  for options in ({'status':500},{'oversized':True}):
   with self.subTest(options=options),engine_fixture(**options) as (endpoint,requests):
    with self.assertRaises(engine_state.EngineStateUnverified) as caught:
     engine_state.read_owned_container_state(endpoint,CID,timeout=1)
    self.assertLessEqual(caught.exception.observations['response_bytes'],65537)
    self.assertNotIn('private-host-state',str(caught.exception.observations))
    self.assertTrue(caught.exception.observations['deadline_timer_reaped'])

 def test_partial_or_route_injecting_container_identity_never_sends_request(self):
  with engine_fixture() as (endpoint,requests):
   for cid in ('a'*12,CID+'/json?size=1',True):
    with self.subTest(cid=cid),self.assertRaises(engine_state.EngineStateUnverified):
     engine_state.read_owned_container_state(endpoint,cid,timeout=1)
   self.assertEqual(requests,[])

 def test_headers_consuming_whole_budget_cannot_pass_late_response(self):
  with engine_fixture(header_delay=.2) as (endpoint,requests):
   with self.assertRaises(engine_state.EngineStateUnverified) as caught:
    engine_state.read_owned_container_state(endpoint,CID,timeout=.05)
   self.assertTrue(caught.exception.observations['timed_out'])
   self.assertGreaterEqual(caught.exception.observations['headers_ms'],45)

 def test_endpoint_replacement_during_close_cannot_pass_post_close_fence(self):
  with engine_fixture() as (endpoint,requests):
   original=engine_state.http.client.HTTPResponse.close
   changed=[]
   def replace_on_close(response):
    original(response)
    if not changed:
     changed.append(True)
     os.rename(endpoint['path'],endpoint['path']+'.old')
     with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as replacement:replacement.bind(endpoint['path'])
   with patch.object(engine_state.http.client.HTTPResponse,'close',replace_on_close):
    with self.assertRaises(engine_state.EngineStateUnverified):
     engine_state.read_owned_container_state(endpoint,CID,timeout=1)

 def test_transport_close_time_consumes_same_absolute_budget(self):
  with engine_fixture() as (endpoint,requests):
   original=engine_state.http.client.HTTPResponse.close
   def slow_close(response):
    time.sleep(.08);original(response)
   with patch.object(engine_state.http.client.HTTPResponse,'close',slow_close):
    with self.assertRaises(engine_state.EngineStateUnverified) as caught:
     engine_state.read_owned_container_state(endpoint,CID,timeout=.05)
   self.assertTrue(caught.exception.observations['timed_out'])
   self.assertTrue(caught.exception.observations['connection_closed'])
   self.assertTrue(caught.exception.observations['deadline_timer_reaped'])
   self.assertGreaterEqual(caught.exception.observations['close_ms'],80)

 def test_changed_parent_identity_fails_before_connect(self):
  with engine_fixture() as (endpoint,requests):
   parent=Path(endpoint['path']).parent
   try:
    os.chmod(parent,0o755)
    with self.assertRaises(engine_state.EngineStateUnverified):
     engine_state.read_owned_container_state(endpoint,CID,timeout=1)
    self.assertEqual(requests,[])
   finally:os.chmod(parent,0o700)

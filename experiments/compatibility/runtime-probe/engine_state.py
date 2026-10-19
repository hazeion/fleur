"""One fixed read-only Engine route through a preflight-verified host endpoint.

The endpoint snapshot is private trusted-host state, created only after exact
pins, root provenance and active-CLI/default-daemon association are verified.
No endpoint, socket or method crosses the application boundary.
"""
import http.client
import json
import math
import os
from pathlib import Path
import re
import socket
import stat
import threading
import time

class EngineStateUnverified(RuntimeError):
 def __init__(self,category,observations):
  self.category='docker-state-'+category
  self.observations=dict(observations)
  super().__init__(self.category)

def _identity(info):return [info.st_dev,info.st_ino,info.st_uid,info.st_gid,info.st_mode]

def read_owned_container_state(endpoint,container_id,*,timeout):
 """Return raw Engine metadata; the lifecycle still audits exact worker identity."""
 if (type(endpoint) is not dict or set(endpoint)!={'path','directory_identity','socket_identity'}
     or type(endpoint['path']) is not str or not endpoint['path'].startswith('/')
     or any(type(endpoint[key]) is not list or len(endpoint[key])!=5 or
            any(type(value) is not int for value in endpoint[key])
            for key in ('directory_identity','socket_identity'))
     or type(container_id) is not str or re.fullmatch('[a-f0-9]{64}',container_id) is None
     or type(timeout) not in (int,float) or not math.isfinite(timeout) or not 0<timeout<=10):
  raise EngineStateUnverified('arguments',{})
 started=time.monotonic();deadline=started+timeout
 facts={'source':'verified-default-engine-unix-api','budget_ms':round(timeout*1000),
        'connect_ms':0,'headers_ms':0,'body_ms':0,'close_ms':0,'duration_ms':0,
        'response_bytes':0,'http_status':None,'connection_closed':False,
        'deadline_timer_reaped':False,'timed_out':False}
 root_fd=None;connection=None;retained=None;fence=None;response=None
 phase='endpoint';expired=threading.Event();failure=None;value=None
 path=Path(endpoint['path'])
 def verify():
  if (_identity(os.stat(path.parent,follow_symlinks=False))!=endpoint['directory_identity']
      or _identity(os.fstat(root_fd))!=endpoint['directory_identity']
      or _identity(os.stat(path.name,dir_fd=root_fd,follow_symlinks=False))!=endpoint['socket_identity']):
   raise ValueError('endpoint changed')
 try:
  root_fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  verify()
  entry=os.stat(path.name,dir_fd=root_fd,follow_symlinks=False)
  if not stat.S_ISSOCK(entry.st_mode):raise ValueError('socket required')
  connection=http.client.HTTPConnection('localhost',timeout=timeout)
  client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
  connection.sock=client;retained=client.dup()
  def expire():
   expired.set()
   try:retained.shutdown(socket.SHUT_RDWR)
   except OSError:pass
  fence=threading.Timer(max(0,deadline-time.monotonic()),expire);fence.daemon=True;fence.start()
  phase='connect';phase_started=time.monotonic()
  try:
   client.settimeout(max(.000001,deadline-time.monotonic()));client.connect(str(path));verify()
  finally:facts['connect_ms']=round(1000*(time.monotonic()-phase_started))
  phase='headers';phase_started=time.monotonic()
  try:
   connection.request('GET','/v1.48/containers/'+container_id+'/json',headers={'Connection':'close'})
   response=connection.getresponse();facts['http_status']=response.status
  finally:facts['headers_ms']=round(1000*(time.monotonic()-phase_started))
  phase='body';phase_started=time.monotonic()
  try:
   raw=response.read(65537);facts['response_bytes']=len(raw)
   if response.status!=200:raise ValueError('status rejected')
   if len(raw)>65536:raise ValueError('body exceeded bound')
   value=json.loads(raw.decode('utf-8'))
   if type(value) is not dict:raise ValueError('object required')
   verify()
  finally:facts['body_ms']=round(1000*(time.monotonic()-phase_started))
 except (OSError,ValueError,http.client.HTTPException) as error:
  failure=error
 finally:
  if failure is None:phase='close'
  close_started=time.monotonic()
  try:
   try:
    if response is not None:response.close()
   finally:
    if connection is not None:connection.close()
   facts['connection_closed']=True
  except (OSError,ValueError,http.client.HTTPException) as error:
   failure=failure or error
  finally:
   if fence is not None:
    fence.cancel();fence.join();facts['deadline_timer_reaped']=not fence.is_alive()
   if retained is not None:retained.close()
   if root_fd is not None:
    try:verify()
    except (OSError,ValueError) as error:
     phase='endpoint-close';failure=failure or error
    finally:os.close(root_fd)
   facts['close_ms']=round(1000*(time.monotonic()-close_started))
   facts['duration_ms']=round(1000*(time.monotonic()-started))
   facts['timed_out']=expired.is_set() or time.monotonic()>=deadline
 if failure is not None or facts['timed_out'] or not facts['connection_closed'] or not facts['deadline_timer_reaped']:
  raise EngineStateUnverified('deadline' if facts['timed_out'] else phase,facts) from None
 return value,facts

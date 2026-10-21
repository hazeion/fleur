"""Real retained custody plus external OS/process seams; no native gate fixture."""
import os
from pathlib import Path
import subprocess
import time
import unittest
from unittest.mock import patch
import test_owned_guest as custody_fixtures
from privileged_control import HostDaemonBinding
from containerd_observer import ContainerdObserver
from daemon_trace import capture_daemon_trace
from worker_deadline import HostDeadlineGuard, supervise
from test_worker_deadline import ChildBoundary, CID


class RetainedFixtureAuthority(unittest.TestCase):
    def test_changed_real_manifest_refuses_all_new_privileged_boundaries(self):
        def action(fixture):
            context=fixture.context
            context.verify(1)
            manifest=fixture.root/'etc/fleur-owned-guest.json'
            original=manifest.read_bytes();manifest.chmod(0o644)
            manifest.write_bytes(original.replace(b'1000',b'1001'));manifest.chmod(0o444)
            binding=HostDaemonBinding(context,{},'never-reached')
            operations=[lambda:ContainerdObserver('/usr/bin/ctr','/run/containerd/containerd.sock','moby',1,host_binding=binding),lambda:HostDeadlineGuard('a'*64,47,fixture.clock[0]+2,host_binding=binding),lambda:capture_daemon_trace(2,host_binding=binding)]
            for operation in operations:
                with self.subTest(operation=operation),patch('subprocess.Popen',side_effect=AssertionError('changed custody reached privileged launch')):
                    with self.assertRaises((ValueError,OSError)):operation()
            manifest.chmod(0o644);manifest.write_bytes(original);manifest.chmod(0o444)
        custody_fixtures.OwnedGuestCustody().with_context(action)

    def test_expired_original_fence_refuses_new_control_without_deadline_reset(self):
        def action(fixture):
            fixture.context.verify(1);fixture.clock[0]=701
            binding=HostDaemonBinding(fixture.context,{},'never-reached')
            with patch('subprocess.Popen',side_effect=AssertionError('expired context launched privilege')):
                with self.assertRaisesRegex(ValueError,'deadline expired'):
                    ContainerdObserver('/usr/bin/ctr','/run/containerd/containerd.sock','moby',1,host_binding=binding)
            fixture.clock[0]=100
        custody_fixtures.OwnedGuestCustody().with_context(action)

    def test_already_armed_owned_child_is_retired_even_after_real_custody_drift(self):
        def action(fixture):
            fixture.context.verify(1)
            # Child/pipe is the documented macOS seam for Linux pidfd operations.
            boundary=ChildBoundary();reader,writer=os.pipe();records=[]
            physical_start=time.perf_counter()
            # The custody fixture supplies a deterministic clock; use physical
            # monotonic time only for the actual child deadline and cancellation.
            with patch('time.monotonic',side_effect=lambda:100+time.perf_counter()-physical_start):
                deadline=time.monotonic()+.2
                def emit(record):
                    records.append(record)
                    if record.get('kind')=='armed':
                        fixture.context.verify(.1)
                        manifest=fixture.root/'etc/fleur-owned-guest.json';manifest.chmod(0o644)
                        manifest.write_text('{"changed":true}');manifest.chmod(0o444)
                        with self.assertRaises((ValueError,OSError)):fixture.context.verify(.1)
                try:supervise(CID,boundary.child.pid,deadline,boundary.bind,boundary.kill,boundary.close,reader,emit)
                finally:
                    os.close(reader);os.close(writer)
                    if boundary.child.poll() is None:boundary.child.kill();boundary.child.wait(timeout=2)
            self.assertIsNotNone(boundary.child.returncode)
            self.assertTrue(any(row.get('physical_exit_confirmed') is True for row in records))
        custody_fixtures.OwnedGuestCustody().with_context(action)


class LongOwnedPhaseBudget(unittest.TestCase):
    def test_valid_retained_custody_and_actual_engine_socket_allow_thirty_second_phase(self):
        import json
        import socket
        import threading
        from types import SimpleNamespace
        from privileged_control import daemon_identity
        def action(fixture):
            for directory in ('var/run','run','proc/47','usr/bin'):
                p=fixture.root/directory
                try:p.mkdir(parents=True,exist_ok=True)
                except FileExistsError:pass
                p.chmod(0o755)
            bodies={'var/run/docker.pid':b'47\n','proc/47/comm':b'dockerd\n','proc/47/stat':b'47 (dockerd) S '+b'0 '*18+b'500 0\n','proc/47/cmdline':b'/usr/bin/dockerd\0--containerd=/run/containerd.sock\0','usr/bin/ctr':b'authenticated fixture binary'}
            for name,body in bodies.items():p=fixture.root/name;p.write_bytes(body);p.chmod(0o755)
            endpoint=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);endpoint.bind(str(fixture.root/'run/containerd.sock'))
            server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind(str(fixture.root/'var/run/docker.sock'));server.listen(2);server.settimeout(2)
            routes=[];failure=[];stop=threading.Event();server.settimeout(.1)
            def serve():
                try:
                    while not stop.is_set():
                        try:connection,_=server.accept()
                        except socket.timeout:continue
                        with connection:
                            request=b''
                            while b'\r\n\r\n' not in request:request+=connection.recv(4096)
                            route=request.split(b' ')[1].decode();routes.append(route)
                            body=json.dumps({'ID':'owned-engine'} if route=='/v1.48/info' else {'Version':'29.9.1'}).encode()
                            connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: '+str(len(body)).encode()+b'\r\nConnection: close\r\n\r\n'+body)
                except BaseException as error:failure.append(error)
            thread=threading.Thread(target=serve,daemon=True);thread.start()
            real_connect=socket.socket.connect
            def connect(client,address):return real_connect(client,str(fixture.root/address.lstrip('/')) if address=='/var/run/docker.sock' else address)
            root_change={}
            def commands(args,**kwargs):
                if args[:3]==['/usr/bin/python3','-I','/usr/local/lib/fleur-owned-guest.py']:
                    result=fixture.root_cli(args[3:])
                    if root_change and result.returncode==0:
                        value=json.loads(result.stdout);value.update(root_change)
                        return SimpleNamespace(returncode=0,stdout=json.dumps(value).encode(),stderr=b'')
                    return result
                if args[0]=='docker':return SimpleNamespace(returncode=0,stdout=b'owned-engine\n',stderr=b'')
                return fixture.virtualized(args,**kwargs)
            try:
                with patch.object(Path,'resolve',lambda value,**kwargs:value),patch.object(socket.socket,'connect',connect),patch('subprocess.run',side_effect=commands):
                    identity=daemon_identity('/run/containerd.sock','/usr/bin/ctr')
                    binding=HostDaemonBinding(fixture.context,identity,'owned-engine')
                    try:binding.verify(30)
                    except (ValueError,OSError,RuntimeError) as error:raise AssertionError("valid owned phase refused: "+repr(error)) from error
                    from privileged_control import verify_root_binding
                    payload,bound=binding.root_arguments(130)
                    verify_root_binding(payload,json.loads(bound),130)
                    for field,value in (('manifestSha256','0'*64),('custodySha256','0'*64),('deadlineMonotonic',131),('runtimeAdmission',True),('rootValidation',1)):
                        root_change.clear();root_change[field]=value
                        with self.subTest(field=field),self.assertRaises(ValueError):verify_root_binding(payload,json.loads(bound),130)
                    root_change.clear()
                    snapshot=json.loads(json.dumps(binding.identity))
                    identity['ctrIdentity'][0]=-1
                    exported=binding.identity;exported['ctrIdentity'][0]=-2
                    self.assertEqual(binding.identity,snapshot,'caller mutation changed retained authority')
                    with patch('subprocess.Popen',side_effect=AssertionError('mismatched operation started privilege')):
                        with self.assertRaises(ValueError):binding.verify_operation('/usr/bin/ctr','/run/other.sock','moby',30)
                    command_file=fixture.root/'proc/47/cmdline';original_command=command_file.read_bytes()
                    command_file.write_bytes(original_command.replace(b'/run/containerd.sock',b'/run/other.sock'))
                    with self.assertRaises(ValueError):binding.verify(30)
                    command_file.write_bytes(original_command)
                    tool=fixture.root/'usr/bin/ctr';tool.write_bytes(b'replaced in place executable')
                    with self.assertRaises(ValueError):binding.verify(30)
                stop.set();thread.join(timeout=2)
                self.assertFalse(thread.is_alive());self.assertEqual(failure,[])
                self.assertEqual(routes,['/v1.48/info','/version']*2)
            finally:stop.set();server.close();endpoint.close();thread.join(timeout=2)
        def diagnose(fixture):
            try:action(fixture)
            except (ValueError,OSError,RuntimeError) as error:raise AssertionError('fixture boundary: '+repr(error)) from error
        custody_fixtures.OwnedGuestCustody().with_context(diagnose)

class RootVersionEnvironment(unittest.TestCase):
    def test_actual_exec_boundary_retains_only_fixed_path_and_warning_suppression(self):
        from privileged_control import exec_root_version
        seen=[]
        def executed(path,args,environment):
            seen.append((path,args,environment));raise SystemExit(0)
        with patch('os.execve',side_effect=executed),patch('time.monotonic',return_value=100):
            with self.assertRaises(SystemExit):exec_root_version(['/usr/bin/ctr','--address','/run/containerd.sock','--namespace','moby','version'],115)
        self.assertEqual(len(seen),1)
        path,args,environment=seen[0]
        self.assertEqual(path,'/usr/bin/timeout')
        self.assertEqual(environment,{'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS':'true'})
        self.assertEqual(args[-1],'version');self.assertIn('--kill-after=0.2s',args)
        self.assertIn('14.0s',args)

if __name__=='__main__':unittest.main()

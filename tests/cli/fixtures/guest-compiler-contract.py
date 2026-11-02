"""Exercise real file custody and the package process boundary without installing."""
import hashlib
import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
import sys
import time
import unittest
from unittest import mock
from types import SimpleNamespace

sys.dont_write_bytecode = True

source = Path(sys.argv.pop(1))
spec = importlib.util.spec_from_file_location('compiler', source)
compiler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compiler)

class CompilerContracts(unittest.TestCase):
    def test_retained_copy_authenticates_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); src=root/'input'; dst=root/'output';src.write_bytes(b'official package fixture')
            pin={'bytes':src.stat().st_size,'sha256':hashlib.sha256(src.read_bytes()).hexdigest()}
            result=compiler.authenticated_copy(src,dst,pin)
            self.assertEqual(dst.read_bytes(),src.read_bytes())
            self.assertEqual(result,pin)
            self.assertEqual(dst.stat().st_mode & 0o777,0o600)
    def test_corruption_symlink_and_oversize_refuse_before_output(self):
        for scenario in ('corrupt','symlink','size'):
            with self.subTest(scenario=scenario),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);src=root/'input';dst=root/'output';target=root/'target';target.write_bytes(b'abc')
                if scenario=='symlink':src.symlink_to(target)
                else:src.write_bytes(b'abd' if scenario=='corrupt' else b'abcd')
                pin={'bytes':3,'sha256':hashlib.sha256(b'abc').hexdigest()}
                with self.assertRaises((RuntimeError,OSError)):compiler.authenticated_copy(src,dst,pin)
                self.assertFalse(dst.exists());self.assertEqual(target.read_bytes(),b'abc')
    def test_existing_destination_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);src=root/'input';dst=root/'output';src.write_bytes(b'abc');dst.write_bytes(b'preserve')
            with self.assertRaises((RuntimeError,OSError)):compiler.authenticated_copy(src,dst,{'bytes':3,'sha256':hashlib.sha256(b'abc').hexdigest()})
            self.assertEqual(dst.read_bytes(),b'preserve')
    def test_exited_leader_cannot_leave_pipe_holding_descendant(self):
        with tempfile.TemporaryDirectory() as directory:
            pidfile=Path(directory)/'child.pid'
            code="import os,time,sys;pid=os.fork();os._exit(0) if pid else None;open(sys.argv[1],'w').write(str(os.getpid()));time.sleep(20)"
            real=time.monotonic;base=real();ready=[]
            def deadline_clock():
                # Python startup takes unbounded time on a busy host, so the deadline counts from the descendant's readiness.
                now=real()
                if not ready and (now-base>10 or pidfile.exists() and pidfile.read_text()):ready.append(now)
                return base+now-ready[0] if ready else base
            with mock.patch.object(time,'monotonic',deadline_clock):
                with self.assertRaises(RuntimeError):compiler.bounded_command([sys.executable,'-c',code,str(pidfile)],timeout=0.3)
            pid=int(pidfile.read_text())
            state=subprocess.run(['/bin/ps','-p',str(pid),'-o','stat='],capture_output=True,text=True).stdout.strip()
            try:self.assertTrue(not state or state.startswith('Z'), 'live compiler descendant survived: '+state)
            finally:
                try:os.kill(pid,9)
                except ProcessLookupError:pass
    def test_changed_installed_driver_is_rejected_before_any_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'compiler';path.write_bytes(b'changed driver bytes');calls=[]
            original_open=os.open;original_fstat=os.fstat
            def opened(name,*args,**kwargs):return original_open(path if str(name)==compiler.COMPILER else name,*args,**kwargs)
            def metadata(fd):
                value=original_fstat(fd)
                return SimpleNamespace(**{name:getattr(value,name) for name in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_mode')},st_uid=0)
            with mock.patch.object(os,'open',side_effect=opened),mock.patch.object(os,'fstat',side_effect=metadata):
                with self.assertRaisesRegex(RuntimeError,'executed pin'):compiler.verify_compiler(lambda args:calls.append(args))
            self.assertEqual(calls,[])
    def test_foreign_compiler_alias_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'foreign';path.write_bytes(b'preserve foreign executable')
            original_lstat=Path.lstat;original_is_symlink=Path.is_symlink;original_symlink=os.symlink
            def lstat(value,*args,**kwargs):
                if str(value) in ('/','/usr','/usr/local','/usr/local/bin'):
                    return SimpleNamespace(st_mode=0o40755,st_uid=0)
                return original_lstat(value,*args,**kwargs)
            def symlink(target,name,*args,**kwargs):
                if str(name)=='/usr/local/bin/gcc':raise FileExistsError('foreign alias')
                return original_symlink(target,name,*args,**kwargs)
            with mock.patch.object(Path,'lstat',lstat),mock.patch.object(os,'symlink',side_effect=symlink),mock.patch.object(Path,'is_symlink',lambda value:False if str(value)=='/usr/local/bin/gcc' else original_is_symlink(value)):
                with self.assertRaisesRegex(RuntimeError,'preserved'):compiler.ensure_alias()
            self.assertEqual(path.read_bytes(),b'preserve foreign executable')
    def test_cli_rejects_override_and_never_installs(self):
        result=subprocess.run([sys.executable,'-I',str(source),'deadbeef-dead-4ead-bead-deadbeefdead','--manifest','foreign.json'],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,4)
        report=json.loads(result.stdout)
        self.assertFalse(report['ok']);self.assertFalse(report['fleurSetupAction'])
        self.assertEqual(report['runtimeSupport'],'unverified')
        self.assertIn('accepts only',report['error']['message'])
    def test_cli_rejects_unowned_os_before_package_changes(self):
        result=subprocess.run([sys.executable,'-I',str(source),'deadbeef-dead-4ead-bead-deadbeefdead'],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,4)
        report=json.loads(result.stdout)
        self.assertFalse(report['ok']);self.assertNotIn('packages',report)
        self.assertEqual(report['error']['code'],'COMPILER_PREREQUISITE_FAILED')
    def test_source_manifest_authentication_rejects_changed_bytes(self):
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);copied=root/source.name;shutil.copyfile(source,copied)
            (root/'guest-compiler-ubuntu24-amd64.json').write_text('{"formatVersion":1,"artifacts":[]}')
            spec=importlib.util.spec_from_file_location('changed_compiler',copied)
            changed=importlib.util.module_from_spec(spec);spec.loader.exec_module(changed)
            with self.assertRaisesRegex(RuntimeError,'manifest differs'):changed.manifest()

unittest.main()

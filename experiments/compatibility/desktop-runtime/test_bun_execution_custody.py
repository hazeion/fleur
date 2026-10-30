"""Driver regressions execute private synthetic programs, never Docker."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('bun_execution_custody_outer',Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py')
outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)

class BunExecutionCustody(unittest.TestCase):
    def execute(self, launch='version', mutation='rename', mode=0o700, foreign_owner=False):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory).resolve()/'selected bun';marker=source.parent/'unauthorized-execution'
            proof={'ok':True,'candidate':'foreign','controlCapabilityVerified':True,'originalPreserved':True,'transportUncertain':False}
            program=('#!'+sys.executable+'\nimport sys\nprint("1.4.3" if "--version" in sys.argv else '+repr(json.dumps(proof))+')\n').encode()
            replacement=('#!'+sys.executable+'\nfrom pathlib import Path\nPath('+repr(str(marker))+').write_text("executed")\n'+program.decode().split('\n',1)[1]).encode()
            source.write_bytes(program);source.chmod(mode)
            events=[];launched=[];real_bounded=outer.processes.bounded;real_fstat=os.fstat;source_inode=source.stat().st_ino
            def fstat(fd):
                value=real_fstat(fd)
                if foreign_owner and value.st_ino==source_inode:
                    fields={name:getattr(value,name) for name in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_size','st_mtime_ns','st_ctime_ns')}
                    return SimpleNamespace(**{**fields,'st_uid':os.geteuid()+12345})
                return value
            def bounded(args,**kwargs):
                events.append(args);stdout=b''
                if args[0]=='/usr/sbin/sysctl':stdout=b'7\n'
                elif args[:2]==['git','rev-parse']:stdout=b'a'*40+b'\n'
                elif args[:2]==['git','diff']:pass
                elif args[:2]==['git','show']:stdout=(outer.ROOT/args[2].split(':',1)[1]).read_bytes()
                elif args[1:] == ['--version'] or args[1:2]==['scripts/observe-desktop-control.ts']:
                    selected='version' if args[1]=='--version' else 'preflight'
                    if selected==launch:
                        if mutation=='rename':
                            alternate=source.parent/'replacement';alternate.write_bytes(replacement);alternate.chmod(0o700);alternate.replace(source)
                        elif mutation=='in-place':source.write_bytes(replacement)
                    executable=Path(args[0]);launched.append((str(executable),executable.read_bytes(),stat.S_IMODE(executable.stat().st_mode),executable.stat().st_uid))
                    if mode&0o6000 or foreign_owner:
                        return SimpleNamespace(returncode=0,stdout=b'1.4.3\n' if selected=='version' else json.dumps(proof).encode(),stderr=b'')
                    return real_bounded(args,**kwargs)
                else:raise AssertionError('unexpected external command')
                return SimpleNamespace(returncode=0,stdout=stdout,stderr=b'')
            with patch.dict(os.environ,{'FLEUR_DESKTOP_RUNTIME_QUALIFICATION':'yes'}),patch.object(outer.platform,'system',return_value='Darwin'),patch.object(outer.platform,'machine',return_value='x86_64'),patch.object(outer.processes,'bounded',side_effect=bounded),patch.object(outer,'BUN_SHA256',hashlib.sha256(program).hexdigest()),patch.object(outer.os,'fstat',side_effect=fstat):
                result=outer.observe('--capabilities',directory,candidate='desktop-4.97.0-244584',pinned_bun=str(source))
            self.assertFalse(result['ok']);self.assertFalse(result['runtimeAdmission'])
            executed=marker.exists()
            for path,*_ in launched:
                if path!=str(source):self.assertFalse(Path(path).exists(),'private executable must retire after command clients')
            return result,executed,launched,program

    def assert_replacement_isolated(self,launch,mutation):
        result,executed,launched,program=self.execute(launch,mutation)
        self.assertEqual(result['error'],'PINNED_BUN_REQUIRED')
        self.assertFalse(executed)
        self.assertEqual(len(launched),1 if launch=='version' else 2)
        for _,body,mode,owner in launched:
            self.assertEqual(body,program);self.assertEqual(mode,0o500);self.assertEqual(owner,os.geteuid())

    def test_pathname_replacement_before_version_never_executes_replacement(self):
        self.assert_replacement_isolated('version','rename')

    def test_in_place_replacement_before_version_never_executes_replacement(self):
        self.assert_replacement_isolated('version','in-place')

    def test_pathname_replacement_before_preflight_never_executes_replacement(self):
        self.assert_replacement_isolated('preflight','rename')

    def test_in_place_replacement_before_preflight_never_executes_replacement(self):
        self.assert_replacement_isolated('preflight','in-place')

    def test_setuid_source_refuses_before_any_execution(self):
        result,executed,launched,_=self.execute(launch="none",mode=0o4700)
        self.assertEqual(result['error'],'PINNED_BUN_REQUIRED');self.assertFalse(executed);self.assertEqual(launched,[])

    def test_setgid_source_refuses_before_any_execution(self):
        result,executed,launched,_=self.execute(launch="none",mode=0o2700)
        self.assertEqual(result['error'],'PINNED_BUN_REQUIRED');self.assertFalse(executed);self.assertEqual(launched,[])

    def test_foreign_owner_refuses_before_any_execution(self):
        result,executed,launched,_=self.execute(launch="none",foreign_owner=True)
        self.assertEqual(result['error'],'PINNED_BUN_REQUIRED');self.assertFalse(executed);self.assertEqual(launched,[])

    def test_normal_launches_execute_only_authenticated_nonprivileged_private_bytes(self):
        result,executed,launched,program=self.execute(launch='none')
        self.assertEqual(result['error'],'CONTROL_PREFLIGHT_CANDIDATE_CHANGED')
        self.assertFalse(executed);self.assertEqual(len(launched),2)
        for _,body,mode,owner in launched:
            self.assertEqual(body,program);self.assertEqual(mode,0o500);self.assertEqual(owner,os.geteuid())

class PinnedMachOExecution(unittest.TestCase):
    @unittest.skipUnless(sys.platform=='darwin' and os.environ.get('FLEUR_TEST_PINNED_BUN'),'explicit existing pinned Darwin Bun required; no Docker')
    def test_actual_macho_snapshot_survives_source_rename_and_in_place_updates_at_both_launches(self):
        chosen=Path(os.environ['FLEUR_TEST_PINNED_BUN']).resolve(strict=True)
        outer.verify_pinned_bun(chosen)
        javascript='const h=new Bun.CryptoHasher("sha256");h.update(await Bun.file(process.execPath).arrayBuffer());console.log(JSON.stringify({version:Bun.version,sha256:h.digest("hex")}));'
        for launch in ('version','preflight'):
            for mutation in ('rename','in-place'):
                with self.subTest(launch=launch,mutation=mutation),tempfile.TemporaryDirectory() as directory:
                    source=Path(directory)/'source';shutil.copyfile(chosen,source);source.chmod(0o700)
                    marker=Path(directory)/'unauthorized-execution'
                    replacement=('#!'+sys.executable+'\nfrom pathlib import Path\nPath('+repr(str(marker))+').touch()\nprint("1.4.3")\n').encode()
                    with outer.pinned_bun_snapshot(source) as (executable,_):
                        for phase,args in (('version',['--version']),('preflight',['-e',javascript])):
                            if phase==launch:
                                if mutation=='rename':
                                    alternate=Path(directory)/'replacement';alternate.write_bytes(replacement);alternate.chmod(0o700);alternate.replace(source)
                                else:source.write_bytes(replacement)
                            result=outer.processes.bounded([str(executable),*args],timeout=8)
                            self.assertEqual(result.returncode,0);self.assertEqual(result.stderr,b'')
                            if phase=='version':self.assertEqual(result.stdout,b'1.4.3\n')
                            else:self.assertEqual(json.loads(result.stdout),{'version':'1.4.3','sha256':outer.BUN_SHA256})
                    self.assertFalse(marker.exists());self.assertFalse(executable.exists())

if __name__=='__main__':unittest.main()

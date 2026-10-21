"""Real authenticated files and OS filesystem seams; never execute Linux tools."""
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
sys.dont_write_bytecode = True
source = Path(sys.argv.pop(1)); archive = Path(sys.argv.pop(1))
spec = importlib.util.spec_from_file_location('compiler', source); compiler = importlib.util.module_from_spec(spec); spec.loader.exec_module(compiler)
with tarfile.open(archive) as contents:
    payloads = {name: contents.extractfile('./usr/bin/'+name).read() for name in ('x86_64-linux-gnu-as', 'x86_64-linux-gnu-ld.bfd')}
assert hashlib.sha256(payloads['x86_64-linux-gnu-as']).hexdigest() == '21aff249b692b5c31a44007491f922dcb49f41323e362c57d2ada3f52eddb7f0'
assert hashlib.sha256(payloads['x86_64-linux-gnu-ld.bfd']).hexdigest() == 'e9ceb054c12207970f2726dfc07e9a66b411602748628baf27399f02a9bbb31b'
class Contracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name); self.calls = []
        for directory in ('usr/bin','usr/local/bin','usr/local/sbin','usr/sbin','bin','sbin','var/tmp'):
            (self.root/directory).mkdir(parents=True, exist_ok=True)
        for name, body in payloads.items():
            target=self.root/'usr/bin'/name; target.write_bytes(body); target.chmod(0o755)
        self.original = {name:getattr(os,name) for name in ('open','lstat','stat','fstat','readlink','symlink','rename')}
        self.original_temp = tempfile.mkdtemp; self.fds = {}; self.owner_override = {}; self.symlink_fault = None; self.rename_fault = None; self.stat_fault = None
        def mapped(path):
            if isinstance(path,(str,Path)) and str(path).startswith(('/usr/','/bin/','/sbin/','/var/tmp')): return self.root/str(path).lstrip('/')
            if str(path) in ('/','/usr','/bin','/sbin'): return self.root/str(path).lstrip('/')
            return path
        self.mapped=mapped
        def metadata(value, name=None):
            fields={key:getattr(value,key) for key in dir(value) if key.startswith('st_')}; fields['st_uid']=self.owner_override.get(str(name),0); return SimpleNamespace(**fields)
        def observed_stat(path,*args,**kwargs):
            if self.stat_fault: self.stat_fault(path,kwargs)
            return metadata(self.original['stat'](mapped(path),*args,**kwargs),path)
        def fdmetadata(fd):
            value=metadata(self.original['fstat'](fd),self.fds.get(fd));value.st_uid=self.owner_override.get('fd:'+str(self.fds.get(fd)),value.st_uid);return value
        def opened(path,*args,**kwargs):
            fd=self.original['open'](mapped(path),*args,**kwargs); self.fds[fd]=str(path); return fd
        def symlink(target,path,*args,**kwargs):
            if self.symlink_fault: self.symlink_fault(target,path)
            return self.original['symlink'](target,mapped(path),*args,**kwargs)
        def rename(src,dst,*args,**kwargs):
            if self.rename_fault: self.rename_fault(src,dst,kwargs)
            return self.original['rename'](mapped(src),mapped(dst),*args,**kwargs)
        self.patches=[mock.patch.object(os,'open',opened),mock.patch.object(os,'lstat',lambda p,*a,**k:metadata(self.original['lstat'](mapped(p),*a,**k),p)),mock.patch.object(os,'stat',observed_stat),mock.patch.object(os,'fstat',fdmetadata),mock.patch.object(os,'readlink',lambda p,*a,**k:self.original['readlink'](mapped(p),*a,**k)),mock.patch.object(os,'symlink',symlink),mock.patch.object(os,'rename',rename),mock.patch.object(tempfile,'mkdtemp',lambda *a,**k:self.original_temp(*a,**{**k,'dir':mapped(k['dir'])}) if k.get('dir')=='/var/tmp' else self.original_temp(*a,**k))]
        for patch in self.patches: patch.start()
        compiler.STATE.clear()
    def tearDown(self):
        for patch in reversed(self.patches): patch.stop()
        self.temp.cleanup()
    def command(self,args,timeout=60):
        self.calls.append((args,timeout)); self.assertIn(args[0],(compiler.COMPILER,str(compiler.ALIAS))); self.assertEqual(timeout,5)
        self.assertIn(args[1],('-print-prog-name=as','-print-prog-name=ld')); return args[1].split('=')[1]+'\n'
    def aliases(self): return compiler.authenticated_binutils_aliases(self.command)
    def alias(self,name): return self.root/'usr/local/bin'/name
    def test_authenticated_targets_exposed_and_search_proven_without_compilation(self):
        with self.aliases() as receipt:
            self.assertEqual(self.original['readlink'](self.alias('as')),'/usr/bin/x86_64-linux-gnu-as')
            self.assertEqual(self.original['readlink'](self.alias('ld')),'/usr/bin/x86_64-linux-gnu-ld.bfd')
        self.assertEqual(set(receipt['compilerSearch']), {compiler.COMPILER, str(compiler.ALIAS)})
        self.assertTrue(all(values == {'as': '/usr/local/bin/as', 'ld': '/usr/local/bin/ld'} for values in receipt['compilerSearch'].values()))
        self.assertEqual({row['path'] for row in receipt['aliases']}, {'/usr/local/bin/as', '/usr/local/bin/ld'})
        self.assertTrue(all(row['created'] and row['targetSha256'] in [hashlib.sha256(body).hexdigest() for body in payloads.values()] for row in receipt['aliases']))
    def test_missing_target_never_exposes_alias(self):
        (self.root/'usr/bin/x86_64-linux-gnu-as').unlink()
        with self.assertRaises(OSError):
            with self.aliases(): pass
        self.assertFalse(self.alias('as').is_symlink()); self.assertEqual(self.calls,[])
    def test_corrupt_target_never_exposes_alias(self):
        p=self.root/'usr/bin/x86_64-linux-gnu-as'; body=bytearray(p.read_bytes());body[-1]^=1;p.write_bytes(body)
        with self.assertRaises(RuntimeError):
            with self.aliases(): pass
        self.assertFalse(self.alias('as').is_symlink());self.assertEqual(self.calls,[])
    def test_target_symlink_refused(self):
        p=self.root/'usr/bin/x86_64-linux-gnu-as';p.unlink();p.symlink_to(self.root/'usr/bin/x86_64-linux-gnu-ld.bfd')
        with self.assertRaises(OSError):
            with self.aliases():pass
        self.assertFalse(self.alias('as').is_symlink())
    def test_unprotected_target_refused(self):
        (self.root/'usr/bin/x86_64-linux-gnu-as').chmod(0o777)
        with self.assertRaises(RuntimeError):
            with self.aliases():pass
        self.assertFalse(self.alias('as').is_symlink())
    def test_occupied_generic_tool_is_preserved(self):
        p=self.root/'usr/local/sbin/as';p.write_bytes(b'foreign executable');p.chmod(0o755)
        with self.assertRaises(RuntimeError):
            with self.aliases():pass
        self.assertEqual(p.read_bytes(),b'foreign executable');self.assertFalse(self.alias('as').is_symlink())
    def test_second_alias_creation_failure_removes_only_owned_first(self):
        def fault(target,path):
            if str(path)=='ld':raise PermissionError('injected second symlink refusal')
        self.symlink_fault=fault
        with self.assertRaises(PermissionError):
            with self.aliases():pass
        self.assertFalse(self.alias('as').is_symlink());self.assertFalse(self.alias('ld').is_symlink())
    def test_compiler_search_shadow_refused_and_aliases_rolled_back(self):
        with self.assertRaises(RuntimeError):
            with compiler.authenticated_binutils_aliases(lambda args,timeout:'/foreign/as'):
                self.fail('shadow search was accepted')
        self.assertFalse(self.alias('as').is_symlink());self.assertFalse(self.alias('ld').is_symlink())
    def test_changed_target_after_use_fails_and_rolls_back(self):
        with self.assertRaises(RuntimeError):
            with self.aliases():
                p=self.root/'usr/bin/x86_64-linux-gnu-as';p.write_bytes(b'changed')
        self.assertFalse(self.alias('as').is_symlink());self.assertFalse(self.alias('ld').is_symlink())
    def test_foreign_replacement_at_atomic_claim_is_retained_not_deleted(self):
        fired=[]
        def fault(src,dst,kwargs):
            if src=='as' and not fired:
                fired.append(True);self.alias('as').unlink();self.alias('as').write_bytes(b'foreign replacement')
        self.rename_fault=fault
        with self.assertRaisesRegex(RuntimeError, 'original helper compile failure.*cleanup could not be confirmed'):
            with self.aliases():raise RuntimeError('original helper compile failure')
        self.assertTrue(fired);self.assertTrue(any(p.is_file() and not p.is_symlink() and p.read_bytes()==b'foreign replacement' for p in (self.root/'var/tmp').rglob('*')))
        self.assertFalse(self.alias('ld').is_symlink());self.assertFalse(compiler.STATE['binutilsAliases']['cleanupConfirmed'])
    def test_occupied_alias_symlink_is_preserved(self):
        self.alias('ld').symlink_to('/foreign/usable-linker')
        with self.assertRaisesRegex(RuntimeError, 'preserved'):
            with self.aliases(): self.fail('occupied alias accepted')
        self.assertEqual(self.original['readlink'](self.alias('ld')), '/foreign/usable-linker')
        self.assertFalse(self.alias('as').is_symlink())
    def test_foreign_owner_and_hardlinked_target_are_refused(self):
        self.owner_override['/usr/bin/x86_64-linux-gnu-as'] = 123
        with self.assertRaisesRegex(RuntimeError, 'custody'):
            with self.aliases(): self.fail('foreign target owner accepted')
        self.owner_override.clear()
        os.link(self.root/'usr/bin/x86_64-linux-gnu-as',self.root/'hardlink')
        with self.assertRaisesRegex(RuntimeError, 'custody'):
            with self.aliases(): self.fail('hardlinked target accepted')
        self.assertFalse(self.alias('as').is_symlink())
    def test_search_command_failure_propagates_and_rolls_back(self):
        def refused(args, timeout): raise RuntimeError('external command failed')
        with self.assertRaisesRegex(RuntimeError, 'external command failed'):
            with compiler.authenticated_binutils_aliases(refused): self.fail('failed command accepted')
        self.assertFalse(self.alias('as').is_symlink());self.assertFalse(self.alias('ld').is_symlink())
    def test_post_create_observation_failure_preserves_unknown_alias_and_refuses_cleanup_claim(self):
        fired=[]
        def fault(path,kwargs):
            if path=='as' and 'dir_fd' in kwargs and not fired:
                fired.append(True);raise PermissionError('post-create stat refused')
        self.stat_fault=fault
        with self.assertRaisesRegex(RuntimeError, 'post-create stat refused.*cleanup could not be confirmed'):
            with self.aliases():self.fail('unknown creation accepted')
        self.assertTrue(self.alias('as').is_symlink());self.assertFalse(self.alias('ld').is_symlink())
        self.assertFalse(compiler.STATE['binutilsAliases']['cleanupConfirmed'])
    def test_retained_alias_parent_custody_refused_before_mutation(self):
        self.owner_override['fd:/usr/local/bin']=123
        with self.assertRaisesRegex(RuntimeError, 'parent custody'):
            with self.aliases():self.fail('retained foreign parent accepted')
        self.assertFalse(self.alias('as').is_symlink());self.assertFalse(self.alias('ld').is_symlink())
    def test_alias_replacement_during_search_is_refused_before_use(self):
        fired=[]
        def command(args,timeout):
            result=self.command(args,timeout)
            if not fired:
                fired.append(True);self.alias('as').unlink();self.alias('as').write_bytes(b'foreign search replacement')
            return result
        entered=[]
        with self.assertRaises(RuntimeError):
            with compiler.authenticated_binutils_aliases(command):entered.append(True)
        self.assertFalse(entered, 'replaced alias reached compilation boundary')
        self.assertEqual(self.alias('as').read_bytes(),b'foreign search replacement')
        self.assertFalse(self.alias('ld').is_symlink())
        self.assertFalse(compiler.STATE['binutilsAliases']['cleanupConfirmed'])
unittest.main()

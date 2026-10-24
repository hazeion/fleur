"""Independent recovery guest deadline requirements; no guest module import."""
import ast
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch
import unittest

HERE = Path(__file__).parent
PORT = ast.parse((HERE / 'debian-interruption-guest.py').read_text())


def identity(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


class AccessCheckpointDeadlineRequirements(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.guest = SimpleNamespace(budget_seconds=lambda value:value, file_identity=identity,
                                     REPORT={'qualificationSource': {'sha256': 'e'*64}})
        self.namespace = {'ROOT':self.root, 'guest':self.guest, 'os':os, 'Path':Path, 'stat':stat,
                          'hashlib':hashlib, 'json':json, 'math':math, 're':re, 'time':time}
        definitions = [node for node in PORT.body if isinstance(node, ast.FunctionDef)
                       and node.name in ('read_checkpoint_record', 'access_checkpoint_deadline')]
        self.assertEqual(len(definitions), 2)
        exec(compile(ast.Module(body=definitions,type_ignores=[]), '<deadline-functions>', 'exec'), self.namespace)
        self.access = self.namespace['access_checkpoint_deadline']

    def checkpoint(self, deadline, mode=0o600):
        path = self.root / 'fresh-linux-state.json'
        body = json.dumps({'guestDeadlineMonotonic':deadline}, separators=(',',':')).encode()
        path.write_bytes(body)
        path.chmod(mode)
        return hashlib.sha256(body).hexdigest(), body

    def test_original_exact_checkpoint_deadline_survives_different_ssh_start_latency(self):
        digest, before = self.checkpoint(1030.125)
        with patch.object(time, 'monotonic', return_value=1000):
            # The recomputed remaining-host budget would give 1010, earlier
            # than the valid original guest checkpoint by startup-clock skew.
            self.assertEqual(self.access(digest,10),1030.125)
        self.assertEqual((self.root / 'fresh-linux-state.json').read_bytes(), before)

    def test_access_entry_point_uses_authenticated_deadline_without_reconstruction(self):
        digest, before = self.checkpoint(1030.125)
        outer = next(node for node in PORT.body if isinstance(node,ast.If) and isinstance(node.test,ast.Compare)
                     and isinstance(node.test.left,ast.Name) and node.test.left.id == '__name__')
        branch = next(node for node in outer.body[0].body if isinstance(node,ast.If) and '--resume-access' in ast.unparse(node.test))
        self.assertIn('--resume-access',ast.unparse(branch.test))
        received=[]
        self.guest.parse_recorded_guest_invocation=lambda arguments:('nonce',None,object(),True)
        self.guest.verify_owned_binding=lambda binding:None
        self.guest.resume_guest=lambda *arguments:received.append(self.guest.GUEST_DEADLINE)
        self.namespace.update(sys=SimpleNamespace(argv=['helper','--resume-access',digest,'10','nonce']),SOURCE_SHA='e'*64)
        with patch.object(time,'monotonic',return_value=1000), patch.object(Path,'read_text',return_value='systemd'):
            exec(compile(ast.Module(body=branch.body,type_ignores=[]),'<actual-access-entry-point>','exec'),self.namespace)
        self.assertEqual(received,[1030.125])
        self.assertEqual((self.root / 'fresh-linux-state.json').read_bytes(),before)

    def test_bad_digest_and_nonfinite_expired_or_reset_deadlines_refuse(self):
        for deadline in (float('nan'),float('inf'),float('-inf'),1000,999,1901,True,'1030'):
            with self.subTest(deadline=deadline):
                digest,_=self.checkpoint(deadline)
                with patch.object(time,'monotonic',return_value=1000), self.assertRaises(RuntimeError):
                    self.access(digest,10)
        digest,_=self.checkpoint(1030)
        for wrong in ('f'*64,'','x'*64,None,True):
            with self.subTest(digest=wrong), patch.object(time,'monotonic',return_value=1000), self.assertRaises(RuntimeError):
                self.access(wrong,10)

    def test_budget_is_bounded_numeric_and_never_boolean(self):
        digest,_=self.checkpoint(1030)
        for budget in (0,0.99,901,float('nan'),float('inf'),True,'10',None):
            with self.subTest(budget=budget), patch.object(time,'monotonic',return_value=1000), self.assertRaises(RuntimeError):
                self.access(digest,budget)

    def test_authenticated_checkpoint_requires_private_regular_single_link_file(self):
        digest,_=self.checkpoint(1030,0o644)
        with self.assertRaises(RuntimeError):self.access(digest,10)
        path=self.root/'fresh-linux-state.json'
        path.chmod(0o600)
        os.link(path,self.root/'alias')
        with self.assertRaises(RuntimeError):self.access(digest,10)
        path.unlink()
        path.symlink_to(self.root/'alias')
        with self.assertRaises(OSError):self.access(digest,10)


class QualificationSourceRequirements(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name)
        self.namespace={'ROOT':self.root,'os':os,'Path':Path,'stat':stat,'hashlib':hashlib,'json':json,'re':re}
        definitions=[node for node in PORT.body if isinstance(node,ast.FunctionDef)
                     and node.name in ('qualified_source','load_qualification_source')]
        self.assertEqual(len(definitions),2)
        exec(compile(ast.Module(body=definitions,type_ignores=[]),'<source-record-functions>','exec'),self.namespace)
        self.load=self.namespace['load_qualification_source']
        names=('fresh-linux-guest.py','fleur-interrupted-guest.py','fleur-transition-owned-reboot.py',
               'fleur-interruption-supervisor-selftest.py','fleur-native-inspector-conformance.ts',
               'debian_recovery_contract.py','debian-recovery-preservation.py')
        self.record={'formatVersion':1,'scope':'source-owned-debian-interruption-inputs','sourceCommit':'a'*40,
                     'ordinaryArchiveSha256':self.file('fleur-internal-native-candidate.tgz',b'ordinary archive'),
                     'files':{name:self.file(name,('pinned input '+name).encode()) for name in names}}

    def file(self,name,body):
        path=self.root/name
        path.write_bytes(body);path.chmod(0o600)
        return hashlib.sha256(body).hexdigest()

    def publish(self,record=None,body=None):
        if body is None:body=json.dumps(self.record if record is None else record,separators=(',',':')).encode()
        return self.file('qualification-source.json',body)

    def test_exact_host_digest_binds_closed_seven_files_and_ordinary_archive(self):
        digest=self.publish()
        before={p.name:p.read_bytes() for p in self.root.iterdir()}
        self.assertEqual(self.load(digest),self.record)
        self.assertEqual({p.name:p.read_bytes() for p in self.root.iterdir()},before)
        with self.assertRaises(RuntimeError):self.load('f'*64)

    def test_record_schema_and_each_declared_input_hash_are_closed(self):
        import copy
        mutations=[lambda r:r.update(formatVersion=True),lambda r:r.update(formatVersion=2),
                   lambda r:r.update(scope='caller-owned'),lambda r:r.update(sourceCommit='bad'),
                   lambda r:r.update(ordinaryArchiveSha256='bad'),lambda r:r.update(extra=True),
                   lambda r:r['files'].pop('debian_recovery_contract.py'),lambda r:r['files'].update(extra='a'*64),
                   lambda r:r['files'].update({'fresh-linux-guest.py':'bad'}),
                   lambda r:r['files'].update({'fresh-linux-guest.py':'f'*64}),
                   lambda r:r.update(ordinaryArchiveSha256='f'*64)]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                record=copy.deepcopy(self.record);mutate(record)
                with self.assertRaises(RuntimeError):self.load(self.publish(record))
        duplicate=json.dumps(self.record,separators=(',',':'))[:-1]+',"formatVersion":1}'
        with self.assertRaises(RuntimeError):self.load(self.publish(body=duplicate.encode()))

    def test_changed_bytes_symlink_hardlink_or_writable_source_is_not_authenticated(self):
        digest=self.publish()
        name='debian-recovery-preservation.py';path=self.root/name;original=path.read_bytes()
        self.file(name,b'changed')
        with self.assertRaises(RuntimeError):self.load(digest)
        self.file(name,original);path.chmod(0o622)
        with self.assertRaises(RuntimeError):self.load(digest)
        path.chmod(0o600);alias=self.root/'alias';os.link(path,alias)
        with self.assertRaises(RuntimeError):self.load(digest)
        path.unlink();path.symlink_to(alias)
        with self.assertRaises(OSError):self.load(digest)

    def test_source_record_and_archive_require_their_own_protected_bytes(self):
        digest=self.publish()
        record_path=self.root/'qualification-source.json'
        record_path.chmod(0o644)
        # Read-only sharing is permitted; group/world writes are refused.
        self.assertEqual(self.load(digest),self.record)
        record_path.chmod(0o622)
        with self.assertRaises(RuntimeError):self.load(digest)
        record_path.chmod(0o600)
        self.file('fleur-internal-native-candidate.tgz',b'changed archive')
        with self.assertRaises(RuntimeError):self.load(digest)


class CheckpointSerializationRequirements(unittest.TestCase):
    def fixture(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location('serialization_canary_fixture',HERE/'test_debian_recovery_contract.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module,module.preservation_fixture()

    def serializer(self,tree,function_name,payload):
        function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name==function_name)
        assignment=next(node for node in ast.walk(function) if isinstance(node,ast.Assign)
                        and any(isinstance(target,ast.Name) and target.id=='body' for target in node.targets)
                        and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute)
                        and node.value.func.attr=='encode')
        return eval(compile(ast.Expression(body=assignment.value),'<actual-checkpoint-serializer>','eval'),{'json':json,'payload':payload})

    def test_interruption_checkpoint_preserves_original_boot_phase_order(self):
        module,(old,new,report)=self.fixture()
        payload={'evidence':{'debianRecoveryPreservation':{'scope':report['scope'],
                 'historicalKernelRulesContinuity':False,'original':report['original']}}}
        saved=self.serializer(PORT,'initial_phase',payload)
        restored=json.loads(saved)['evidence']['debianRecoveryPreservation']['original']
        self.assertEqual(tuple(restored['observations']),module.ORIGINAL_PHASES)
        self.assertIsNone(module.contract.validate_boot_ledger(old,'original',restored))

    def test_fresh_access_checkpoint_preserves_both_semantic_phase_orders(self):
        module,(old,new,report)=self.fixture()
        fresh=ast.parse((HERE/'fresh-linux-guest.py').read_text())
        saved=self.serializer(fresh,'publish_handoff',{'report':{'debianRecoveryPreservation':report}})
        restored=json.loads(saved)['report']['debianRecoveryPreservation']
        self.assertEqual(tuple(restored['original']['observations']),module.ORIGINAL_PHASES)
        self.assertEqual(tuple(restored['current']['observations']),module.CURRENT_PHASES)
        self.assertIsNone(module.contract.validate_two_boot_preservation(old,new,restored))


class ReadonlyHostObservationRequirements(unittest.TestCase):
    def setUp(self):
        self.now=1000.0;self.calls=[]
        self.owner={'nonce':'11111111-1111-4111-8111-111111111111','bootId':'22222222-2222-4222-8222-222222222222','uid':1000,'manifestSha256':'b'*64}
        self.binding=SimpleNamespace(_asdict=lambda:dict(self.owner))
        self.result={'formatVersion':1,'scope':'debian-recovery-readonly-host-observation','readOnly':True,
                     'binding':dict(self.owner),'packageLockObservation':'unknown','serviceProvenance':{'verified':False}}
        self.response=json.dumps(self.result)
        def verify(binding,**kwargs):
            self.assertIs(binding,self.binding);self.calls.append(('verify',kwargs));self.now+=0.5
        def run(arguments,**kwargs):
            self.calls.append(('run',arguments,kwargs));self.now+=0.5;return 0,self.response,''
        guest=SimpleNamespace(BUN='/fixture/bun',CLI='/fixture/lab/package/bin/fleur.ts',REPORT={'ok':False,'automaticRecovery':{'exitCode':5}},
                              verify_owned_binding=verify,budget_seconds=lambda maximum:min(maximum,7),run=run)
        bridge_tree=ast.parse((HERE/'debian-recovery-preservation.py').read_text())
        unique=next(node for node in bridge_tree.body if isinstance(node,ast.FunctionDef) and node.name=='unique_object')
        hook={};exec(compile(ast.Module(body=[unique],type_ignores=[]),'<unique-observation-json>','exec'),hook)
        root=next(ast.literal_eval(node.value) for node in PORT.body if isinstance(node,ast.Assign)
                  and any(isinstance(t,ast.Name) and t.id=='RECOVERY_HOST_OBSERVATION' for t in node.targets))
        namespace={'guest':guest,'time':SimpleNamespace(monotonic=lambda:self.now),'Path':Path,'json':json,
                   'bridge':SimpleNamespace(unique_object=hook['unique_object']),'RECOVERY_HOST_OBSERVATION':root}
        function=next(node for node in PORT.body if isinstance(node,ast.FunctionDef) and node.name=='observe_recovery_host')
        exec(compile(ast.Module(body=[function],type_ignores=[]),'<actual-observation-wrapper>','exec'),namespace)
        self.observe=namespace['observe_recovery_host'];self.guest=guest

    def test_both_custody_checks_and_child_share_original_twenty_second_or_global_deadline(self):
        self.observe('beforeReconciliation',self.binding)
        self.assertEqual([call[0] for call in self.calls],['verify','run','verify'])
        self.assertEqual(self.calls[0][1],{'absolute_deadline':1007.0})
        self.assertEqual(self.calls[1][2],{'timeout':20,'absolute_deadline':1007.0})
        self.assertEqual(self.calls[2][1],{'absolute_deadline':1007.0})
        self.assertEqual(self.calls[1][1][-2],'6500')
        self.assertEqual(self.guest.REPORT['recoveryHostObservations']['beforeReconciliation'],self.result)
        self.assertIs(self.guest.REPORT['ok'],False)
        self.assertEqual(self.guest.REPORT['automaticRecovery'],{'exitCode':5})

    def test_bad_phase_makes_no_custody_or_child_call(self):
        with self.assertRaises(RuntimeError):self.observe('afterRuntime',self.binding)
        self.assertEqual(self.calls,[])

    def test_unbound_malformed_duplicate_or_oversized_observation_is_never_recorded(self):
        for field,value in [('scope','other'),('readOnly',False),('binding',{**self.owner,'uid':1001})]:
            with self.subTest(field=field):
                self.setUp();self.response=json.dumps({**self.result,field:value})
                with self.assertRaises(RuntimeError):self.observe('beforeReconciliation',self.binding)
                self.assertNotIn('recoveryHostObservations',self.guest.REPORT)
        for response in ('x'*65537,'{"formatVersion":1,"formatVersion":1}'):
            with self.subTest(length=len(response)):
                self.setUp();self.response=response
                with self.assertRaises((RuntimeError,ValueError)):self.observe('beforeReconciliation',self.binding)
                self.assertNotIn('recoveryHostObservations',self.guest.REPORT)


if __name__ == '__main__':
    unittest.main()

"""Minimized observer/preflight -> serialized binding -> actual controller guard.

Only host file/command boundaries are fixtures. No Docker or payload executes.
The caller AST slices retain the exact production checks and both binding writes.
"""
import ast
import hashlib
import importlib.util
import inspect
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import test_root_launch_callsite as controller_fixture

PATH=Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py'
spec=importlib.util.spec_from_file_location('candidate_callsite_outer',PATH)
outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)
LEGACY='desktop-4.96.1-244132'
CURRENT='desktop-4.97.0-244584'

class CandidateCallsite(unittest.TestCase):
    def binding(self,selected=CURRENT,observed='Docker Desktop 4.97.0 (244584)',proof_candidate=None):
        selected=inspect.signature(outer.observe).parameters['candidate'].default if selected is None else selected
        proof={'candidate':selected if proof_candidate is None else proof_candidate,'ok':True,'controlCapabilityVerified':True,'originalPreserved':True,'transportUncertain':False}
        source={'sources':{'entry.py':hashlib.sha256(b'source').hexdigest()}}
        environment={'candidate':selected,'CANDIDATES':outer.CANDIDATES,'preflight':SimpleNamespace(stdout=json.dumps(proof).encode()),'artifacts':outer.artifacts,
            'nonce':'a1234567-1234-4234-8234-123456789abc','boot':'b1234567-1234-4234-8234-123456789abc','daemon':'actual-daemon',
            'version':{'KernelVersion':'7.0.14-linuxkit'},'origin':{'sourceCommit':'b'*40},'source':source,'entry':outer.entry,
            'guardian':{'cid':'d'*64},'runtime_image':'sha256:'+'e'*64,
            'prep':{'architecture':'amd64','baseImage':'oven/bun@sha256:'+'f'*64,'helperSha256':'a'*64,'abuseSha256':'b'*64,'runtimeSources':{}},'report':{}}
        tree=ast.parse(PATH.read_text());observe=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='observe')
        guarded=next(node for node in observe.body if isinstance(node,ast.Try))
        selected_nodes=[]
        for node in guarded.body:
            if isinstance(node,ast.If) and any(isinstance(value,ast.Constant) and value.value in ('EXACT_DESKTOP_TUPLE_REQUIRED','CONTROL_PREFLIGHT_CANDIDATE_CHANGED','FRESH_CONTROL_PREFLIGHT_REQUIRED','SOURCE_BINDING_INVALID') for value in ast.walk(node)):
                selected_nodes.append(node)
            elif isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id in ('proof','binding') for target in node.targets):selected_nodes.append(node)
        self.assertGreaterEqual(len(selected_nodes),6)
        exec(compile(ast.fix_missing_locations(ast.Module(body=selected_nodes,type_ignores=[])),'<actual-observer-candidate-binding>','exec'),environment)
        binding=environment['binding']
        server={'Platform':{'Name':observed},'Version':'29.9.2','GitCommit':'0367cbe','KernelVersion':'7.0.14-linuxkit','Arch':'amd64'}
        return binding,server

    def execute(self,selected=CURRENT,observed='Docker Desktop 4.97.0 (244584)',proof_candidate=None,mode='--capabilities'):
        binding,server=self.binding(selected,observed,proof_candidate)
        code,events,frames=controller_fixture.RootLaunchCallsite().execute('daemon',binding_override=binding,server_override=server,mode=mode)
        return code,events,frames,binding

    def test_selected_497_reaches_next_actual_controller_identity_check(self):
        code,events,frames,binding=self.execute()
        self.assertEqual(code,4)
        self.assertEqual(frames[-1]['error'],'DAEMON_IDENTITY_CHANGED')
        self.assertEqual([event[1][:2] for event in events],[['docker','version'],['docker','info']])

    def test_existing_496_default_reaches_same_next_check(self):
        code,events,frames,binding=self.execute(None,'Docker Desktop 4.96.1 (244132)')
        self.assertEqual(frames[-1]['error'],'DAEMON_IDENTITY_CHANGED')
        self.assertEqual(events[-1][1][:2],['docker','info'])

    def test_both_selected_candidates_reach_guardian_and_root_launch_checks(self):
        for selected,observed in ((CURRENT,'Docker Desktop 4.97.0 (244584)'),(LEGACY,'Docker Desktop 4.96.1 (244132)')):
            with self.subTest(candidate=selected):
                binding,server=self.binding(selected,observed)
                code,events,frames=controller_fixture.RootLaunchCallsite().execute(binding_override=binding,server_override=server)
                self.assertEqual(frames[-1]['candidate'],selected)
                self.assertEqual(frames[-1]['error'],'ROOT_LAUNCH_UNCONFIRMED')
                self.assertEqual([event[1][:2] for event in events[:-1]],[['docker','version'],['docker','info'],['docker','inspect'],['docker','inspect']])
                self.assertEqual(events[-1],('root','a'*64))

    def test_selected_candidate_never_accepts_the_other_known_platform_or_unknown_build(self):
        for selected,observed in ((CURRENT,'Docker Desktop 4.96.1 (244132)'),(None,'Docker Desktop 4.97.0 (244584)'),(CURRENT,'Docker Desktop 4.97.0 (244585)'),(LEGACY,'Docker Desktop 4.96.2 (244132)')):
            with self.subTest(selected=selected,observed=observed):
                code,events,frames,binding=self.execute(selected,observed)
                self.assertEqual(frames[-1]['error'],'DESKTOP_TUPLE_CHANGED')
                self.assertEqual([event[1][:2] for event in events],[['docker','version']])

    def test_selected_candidate_keeps_original_engine_kernel_and_architecture_pins(self):
        binding,server=self.binding()
        for key,value in (('Version','29.9.3'),('GitCommit','foreign'),('KernelVersion','7.0.15-linuxkit'),('Arch','arm64')):
            with self.subTest(field=key):
                code,events,frames=controller_fixture.RootLaunchCallsite().execute('daemon',binding_override=binding,server_override={**server,key:value})
                self.assertEqual(frames[-1]['error'],'DESKTOP_TUPLE_CHANGED')
                self.assertEqual([event[1][:2] for event in events],[['docker','version']])

    def test_unknown_selection_or_preflight_candidate_mismatch_refuses_before_binding(self):
        with self.assertRaisesRegex(RuntimeError,'EXACT_DESKTOP_TUPLE_REQUIRED'):self.binding('unknown')
        with self.assertRaisesRegex(RuntimeError,'CONTROL_PREFLIGHT_CANDIDATE_CHANGED'):self.binding(CURRENT,proof_candidate=LEGACY)

    def test_binding_requires_exact_known_candidate_and_serialized_ready_hash_covers_it(self):
        code,events,frames,binding=self.execute()
        self.assertEqual(binding['candidate'],CURRENT)
        raw=json.dumps(binding);ready=frames[0]
        self.assertTrue(outer.ready_frame(ready,binding,raw,ready['managerId'],ready['managerPid'],'manager'))
        changed={**binding,'candidate':LEGACY}
        self.assertFalse(outer.ready_frame(ready,changed,json.dumps(changed),ready['managerId'],ready['managerPid'],'manager'))
        for value in ('unknown','',None,True,[],{}):
            with self.subTest(value=value):
                code,events,frames=controller_fixture.RootLaunchCallsite().execute(binding_override={**binding,'candidate':value})
                self.assertEqual(frames[-1]['error'],'BINDING_INVALID');self.assertEqual(events,[])
        missing=dict(binding);missing.pop('candidate')
        code,events,frames=controller_fixture.RootLaunchCallsite().execute(binding_override=missing)
        self.assertEqual(frames[-1]['error'],'BINDING_INVALID');self.assertEqual(events,[])

    def test_qualify_uses_same_selected_tuple_guard_before_later_capabilities(self):
        for selected,observed in ((CURRENT,'Docker Desktop 4.97.0 (244584)'),(None,'Docker Desktop 4.96.1 (244132)')):
            code,events,frames,binding=self.execute(selected,observed,mode='--qualify')
            self.assertEqual(frames[-1]['error'],'DAEMON_IDENTITY_CHANGED')
            self.assertEqual(events[-1][1][:2],['docker','info'])

    def test_outer_result_refuses_candidate_change_or_omission(self):
        # Synthetic successful receipts test the real outer validation branch only.
        # The actual controller guard is exercised independently above.
        code,events,frames,binding=self.execute();ready=frames[0]
        frame={'kind':'result','ok':True,'candidate':CURRENT,**{key:binding[key] for key in ('nonce','bootId','sourceCommit','sources')},'managerId':ready['managerId'],'managerPid':ready['managerPid']}
        tree=ast.parse(PATH.read_text())
        guard=next(node for node in ast.walk(tree) if isinstance(node,ast.If) and any(isinstance(value,ast.Constant) and value.value=='CONTROLLER_RESULT_UNPROVEN' for value in ast.walk(node)))
        def accept(value):
            environment={'extra':b'','errors':b'','manager_channel':SimpleNamespace(child=SimpleNamespace(returncode=0)),'frame':value,'candidate':CURRENT,'nonce':binding['nonce'],'boot':binding['bootId'],'origin':{'sourceCommit':binding['sourceCommit']},'source':{'sources':binding['sources']},'manager':{'cid':ready['managerId']},'manager_ready':ready}
            exec(compile(ast.fix_missing_locations(ast.Module(body=[guard],type_ignores=[])),'<actual-outer-controller-receipt>','exec'),environment)
        accept(frame)
        for value in (LEGACY,'unknown',None):
            with self.subTest(candidate=value),self.assertRaisesRegex(RuntimeError,'CONTROLLER_RESULT_UNPROVEN'):accept({**frame,'candidate':value})
        missing=dict(frame);missing.pop('candidate')
        with self.assertRaisesRegex(RuntimeError,'CONTROLLER_RESULT_UNPROVEN'):accept(missing)

    def test_guardian_keeps_candidate_in_actual_ready_binding_digest(self):
        binding,server=self.binding()
        binding={**binding,'guardianId':None,'preparedImage':None}
        code,events,frames=controller_fixture.RootLaunchCallsite().execute(binding_override=binding,mode='--guardian')
        self.assertEqual(code,0);self.assertEqual(events,[('guardian-sleep',900)])
        ready=frames[0]
        self.assertTrue(outer.ready_frame(ready,binding,json.dumps(binding),ready['managerId'],ready['managerPid'],'guardian'))
        changed={**binding,'candidate':LEGACY}
        self.assertFalse(outer.ready_frame(ready,changed,json.dumps(changed),ready['managerId'],ready['managerPid'],'guardian'))

if __name__=='__main__':unittest.main()

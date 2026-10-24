"""Independent full root-policy execution; real protected Debian fixture bytes.

Only OS identity and external command protocols are substituted. No root actions,
iptables commands, package actions or VM work are executed on this host.
"""
import ast
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO/'experiments/compatibility/runtime-probe'))
import test_owned_guest as custody_test
from test_owned_guest import NONCE

TREE = ast.parse((REPO/'scripts/fresh-linux-guest.py').read_text())
POLICY = next(ast.literal_eval(node.value) for node in TREE.body
              if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'DEBIAN_CANARY_ROOT' for t in node.targets))
CHAIN = 'FL'+NONCE.replace('-', '')[:20]
RULE = ['-A', CHAIN, '-m', 'comment', '--comment', 'fleur-'+NONCE, '-j', 'RETURN']
REAL_OPEN = os.open
REAL_POPEN = subprocess.Popen
REAL_SPEC = importlib.util.spec_from_file_location
REAL_REALPATH = os.path.realpath

class RootCanaryPolicy(unittest.TestCase):
    def execute(self, scenario='valid', phases=('before','afterInstall','freshLogin','afterRuntime','cleanup')):
        custody_fixture = custody_test.OwnedGuestCustody()
        custody_fixture.setUp()
        self.addCleanup(custody_fixture.doCleanups)
        calls = []
        frames = []
        state = {'created':False, 'rule':False, 'phase':'before'}
        self.calls, self.frames, self.state = calls, frames, state
        def action(fixture):
            (fixture.root/'usr/sbin').mkdir()
            for filename in ('usr/sbin/xtables-nft-multi','usr/bin/dpkg','usr/bin/dpkg-query','usr/bin/systemctl'):
                (fixture.root/filename).write_text('external tool protocol fixture')
                (fixture.root/filename).chmod(0o755)
            fixture.uid[0] = 0
            binding = fixture.context.report()
            binding = {key:binding[key] for key in ('nonce','bootId','uid','manifestSha256')}
            if scenario == 'wrong-binding': binding['bootId'] = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
            if scenario == 'wrong-os':
                release = fixture.root/'usr/lib/os-release'
                release.chmod(0o644);release.write_text('ID=ubuntu\nVERSION_ID="13"\n');release.chmod(0o444)
            def lstat(path):
                value = fixture.lstat(fixture.root/str(path).lstrip('/'))
                return SimpleNamespace(st_mode=value.st_mode, st_uid=0)
            def spec(name, location, *args, **kwargs):
                self.assertEqual(location, '/usr/local/lib/fleur-owned-guest.py')
                return REAL_SPEC(name, str(fixture.root/'usr/local/lib/fleur-owned-guest.py'), *args, **kwargs)
            def popen(args, **kwargs):
                calls.append(list(args))
                text = ''
                if args[0] == '/usr/bin/dpkg-query': text = 'iptables: /usr/sbin/iptables-nft\n'
                elif args[0] == '/usr/bin/dpkg': text = 'changed\n' if scenario == 'package-integrity' else ''
                elif args[0] == '/usr/bin/systemctl':
                    before = state['phase'] == 'before'
                    service = {'LoadState':'not-found' if before else 'loaded','ActiveState':'inactive','SubState':'dead','UnitFileState':'' if before else 'disabled','ExecMainPID':'0','ExecMainStartTimestampMonotonic':'0','ActiveEnterTimestampMonotonic':'0','InactiveExitTimestampMonotonic':'0'}
                    if scenario.startswith('service:'): service[scenario.split(':',1)[1]] = '1'
                    text = ''.join(key+'='+value+'\n' for key,value in service.items())
                elif args == ['/usr/sbin/iptables-nft','--version']:
                    text = 'iptables v1.8.11 ('+('legacy' if scenario == 'legacy' else 'nf_tables')+')\n'
                else:
                    self.assertEqual(args[:5], ['/usr/sbin/iptables-nft','--wait','2','-t','filter'])
                    operation = args[5:]
                    if operation == ['-S']:
                        if state['created'] or scenario == 'collision': text = '-N '+CHAIN+'\n'
                        if scenario == 'reference' or scenario == 'cleanup-reference' and state['phase'] == 'cleanup': text += '-A INPUT -j '+CHAIN+'\n'
                    elif operation == ['-N',CHAIN]: state['created'] = True
                    elif operation == RULE: state['rule'] = True
                    elif operation == ['-S',CHAIN]:
                        text = '-N '+CHAIN+'\n'+shlex.join(RULE)+'\n'
                        if scenario == 'mutated' or scenario == 'cleanup-mutated' and state['phase'] == 'cleanup': text += '-A '+CHAIN+' -j DROP\n'
                    elif operation == ['-D', *RULE[1:]]: state['rule'] = False
                    elif operation == ['-X',CHAIN]: state['created'] = False
                    else: self.fail('Unexpected external command: '+repr(args))
                if scenario == 'mid-command-boot-drift' and len(calls) == 1:
                    boot = fixture.root/'proc/sys/kernel/random/boot_id'
                    boot.chmod(0o644);boot.write_text('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee\n');boot.chmod(0o444)
                # Real child, pipes, retained waitid, signal and reap execute unchanged.
                return REAL_POPEN([sys.executable,'-c','import sys;sys.stdout.write('+repr(text)+')'], **kwargs)
            fixture_open = os.open
            def opened(path, *args, **kwargs):
                return REAL_OPEN(path, *args, **kwargs) if path == '/dev/null' else fixture_open(path, *args, **kwargs)
            with patch('os.open', side_effect=opened), patch('os.lstat', side_effect=lstat), patch('os.path.realpath', side_effect=lambda p: '/usr/sbin/xtables-nft-multi' if p == '/usr/sbin/iptables-nft' else REAL_REALPATH(p)), patch('importlib.util.spec_from_file_location', side_effect=spec), patch('subprocess.Popen', side_effect=popen):
                for phase in phases:
                    state['phase'] = phase
                    output = io.StringIO()
                    with patch.object(sys,'argv',['root-policy',json.dumps({'binding':binding,'phase':phase,'deadline':129.0})]), contextlib.redirect_stdout(output):
                        try: exec(compile(POLICY,'<actual-DEBIAN_CANARY_ROOT>','exec'), {'__name__':'root_canary_policy'})
                        except Exception as error:
                            self.failure = repr(error)
                            raise
                    frames.append(json.loads(output.getvalue()))
        result = custody_fixture.observe(distribution='debian', release='13', control_binding={'nonce':NONCE,'boot_id':'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','uid':1000,'manifest_sha256':'fixture'}, action=action, context_deadline=130)
        # observe catches policy RuntimeError. Preserve that status explicitly.
        self.result = result
        return len(frames) == len(phases)

    def test_full_protected_debian_policy_all_phases_and_exact_cleanup(self):
        self.assertTrue(self.execute(), repr((self.result,self.calls,getattr(self,'failure',None))))
        self.assertEqual([f['phase'] for f in self.frames], ['before','afterInstall','freshLogin','afterRuntime','cleanup'])
        self.assertTrue(self.frames[-1]['cleanup'])
        self.assertFalse(self.state['created']);self.assertFalse(self.state['rule'])
        mutations = [args[5:] for args in self.calls if len(args)>5 and args[0].endswith('iptables-nft') and args[5] in ('-N','-A','-D','-X')]
        self.assertEqual(mutations, [['-N',CHAIN], RULE, ['-D',*RULE[1:]], ['-X',CHAIN]])

    def test_refuses_custody_backend_integrity_collision_and_reference_before_mutation(self):
        for scenario in ('wrong-binding','wrong-os','legacy','package-integrity','collision','reference'):
            with self.subTest(scenario=scenario):
                self.assertFalse(self.execute(scenario, ('before',)))
                expected = {'wrong-binding':'Original Debian canary custody changed','wrong-os':'custody','legacy':'nf_tables backend required','package-integrity':'Firewall tool package integrity differs','collision':'Owned canary collision','reference':'Owned canary acquired a reference'}[scenario]
                if scenario != 'wrong-os': self.assertIn(expected, self.failure)
                self.assertFalse(any(len(args)>5 and args[5] in ('-N','-A','-D','-X') for args in self.calls))

    def test_boot_drift_after_first_tool_revalidated_before_next_command(self):
        self.assertFalse(self.execute('mid-command-boot-drift', ('before',)))
        self.assertEqual(self.calls, [['/usr/bin/dpkg-query','--root=/','--admindir=/var/lib/dpkg','--search','--','/usr/sbin/iptables-nft']])
        self.assertFalse(self.state['created'])

    def test_changed_canary_never_deleted(self):
        self.assertFalse(self.execute('mutated', ('before',)))
        self.assertFalse(any(len(args)>5 and args[5] in ('-D','-X') for args in self.calls))
        self.assertTrue(self.state['created'])

    def test_cleanup_refuses_foreign_rule_or_reference_without_deleting(self):
        for scenario in ('cleanup-reference', 'cleanup-mutated'):
            with self.subTest(scenario=scenario):
                self.assertFalse(self.execute(scenario))
                self.assertEqual(len(self.frames), 4)
                self.assertTrue(self.state['created']);self.assertTrue(self.state['rule'])
                self.assertFalse(any(len(args)>5 and args[5] in ('-D','-X') for args in self.calls))
                self.assertIn('Owned canary acquired a reference' if scenario == 'cleanup-reference' else 'Original owned canary changed', self.failure)

    def test_each_service_execution_witness_refuses_before_mutation(self):
        for field in ('ExecMainPID','ExecMainStartTimestampMonotonic','ActiveEnterTimestampMonotonic','InactiveExitTimestampMonotonic'):
            with self.subTest(field=field):
                self.assertFalse(self.execute('service:'+field, ('before',)))
                self.assertIn('nftables service executed or its state changed', self.failure)
                self.assertFalse(any(len(args)>5 and args[5] in ('-N','-A','-D','-X') for args in self.calls))

if __name__ == '__main__': unittest.main()

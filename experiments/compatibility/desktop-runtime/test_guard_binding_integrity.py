"""Independent execution of the actual unchanged-guard adapter callback."""
import ast
from pathlib import Path
import unittest

class GuardBindingIntegrity(unittest.TestCase):
    def callback(self,fail=False):
        tree=ast.parse(Path(__file__).with_name('entry.py').read_text())
        callback=next(node for node in ast.walk(tree) if isinstance(node,ast.FunctionDef) and node.name=='deadline')
        calls=[]
        class Guard:
            def __init__(self,cid,pid,end,launcher):calls.append(('armed',cid,pid,end,launcher))
            def close(self):calls.append(('closed',))
        def emit(value):calls.append(('emitted',value))
        def ack(binding,phase,**options):
            calls.append(('ack',binding,phase,options))
            if fail:raise RuntimeError('controlled custody refusal')
        environment={'HostDeadlineGuard':Guard,'launch':'fixed-launcher','binding':{'nonce':'owned'},'emit':emit,'acknowledge':ack}
        module=ast.fix_missing_locations(ast.Module(body=[callback],type_ignores=[]))
        exec(compile(module,'<actual-entry-guard-callback>','exec'),environment)
        return environment['deadline'],calls

    def test_armed_guard_exact_identity_is_published_and_original_deadline_reused(self):
        callback,calls=self.callback();guard=callback('a'*64,123,456.25)
        self.assertIsNotNone(guard)
        self.assertEqual(calls,[('armed','a'*64,123,456.25,'fixed-launcher'),
            ('emitted',{'kind':'guard-binding','nonce':'owned','containerId':'a'*64,'pid':123,'deadlineVmMonotonic':456.25}),
            ('ack',{'nonce':'owned'},'guard-'+'a'*64,{'absolute_deadline':456.25})])

    def test_failed_outer_custody_ack_closes_armed_guard_and_refuses_progress(self):
        callback,calls=self.callback(True)
        with self.assertRaisesRegex(RuntimeError,'controlled custody refusal'):callback('a'*64,123,456.25)
        self.assertEqual(calls[-1],('closed',))

if __name__=='__main__':unittest.main()

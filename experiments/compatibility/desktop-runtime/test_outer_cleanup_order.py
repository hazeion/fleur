"""Execute actual outer finalization against a manager/worker creation race."""
import ast
from pathlib import Path
import time
from types import SimpleNamespace
import unittest

class ManagerLossCleanupOrdering(unittest.TestCase):
    def test_manager_cannot_create_a_worker_after_that_name_was_confirmed_absent(self):
        path=Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py'
        tree=ast.parse(path.read_text())
        observe=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='observe')
        guarded=next(node for node in observe.body if isinstance(node,ast.Try) and node.finalbody)
        program=ast.fix_missing_locations(ast.Module(body=guarded.finalbody,type_ignores=[]))
        manager={'cid':'manager','name':'manager'};guardian={'cid':'guardian','name':'guardian'}
        state={'managerRunning':True,'workerExists':False,'raced':False}
        def inspect(target,*args,**kwargs):
            if target=='manager':
                return {'Id':'manager','State':{'Running':state['managerRunning'],'Pid':123 if state['managerRunning'] else 0}}
            if target=='worker':
                if not state['workerExists'] and state['managerRunning'] and not state['raced']:
                    # A still-running manager schedules its next create just after absence was observed.
                    state['raced']=True;state['workerExists']=True
                    return None
                return {'Id':'worker'} if state['workerExists'] else None
            return None
        def docker(args,*args_,**kwargs):
            if args[0] in ('stop','kill') and args[-1]=='manager':state['managerRunning']=False
            if args[0]=='rm' and args[-1]=='worker':state['workerExists']=False
        def retire(expected):
            if expected is manager:state['managerRunning']=False
        environment={'report':{'ok':False,'cleanup':[]},'workers':[{'name':'worker','owner':'tag'}],
            'owned':[guardian,manager],'guardian':guardian,'manager':manager,'workers_retired':True,
            'channels':[],'imported':[],'held':None,'original':None,'ledger_dir':None,'end':time.monotonic()+600,
            'runtime_image':'image','inspect':inspect,'docker':docker,'retire_role':retire,
            'entry':SimpleNamespace(worker_profile=lambda *args:True),'role_profile':lambda *args,**kwargs:True,'time':time}
        exec(compile(program,'<actual-outer-finalization>','exec'),environment)
        self.assertFalse(state['managerRunning'])
        self.assertFalse(state['workerExists'],'worker was created after its absence check while the manager was still active')

if __name__=='__main__':unittest.main()

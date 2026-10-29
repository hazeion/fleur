"""Temporary #110 native diagnostic. Existing tests and deadlines are unchanged."""
import concurrent.futures
import json
import subprocess
import sys
import time

from test_containerd_observer import ObserverTests, ObserverUnverified


ADAPTER = r'''
import json,pathlib,sys,time
diagnostic_path=pathlib.Path(CANARY_STATE)/'cleanup-diagnostic.json'
diagnostic_events=[]
def diagnostic_trace(frame,event,arg):
    function=frame.f_code.co_name
    if event=='call':
        if function not in ('register_canary','call','retire_owned_group'):return None
        frame.f_trace_lines=False
    values=frame.f_locals
    if len(diagnostic_events)<512:
        row={'function':function,'event':event,'time':time.monotonic()}
        for key in ('limit','end','deadline','work_limit','count','candidate','confirmed','cleaned','children_reaped','category'):
            value=values.get(key)
            if type(value) in (int,float,bool) or key=='category' and type(value) is str:row[key]=value
        arguments=values.get('arguments',[])
        if len(arguments)>1:row['command']=arguments[1];row['quiet']='--quiet' in arguments
        if event=='exception':
            error=arg[1]
            if isinstance(error,(ProcessLookupError,KeyError)):return diagnostic_trace
            row['error']=type(error).__name__
            if type(getattr(error,'errno',None)) is int:row['errno']=error.errno
            if type(error).__name__=='Failed':row['category']=str(error)
        if event=='return' and function=='register_canary':row['result']=arg
        diagnostic_events.append(row)
    if event=='return' and function=='register_canary':
        diagnostic_path.write_text(json.dumps(diagnostic_events))
    return diagnostic_trace
sys.settrace(diagnostic_trace)
'''


def run_worker():
    for repetition in range(25):
        for mode in ('missing-echo', 'wrong-nonce'):
            fixture=ObserverTests()
            observer,state=fixture.canary_observer(mode,timeout=5,adapter_extra=ADAPTER)
            failures=[]
            try:
                try:
                    observer.ready(5)
                    failures.append('unexpected-readiness')
                except ObserverUnverified as error:
                    if error.category!='readiness-unverified':failures.append(error.category)
                before=observer.snapshot()
                if json.loads((state/'namespaces.json').read_text())!={}:failures.append('namespace-remains')
                registration=before['registration']
                if registration is None or not registration['cleanup_verified']:failures.append('registration-cleanup-unverified')
                if registration is not None and registration['ready']:failures.append('registration-ready')
                try:observer.close(1)
                except ObserverUnverified as error:failures.append(error.category)
                if failures:
                    diagnostic=state/'cleanup-diagnostic.json'
                    print(json.dumps({'repetition':repetition,'mode':mode,'failures':failures,
                        'before':before,'after':observer.snapshot(),
                        'trace':json.loads(diagnostic.read_text()) if diagnostic.exists() else None}),flush=True)
                    return 1
            finally:fixture.doCleanups()
    print(json.dumps({'passed_cases':50}),flush=True)
    return 0


def main():
    if '--worker' in sys.argv:return run_worker()
    def worker(number):
        started=time.monotonic()
        result=subprocess.run([sys.executable,'-B',__file__,'--worker'],capture_output=True,text=True,timeout=450)
        return {'worker':number,'exit':result.returncode,'seconds':round(time.monotonic()-started,3),
                'results':[json.loads(line) for line in result.stdout.splitlines()],
                'stderr_bytes':len(result.stderr)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        results=list(executor.map(worker,range(4)))
    print(json.dumps({'workers':results},indent=2),flush=True)
    return int(any(result['exit']!=0 for result in results))


if __name__=='__main__':raise SystemExit(main())

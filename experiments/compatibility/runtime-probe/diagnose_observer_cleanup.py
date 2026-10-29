"""Temporary #110 native diagnostic. Existing tests and deadlines are unchanged."""
import concurrent.futures
import json
import subprocess
import sys
import time

from test_containerd_observer import ObserverTests, ObserverUnverified


ADAPTER = r'''
import json,pathlib,time
cleanup_diagnostic_path=pathlib.Path(CANARY_STATE)/'cleanup-diagnostic.json'
def cleanup_diagnostic(stage,error,arguments,count,limit):
    record={'stage':stage,'error':type(error).__name__,'command':arguments[1] if arguments else None,
            'quiet':'--quiet' in arguments,'count':count,'remaining':limit-time.monotonic()}
    if type(getattr(error,'errno',None)) is int:record['errno']=error.errno
    if type(error).__name__ in ('Failed','RuntimeError'):record['category']=str(error)
    with cleanup_diagnostic_path.open('a') as stream:stream.write(json.dumps(record)+'\n')
'''


def install_failure_diagnostics():
    import test_containerd_observer as fixtures
    source=fixtures.SUPERVISOR
    replacements={
        "except (OSError,RuntimeError,AttributeError,subprocess.TimeoutExpired):\n                        children_reaped=False":
        "except (OSError,RuntimeError,AttributeError,subprocess.TimeoutExpired) as error:\n                        cleanup_diagnostic('child-retirement',error,arguments,count,limit)\n                        children_reaped=False",
        "except (Failed,OSError,ValueError,subprocess.SubprocessError):\n                cleaned=False":
        "except (Failed,OSError,ValueError,subprocess.SubprocessError) as error:\n                cleanup_diagnostic('namespace-cleanup',error,[],count,deadline)\n                cleaned=False",
    }
    for before,after in replacements.items():
        assert source.count(before)==1
        source=source.replace(before,after)
    fixtures.SUPERVISOR=source


def run_worker():
    install_failure_diagnostics()
    for repetition in range(50):
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
                        'trace':[json.loads(line) for line in diagnostic.read_text().splitlines()] if diagnostic.exists() else None}),flush=True)
                    return 1
            finally:fixture.doCleanups()
    print(json.dumps({'passed_cases':100}),flush=True)
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

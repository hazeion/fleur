#!/usr/bin/env python3
"""Additional owned VFS counterfactual; existing overlay requirements stay required."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
FACT_FLAGS = ('owned','socket_verified','data_root_verified','exec_root_verified',
              'namespace_verified','pid_verified','config_verified')


def valid_facts(facts):
    return (type(facts) is dict and facts.get('driver') == 'vfs'
            and facts.get('server_version') == '28.0.4'
            and all(facts.get(key) is True for key in FACT_FLAGS))


def validate_result(facts, exit_code, probe, cleanup):
    if not valid_facts(facts) or type(exit_code) is not int or exit_code != 0 or cleanup is not True:
        return False
    if (type(probe) is not dict or probe.get('bounded_probe_passed') is not True
            or probe.get('v1_gate_passed') is not False or probe.get('cleanup_complete') is not True):
        return False
    lifecycle, replacement = probe.get('restricted_worker_lifecycle'), probe.get('event_replacement_negative')
    return (type(lifecycle) is dict and lifecycle.get('passed') is True
            and type(lifecycle.get('repeats')) is list and len(lifecycle['repeats']) == 2
            and type(replacement) is dict and replacement.get('passed') is True)


def execute_probe(architecture, environment, timeout):
    """Same probe source/profile; host networking applies only to trusted build."""
    if architecture not in ('amd64','arm64') or timeout <= 0:
        raise ValueError('counterfactual probe arguments invalid')
    started = time.monotonic()
    process = subprocess.Popen([sys.executable,str(HERE/'run.py'),'--architecture',architecture,
        '--trusted-build-network','host'],env=environment,stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    output, errors = bytearray(),bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout,selectors.EVENT_READ,output)
            selector.register(process.stderr,selectors.EVENT_READ,errors)
            while selector.get_map():
                remaining = timeout-(time.monotonic()-started)
                if remaining <= 0:raise TimeoutError('counterfactual probe deadline')
                ready = selector.select(remaining)
                if not ready:raise TimeoutError('counterfactual probe deadline')
                for key,_ in ready:
                    chunk = os.read(key.fileobj.fileno(),8192)
                    if not chunk:selector.unregister(key.fileobj)
                    else:key.data.extend(chunk)
                    if len(output)>1048576 or len(errors)>4096:
                        raise ValueError('counterfactual probe output exceeded bound')
        remaining=timeout-(time.monotonic()-started)
        if remaining <= 0:raise TimeoutError('counterfactual probe deadline')
        process.wait(timeout=remaining)
        return process.returncode,bytes(output),{'stderr_bytes':len(errors),'stderr_sha256':hashlib.sha256(errors).hexdigest()}
    finally:
        if process.poll() is None:
            os.killpg(process.pid,signal.SIGKILL)
            process.wait(timeout=5)
        process.stdout.close();process.stderr.close()


def run_counterfactual(architecture, directory):
    from isolated_daemon import isolated_vfs_daemon
    target=Path(directory);target.mkdir(parents=True,exist_ok=True)
    result={'scope':'vfs-storage-counterfactual','v1_gate_passed':False,'replaces_overlay_requirement':False,
            'passed':False,'architecture':architecture,'daemon_cleanup_verified':False,
            'source_sha256':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest()
                             for name in ('vfs.py','isolated_daemon.py','run.py')}}
    endpoint=None;probe=None;exit_code=None
    try:
        with isolated_vfs_daemon(lifetime=540) as endpoint:
            if not valid_facts(endpoint.facts):raise RuntimeError('isolated daemon identity unverified')
            result['daemon']={key:endpoint.facts[key] for key in ('driver','server_version',*FACT_FLAGS)}
            timeout=endpoint.remaining_seconds()-15
            exit_code,raw,transport=execute_probe(architecture,endpoint.environment,timeout)
            result['probe_transport']=transport;result['probe_exit_code']=exit_code
            probe=json.loads(raw)
            if type(probe) is not dict:raise ValueError('counterfactual report object invalid')
            (target/'runtime-probe.json').write_bytes(raw)
    except (OSError,RuntimeError,ValueError,TimeoutError,subprocess.SubprocessError) as failure:
        result['failure_category']=type(failure).__name__
    finally:
        if endpoint is not None:
            result['daemon_cleanup_verified']=endpoint.cleanup_verified
            result['default_daemon_unchanged']=endpoint.facts.get('default_daemon_unchanged') is True
        result['passed']=(validate_result(result.get('daemon'),exit_code,probe,result['daemon_cleanup_verified'])
                          and result.get('default_daemon_unchanged') is True and 'failure_category' not in result)
        (target/'vfs-counterfactual.json').write_text(json.dumps(result,indent=2)+'\n')
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--architecture',choices=('amd64','arm64'),required=True)
    parser.add_argument('--output-directory',required=True)
    arguments=parser.parse_args()
    raise SystemExit(run_counterfactual(arguments.architecture,arguments.output_directory))

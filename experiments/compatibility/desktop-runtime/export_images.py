#!/usr/bin/env python3
"""Build/export qualification inputs only on a disposable native GitHub runner."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import uuid

ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent

def command(args,timeout=30):
    result=subprocess.run(args,cwd=ROOT,capture_output=True,timeout=timeout)
    if result.returncode:raise RuntimeError('image export command failed: '+args[0])
    return result.stdout

def inspect_preparation(kind,target,runner=subprocess.run):
    if kind not in ('container','image'):raise RuntimeError('fixed preparation object type required')
    found=runner(['docker','inspect','--type',kind,target,'--format','{{json .}}'],capture_output=True,text=True,timeout=5)
    if found.returncode==0 and not found.stderr:return json.loads(found.stdout)
    if found.returncode==1 and found.stdout in ('','\n') and found.stderr in ('Error: No such object: '+target+'\n','error: no such object: '+target+'\n','Error: No such '+kind+': '+target+'\n','error: no such '+kind+': '+target+'\n','Error response from daemon: No such '+kind+': '+target+'\n'):return None
    raise RuntimeError('preparation ownership inspection uncertain')

def preparation_names(nonce):
    base='fleur-desktop-preparation-'+nonce
    return base,base+':latest'


def main(output):
    if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or platform.system()!='Linux' or platform.machine()!='x86_64':raise RuntimeError('disposable native GitHub amd64 preparation only')
    commit=command(['git','rev-parse','HEAD']).decode().strip()
    if command(['git','diff','--exit-code','HEAD']):raise RuntimeError('committed source required')
    output.mkdir(mode=0o700,parents=False,exist_ok=False)
    nonce=str(uuid.uuid4());container,tag=preparation_names(nonce);image=None;pending=None
    try:
        with tempfile.TemporaryDirectory(prefix='fleur-desktop-export-') as directory:
            context=Path(directory);sources={}
            paths=command(['git','ls-tree','-r','--name-only',commit,'experiments/compatibility/runtime-probe','experiments/compatibility/rendering/package.json','experiments/compatibility/rendering/bun.lock','experiments/compatibility/desktop-runtime']).decode().splitlines()
            for relative in paths:
                suffix=relative.split('experiments/compatibility/')[1]
                if suffix.startswith('desktop-runtime/'):
                    name=suffix.split('/',1)[1]
                    if name not in ('entry.py','Dockerfile','export_worker.py','processes.py','guardian_guard.py'):continue
                elif suffix.startswith('runtime-probe/'):
                    if '/' in suffix.split('/',1)[1]:continue
                    name=suffix
                else:name=suffix
                body=command(['git','show',commit+':'+relative])
                if (ROOT/relative).read_bytes()!=body:raise RuntimeError('source changed')
                target=context/'controller'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body)
                sources[name]=hashlib.sha256(body).hexdigest()
            manifest={'sourceCommit':commit,'sources':sources}
            (context/'controller/source-manifest.json').write_text(json.dumps(manifest,separators=(',',':')))
            shutil.copyfile(context/'controller/Dockerfile',context/'Dockerfile')
            subprocess.run(['docker','build','--platform','linux/amd64','--label','dev.fleur.desktop-preparation-owner='+nonce,'--tag',tag,directory],cwd=ROOT,check=True,timeout=360)
            image=command(['docker','image','inspect',tag,'--format','{{.Id}}']).decode().strip()
            subprocess.run(['docker','run','--name',container,'--label','dev.fleur.desktop-preparation-owner='+nonce,'--network','none','--volume','/var/run/docker.sock:/var/run/docker.sock','--volume',str(output.resolve())+':/output','--entrypoint','/usr/bin/python3',image,'-I','/controller/export_worker.py'],check=True,timeout=420)
            subprocess.run(['docker','image','save','--output',str(output/'controller-image.tar'),image],check=True,timeout=120)
            (output/'source-manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
            artifacts={}
            for path in sorted(output.iterdir()):
                digest=hashlib.sha256()
                with path.open('rb') as stream:
                    for block in iter(lambda:stream.read(1048576),b''):digest.update(block)
                artifacts[path.name]={'bytes':path.stat().st_size,'sha256':digest.hexdigest()}
            result={'formatVersion':1,'scope':'desktop-qualification-image-preparation','runtimeAdmission':False,'nativeQualification':False,'sourceCommit':commit,'controllerImageId':image,'artifacts':artifacts}
            pending=result
    finally:
        cleanup=[]
        for kind,target in (('container',container),('image',tag)):
            stage='inspect-ownership'
            try:
                value=inspect_preparation(kind,target)
                if value is not None:
                    stage='validate-ownership'
                    if value.get('Config',{}).get('Labels',{}).get('dev.fleur.desktop-preparation-owner')!=nonce:raise RuntimeError('preparation ownership changed')
                    if kind=='container':
                        if image is None or value.get('Image')!=image or value.get('Name')!='/'+container:raise RuntimeError('preparation container changed')
                        args=['docker','rm','--force',value['Id']]
                    else:
                        if image is None or value.get('Id')!=image:raise RuntimeError('preparation image changed')
                        args=['docker','image','rm',tag]
                    stage='remove'
                    retired=subprocess.run(args,capture_output=True,timeout=15)
                    if retired.returncode:raise RuntimeError('preparation removal command failed')
                    stage='confirm-absence'
                    if inspect_preparation(kind,target) is not None:raise RuntimeError('preparation removal uncertain')
                cleanup.append({'resource':kind,'absent':True})
            except Exception:
                cleanup.append({'resource':kind,'absent':False,'failureStage':stage})
        receipt={'formatVersion':1,'scope':'disposable-image-preparation-retirement','cleanup':cleanup,'ok':all(row['absent'] for row in cleanup),'runtimeAdmission':False,'nativeQualification':False}
        (output/'preparation-cleanup.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n')
        if not receipt['ok']:raise RuntimeError('preparation cleanup unconfirmed')
    if pending is None:raise RuntimeError('preparation incomplete')
    cleanup_bytes=(output/'preparation-cleanup.json').read_bytes()
    pending['artifacts']['preparation-cleanup.json']={'bytes':len(cleanup_bytes),'sha256':hashlib.sha256(cleanup_bytes).hexdigest()}
    pending['cleanup']=cleanup;pending['ok']=True
    (output/'image-origin.json').write_text(json.dumps(pending,sort_keys=True,indent=2)+'\n')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();main(args.output)

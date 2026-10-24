"""Disposable GitHub-only trusted image preparation, never runtime admission."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0,'/controller/runtime-probe')
import run

output=Path('/output')
manifest=json.loads(Path('/controller/source-manifest.json').read_text())
exported={}
def export(image, proof):
    if proof.get('compiler_pin_verified') is not True:raise RuntimeError('native compiler pin required')
    artifact=output/'runtime-image.tar'
    subprocess.run(['docker','image','save','--output',str(artifact),image],check=True,timeout=120)
    exported.update(formatVersion=1,scope='prepared-native-runtime-image',runtimeAdmission=False,nativeQualification=False,imageId=image,sourceCommit=manifest['sourceCommit'],runtimeSources=proof['source_sha256'],helperSha256=proof['helper_sha256'],abuseSha256=proof['abuse_sha256'],architecture=proof['architecture'],baseImage=proof['base_image'],compiler=proof['gcc'])
    raise RuntimeError('PREPARATION_ONLY_EXPORTED')

capture=io.StringIO()
with contextlib.redirect_stdout(capture):code=run.main('amd64',prepared_image_export=export)
if code!=1 or run.REPORT.get('failure')!='PREPARATION_ONLY_EXPORTED' or run.REPORT.get('cleanup_complete') is not True or run.REPORT.get('bounded_probe_passed') is not False or not exported:raise RuntimeError('preparation did not retire cleanly')
exported['preparationReport']=run.REPORT
(output/'runtime-preparation.json').write_text(json.dumps(exported,sort_keys=True,indent=2)+'\n')
(output/'controller-packages.tsv').write_bytes(Path('/controller-packages.tsv').read_bytes())
tools={}
for name,path,args in [('gcc','/usr/local/bin/gcc',['-dumpfullversion']),('cc1','/usr/lib/gcc/x86_64-linux-gnu/13/cc1',['--version']),('as','/usr/bin/x86_64-linux-gnu-as',['--version']),('ld','/usr/bin/x86_64-linux-gnu-ld.bfd',['--version']),('python','/usr/bin/python3',['--version']),('sudo','/usr/bin/sudo',['--version']),('docker','/usr/bin/docker',['--version'])]:
    actual=Path(path).resolve(strict=True)
    observed=subprocess.run([path,*args],capture_output=True,text=True,timeout=5)
    if observed.returncode:raise RuntimeError('tool provenance unavailable')
    tools[name]={'sha256':hashlib.sha256(actual.read_bytes()).hexdigest(),'bytes':actual.stat().st_size,'version':observed.stdout[:4096]}
(output/'controller-tools.json').write_text(json.dumps(tools,sort_keys=True,indent=2)+'\n')

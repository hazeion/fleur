"""Disposable external OS/command protocol for the real guest command's main.
No production function is replaced. Native account/services/packages never run.
"""
import glob
import contextlib
import io
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import stat
import shutil
import time
from unittest.mock import patch

source = Path(__file__).resolve().parents[3] / "scripts/fresh-linux-guest.py"
root = Path(sys.argv[1]).resolve()
scenario = sys.argv[2]
prepared_package = Path(sys.argv[3]).resolve() if len(sys.argv) == 4 else None
nonce = "12345678-1234-1234-1234-123456789abc"
boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
uid = os.getuid() or 1000
# Consumer-protocol cases reuse a frame emitted by the actual root policy over
# real protected fixture files. This does not claim root ownership or native proof.
owned_cases = {
    'ordinary-admitted26': ('26.04', '26.04'),
    'ordinary-admitted26-os-cross': ('24.04', '26.04'),
    'ordinary-admitted26-invalid-evidence': ('26.04', '26.04'),
    'ordinary-admitted26-duplicate': ('26.04', '26.04'),
    'ordinary-admitted26-foreign-row': ('26.04', '26.04'),
    'ordinary-admitted26-unknown-target': ('26.04', '26.04'),
    'owned26-target-valid': ('26.04', '26.04'),
    'owned26-noble-cross': ('26.04', '24.04'),
    'owned24-resolute-cross': ('24.04', '26.04'),
    'owned26-resume-noble': ('26.04', '26.04'),
    'owned24-resume-resolute': ('24.04', '24.04'),
}
owned_frame = None
binding_arguments = []
if scenario in owned_cases:
    sys.path.insert(0, str(source.parent.parent/'experiments/compatibility/runtime-probe'))
    try:
        from test_owned_guest import OwnedGuestCustody, NONCE, BOOT
        policy = OwnedGuestCustody()
        code, owned_frame = policy.observe(release=owned_cases[scenario][0], ordinary_uid=uid)
        if code != 0 or owned_frame.get('fixtureCustodyValidated') is not True:
            raise RuntimeError('Actual protected-file policy did not produce the consumer fixture frame')
    finally:
        sys.path.pop(0)
    nonce, boot = NONCE, BOOT
    binding_arguments = ['--owned-guest-boot-id', boot, '--owned-guest-uid', str(uid), '--owned-guest-manifest-sha256', owned_frame['manifestSha256']]
lab = root / "lab"
lab.mkdir(mode=0o700)
tools = root / "tools"
tools.mkdir(mode=0o700)
state_path = root / "protocol-state.json"
state_path.write_text(json.dumps({"rootPolicyFrame": owned_frame, "installed": False, "enrolled": False, "installPrompts": [], "enrollmentPrompts": [], "staleReprobes": 0, "unexpected": [], "uid": uid, "scenario": scenario}))
catalog_file = source.parent / ('native-candidate-ubuntu26-amd64.json' if scenario == 'crossed-catalog' or scenario in owned_cases and owned_cases[scenario][1] == '26.04' else 'native-candidate-ubuntu24-amd64.json')
catalog_bytes = catalog_file.read_bytes()
catalog = json.loads(catalog_bytes)
metadata = {key: catalog[key] for key in ('formatVersion', 'catalogId', 'artifactAuthentication', 'installationEvidence', 'runtimeSupport', 'authentication', 'artifacts', 'limits')}
metadata.update(internalArtifact=True, catalogSha256=hashlib.sha256(catalog_bytes).hexdigest(),
    legacyProfileAdmission={'verified':True, 'meaning':'internal-catalog-admission-only'},
    provenance={'ordinaryArchiveSha256':'d'*64, 'sourceFilesSha256':'e'*64, 'sourceFiles':[]})
(lab / "package/bin").mkdir(parents=True)
(lab / "package/bin/fleur.ts").write_text("// Owned protocol fixture, never the real runtime\n")
(lab / "package/internal-native-candidate.json").write_text(json.dumps(metadata))
(lab / "package/internal-native-candidate-catalog.json").write_bytes(catalog_bytes)
if scenario == 'candidate-writable-directory':
    (lab/'package').chmod(0o775)
if scenario == 'candidate-writable-marker':
    (lab/'package/internal-native-candidate.json').chmod(0o664)
if scenario == 'candidate-writable-catalog':
    (lab/'package/internal-native-candidate-catalog.json').chmod(0o664)
if scenario == 'candidate-marker-boolean':
    metadata['legacyProfileAdmission']['verified'] = 1
    (lab / 'package/internal-native-candidate.json').write_text(json.dumps(metadata))
if scenario == 'candidate-missing-catalog':
    (lab/'package/internal-native-candidate-catalog.json').unlink()
if scenario == 'candidate-symlink-catalog':
    (lab/'package/internal-native-candidate-catalog.json').rename(root/'retained-source-catalog.json')
    (lab/'package/internal-native-candidate-catalog.json').symlink_to(root/'retained-source-catalog.json')
if scenario == 'candidate-self-rehashed-catalog':
    altered = dict(catalog)
    altered['profile'] = {**catalog['profile'], 'release':'26.04'}
    altered_bytes = json.dumps(altered).encode()
    (lab/'package/internal-native-candidate-catalog.json').write_bytes(altered_bytes)
    metadata['catalogSha256'] = hashlib.sha256(altered_bytes).hexdigest()
    (lab/'package/internal-native-candidate.json').write_text(json.dumps(metadata))
if scenario == 'candidate-artifact-mismatch':
    metadata['artifacts'][0]['version'] = 'caller-version'
    (lab/'package/internal-native-candidate.json').write_text(json.dumps(metadata))
if scenario == 'candidate-missing-hash':
    del metadata['catalogSha256']
    (lab/'package/internal-native-candidate.json').write_text(json.dumps(metadata))
if scenario == 'candidate-unknown-target':
    metadata['catalogId'] = 'caller-candidate'
    (lab/'package/internal-native-candidate.json').write_text(json.dumps(metadata))
if scenario.startswith("ordinary-"):
    (lab / "package/internal-native-candidate.json").unlink()
    (lab / "package/internal-native-candidate-catalog.json").unlink()
    (lab / "package/package.json").write_text(json.dumps({"name":"fleur"}))
    catalog=json.loads((source.parent/'native-candidate-ubuntu24-amd64.json').read_text())
    profile={"method":"docker-official-apt","verified":True,**catalog['profile'],
             "repositoryFingerprint":catalog['authentication']['repositoryFingerprint'],
             "artifacts":{item['name']:{"architecture":"amd64",**{key:item[key] for key in ("name","version","url","sha256","size")}} for item in catalog['artifacts']}}
    target=lab / "package/src/setup/verified-apt-profiles.json";target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps({"formatVersion":1,"entries":[{"evidence":{"reportSha256":"75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2","sourceCommit":"a9606d74fd55b252c0aab8432ff72ec513457a5e","artifactCatalogSha256":"540de9d76fc2aa8c260d1579a68c64ff0f1474b61cd332cfd428785432a56e58"},"profile":profile}]}))
    if scenario.startswith('ordinary-admitted26'):
        rows = json.loads((source.parent.parent/'src/setup/verified-apt-profiles.json').read_text())
        target.write_text(json.dumps({'formatVersion':1,'entries':[entry for entry in rows['entries'] if entry['profile']['release']=='26.04']}))
        if scenario == 'ordinary-admitted26-invalid-evidence':
            rows=json.loads(target.read_text());rows['entries'][0]['evidence']['sourceCommit']='0'*40;target.write_text(json.dumps(rows))
        if scenario == 'ordinary-admitted26-foreign-row':
            rows=json.loads(target.read_text());foreign=json.loads((source.parent.parent/'src/setup/verified-apt-profiles.json').read_text())['entries'][0];foreign['evidence']['sourceCommit']='0'*40;rows['entries'].append(foreign);target.write_text(json.dumps(rows))
        if scenario == 'ordinary-admitted26-unknown-target':
            rows=json.loads(target.read_text());rows['entries'][0]['profile']['release']='27.04';target.write_text(json.dumps(rows))
        if scenario == 'ordinary-admitted26-duplicate':
            rows=json.loads(target.read_text());rows['entries'].append(rows['entries'][0]);target.write_text(json.dumps(rows))
    if scenario == "ordinary-invalid-evidence":
        value=json.loads(target.read_text());value['entries'][0]['evidence']['sourceCommit']='0'*40;target.write_text(json.dumps(value))
for name in ["fleur-internal-native-candidate.tgz", "runtime-probe.tar", "bun.zip"]:
    (lab / name).write_bytes(("owned fixture " + name).encode())

# Consume the real preparation command's package without recreating its modes
# or synthesizing its catalog metadata. Native account/services remain adapters.
if prepared_package is not None:
    shutil.rmtree(lab / 'package')
    shutil.move(str(prepared_package), lab / 'package')

TOOL = r'''import json,os,pathlib,sys
root=pathlib.Path(os.environ['FIXTURE_ROOT']);p=root/'protocol-state.json';s=json.loads(p.read_text());name=pathlib.Path(sys.argv[0]).name;args=sys.argv[1:];uid=s['uid'];package_checksum='a'*64;enrollment_checksum='b'*64

def save():p.write_text(json.dumps(s))
def envelope(command,data,code,error):
 print(json.dumps({'formatVersion':1,'command':command,'ok':False,'truncated':False,'data':data,'error':{'code':error}}));save();sys.exit(code)
def admitted(command):
 if command=='doctor':s['ordinaryDoctorCalls']=s.get('ordinaryDoctorCalls',0)+1
 else:s['ordinaryReadySetupCalls']=s.get('ordinaryReadySetupCalls',0)+1
 if command=='setup' and s.get('ordinaryReadySetupCalls',0)>=2 and s['scenario']=='ordinary-admitted-grant-change':
  grant=root/'.local/state/fleur/setup/grants.json';grant.parent.mkdir(parents=True,exist_ok=True);grant.write_text('{"fixtureForeignGrant":true}');grant.chmod(0o600)
 data={'components':{'cli':{'state':'ready'},'daemon':{'state':'ready'},'compose':{'state':'ready'},'smoke':{'state':'ready','cleanup':True,'image':'oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e'},'release':{'state':'verified','profile':'ubuntu-24.04-x64-docker-29.9.1','evidence':{'readinessSha256':'75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2','isolationSha256':'75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2'}}}}
 if s['scenario'].startswith('ordinary-admitted26'):
  evidence='5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07';data['components']['release']={'state':'verified','profile':'ubuntu-26.04-x64-docker-29.9.1','evidence':{'readinessSha256':evidence,'isolationSha256':evidence}}
 if command=='doctor' and s['scenario']=='ordinary-admitted-release-refused':
  data['components']['release']={'state':'unverified'};envelope(command,data,4,'PREREQUISITE_UNAVAILABLE')
 print(json.dumps({'formatVersion':1,'command':command,'ok':True,'data':data,'error':None,'truncated':False}));save();sys.exit(0)
def plan():
 checksum=package_checksum if s['scenario']=='reused-package-plan' else enrollment_checksum
 result={'action':'docker-access','method':'docker-official-apt','privilege':'root-equivalent daemon access','user':{'name':'fleur','uid':uid},'group':{'name':'docker','gid':997},'endpoint':'unix:///var/run/docker.sock','checksum':checksum,'target':'Add fleur to Docker group 997: root-equivalent daemon access; plan '+checksum}
 if s['scenario']=='plan-method':result['method']='arch-official-pacman'
 return result
def ask(action,target,checksum,enrollment=False,method="docker-official-apt"):
 if enrollment:
  s.setdefault('enrollmentOffers',[]).append({'action':action,'target':target,'checksum':checksum});save()
  if s['scenario']=='prompt-checksum':checksum='f'*64
 print('Authorize '+action+' using '+method+' for '+target+'\nPlan '+checksum+"\nType 'once', 'remember', or 'deny': ",end='',flush=True)
 reply=sys.stdin.readline().strip();s['enrollmentPrompts' if enrollment else 'installPrompts'].append({'action':action,'target':target,'checksum':checksum,'reply':reply});save();return reply
if name=='python3' and args[:3]==['-I','/usr/local/lib/fleur-owned-guest.py','--owned-guest-nonce'] and s.get('rootPolicyFrame'):
 frame=s['rootPolicyFrame']
 if len(args)<4 or args[3]!=frame['nonce']:raise RuntimeError('Root policy frame nonce differs')
 print(json.dumps(frame));sys.exit(0)
if name=='bun':
 if args==['--version']:print('1.4.3');sys.exit(0)
 if args and args[0]=='-e' and s['scenario'].startswith('ordinary-admitted'):sys.stdout.write('oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e');sys.exit(0)
 command=args[1]
 if s['scenario'].startswith('ordinary-admitted') and s['installed'] and command in ('doctor','setup'):admitted(command)
 if command=='doctor':
  if s.get('freshSession') and s['scenario'].startswith('resume-doctor-data-'):envelope(command,None if s['scenario'].endswith('-null') else 7,4,'PREREQUISITE_UNAVAILABLE')
  if s['installed'] and s['scenario'].startswith('doctor-data-'):envelope(command,None if s['scenario'].endswith('-null') else 7,4,'PREREQUISITE_UNAVAILABLE')
  if s.get('freshSession') and s['scenario'].startswith('resume-smoke-'):
   envelope(command,{'components':{'cli':{'state':'ready'},'daemon':{'state':'ready'},'compose':{'state':'ready'},'smoke':{'state':'image-required','image':'oven/bun@sha256:'+'c'*64}}},3,'AUTHORITY_REQUIRED')
  ready=s['installed'];envelope(command,{'components':{'cli':{'state':'ready' if ready else 'missing'},'daemon':{'state':'denied' if ready and s['scenario']!='apt-index-incomplete' else 'missing'},'compose':{'state':'ready' if ready else 'missing'},'smoke':{'state':'missing'},'release':{'state':'unverified'}}},4,'PREREQUISITE_UNAVAILABLE')
 if command!='setup':raise RuntimeError('Unexpected fake CLI command')
 if '--json' in args:
  if s.get('freshSession') and s['scenario'].startswith('resume-smoke-data-'):envelope(command,None if s['scenario'].endswith('-null') else 7,3,'AUTHORITY_REQUIRED')
  if s.get('freshSession') and s['scenario'].startswith('resume-smoke-'):
   envelope(command,{'plan':{'action':'image-acquire','method':'docker-digest-pull','image':'oven/bun@sha256:'+'c'*64,'checksum':'d'*64},'resumable':True,'grantsCreated':False},3,'AUTHORITY_REQUIRED')
  if not s['installed']:envelope(command,{'plan':{'action':'install','checksum':package_checksum}},3,'AUTHORITY_REQUIRED')
  if not s['enrolled'] and s['scenario']=='setup-recovery-null':envelope(command,None,5,'RECOVERY_REQUIRED')
  if not s['enrolled'] and s['scenario'].startswith('plan-data-'):envelope(command,None if s['scenario'].endswith('-null') else 7,3,'AUTHORITY_REQUIRED')
  if not s['enrolled'] and s['scenario'].startswith('plan-value-'):envelope(command,{'plan':None if s['scenario'].endswith('-null') else 7},3,'AUTHORITY_REQUIRED')
  if not s['enrolled'] and s['scenario']=='setup-unavailable-null':envelope(command,None,4,'PREREQUISITE_UNAVAILABLE')
  if not s['enrolled']:envelope(command,{'plan':plan(),'resumable':True},3,'AUTHORITY_REQUIRED')
  if s['scenario']=='stale-replayed-plan':envelope(command,{'plan':plan()},3,'AUTHORITY_REQUIRED')
  if s['scenario'].startswith('stale-data-'):envelope(command,None if s['scenario'].endswith('-null') else 7,3,'HUMAN_ACTION_REQUIRED')
  s['staleReprobes']+=1;envelope(command,{'access':{'state':'new-login-required'},'resumable':True},3,'HUMAN_ACTION_REQUIRED')
 if s.get('freshSession') and s['scenario'].startswith('resume-smoke-'):
  action={'resume-smoke-install':'install','resume-smoke-access':'docker-access','resume-smoke-image':'image-acquire'}[s['scenario']]
  method='docker-digest-pull' if action=='image-acquire' else 'docker-official-apt'
  target='oven/bun@sha256:'+'c'*64+' via unix:///var/run/docker.sock' if action=='image-acquire' else 'Unexpected package or account action'
  checksum='d'*64 if action=='image-acquire' else 'e'*64
  s.setdefault('smokeOffers',[]).append({'action':action,'method':method,'target':target,'checksum':checksum});save()
  reply=ask(action,target,checksum,method=method)
  s.setdefault('smokeReplies',[]).append({'action':action,'method':method,'target':target,'checksum':checksum,'reply':reply});save();sys.exit(3)
 if not s['installed']:
  for action in ['repository-configuration','install','configuration','docker-access','service-start','service-enable']:
   if ask(action,'Docker fixture package-side-effect plan',package_checksum)!='once':
    if s['scenario']=='pty-orphan':
     import time
     pid=os.fork()
     if pid:
      (root/'orphan-pid').write_text(str(pid));time.sleep(0.1);sys.exit(3)
     while True:
      (root/'orphan-heartbeat').write_text(str(time.monotonic()));time.sleep(0.02)
    sys.exit(3)
  s['installed']=True;save();print('Exact verified packages are installed; run doctor');sys.exit(4)
 if not s['enrolled']:
  requested=plan()
  if ask(requested['action'],requested['target'],requested['checksum'],True)!='once':sys.exit(3)
  if s['scenario']=='denied-enrollment-outcome':print('Enrollment authority was refused');sys.exit(3)
  s['enrolled']=True;save();print('Enrollment complete. Start a new login.');sys.exit(3)
 print('Start a new login; membership was not repeated');sys.exit(3)
if name=='uname' and s['scenario'] in ('command-orphan','command-orphan-timeout'):
 import time
 pid=os.fork()
 if pid:
  (root/'orphan-pid').write_text(str(pid));sys.exit(0)
 time.sleep(0.2)
 (root/'orphan-heartbeat').write_text(str(time.monotonic()))
 if s['scenario']=='command-orphan':os.write(1,b'x'*(2*1024*1024+1))
 while True:
  (root/'orphan-heartbeat').write_text(str(time.monotonic()));time.sleep(0.02)
if name=='uname':print('x86_64' if args==['-m'] else 'Linux 6.8.0-fixture x86_64 GNU/Linux');sys.exit(0)
if name=='systemd-detect-virt':print('qemu');sys.exit(0)
if name=='dpkg-query' and s['scenario']=='owned26-target-valid':
 s['targetBoundaryObserved']=True;save();print('TARGET_BOUNDARY_OBSERVED',file=sys.stderr);sys.exit(42)
if name=='dpkg-query':
 if '--show' not in args:raise RuntimeError('Unexpected package mutation/query')
 print('base-files\tfixture\tii ')
 if s['installed']:
  for package in ['docker-ce','docker-ce-cli','containerd.io','docker-buildx-plugin','docker-compose-plugin']:print(package+'\tfixture-version\tii ')
 sys.exit(0)
if name=='systemctl':
 if not args or args[0]!='show':raise RuntimeError('No direct service mutation in fixture')
 print('LoadState='+('loaded' if s['installed'] else 'not-found')+'\nActiveState='+('active' if s['installed'] else 'inactive')+'\nUnitFileState='+('enabled' if s['installed'] else 'disabled'));sys.exit(0)
if name=='id':
 if args in (['-un'],['--user','--name'],['--name','--user']):print('fleur')
 elif args in (['-u'],['--user']):print(uid)
 elif args and args[0] in ('--groups','-G'):
  groups=str(uid)+' 27'+(' 997' if s['enrolled'] and ('fleur' in args or s.get('freshSession',False)) else '')
  if s['scenario']=='resume-reordered-groups' and s.get('freshSession') and 'fleur' not in args:groups='997 27 '+str(uid);s['reorderedSessionGroups']=True;save()
  if s['scenario']=='resume-lost-group' and s.get('freshSession'):groups=str(uid)+' 997'
  print(groups)
 else:print('uid='+str(uid)+'(fleur) gid='+str(uid)+'(fleur) groups='+str(uid)+'(fleur),27(sudo)'+(',997(docker)' if s.get('freshSession') else ''))
 sys.exit(0)
if name=='getent':
 if 'passwd' in args:print('fleur:x:'+str(uid)+':'+str(uid)+':Fixture:'+str(root)+':/bin/bash')
 elif 'group' in args:print('docker:x:997:'+('fleur' if s['enrolled'] else ''))
 else:raise RuntimeError('Unexpected directory lookup')
 sys.exit(0)
if name=='stat':print('1|'+('3' if s.get('freshSession') and s['scenario']=='resume-socket-change' else '2')+'|socket|0|997|660');sys.exit(0)
if name=='python3' and s['scenario'].startswith('ordinary-admitted') and args[0].endswith('/runtime-probe/run.py'):
 s['restrictionCalls']=s.get('restrictionCalls',0)+1;save();print(json.dumps({'bounded_probe_passed':True,'cleanup_complete':True,'v1_gate_passed':False}));sys.exit(0)
if name=='docker':
 if s['scenario'].startswith('ordinary-admitted') and args[:2]==['--host','unix:///var/run/docker.sock']:
  query=args[2:]
  if query in (['info','--format','{{json .}}'],['version','--format','{{json .Server}}']):
   s.setdefault('ordinaryDaemonQueries',[]).append(query);save()
   if query[0]=='info':
    info={'ServerVersion':'29.9.1','KernelVersion':'7.0.0-38-generic' if s['scenario'].startswith('ordinary-admitted26') else '6.8.0-147-generic','OSType':'linux','Architecture':'x86_64','Driver':'overlayfs','CgroupDriver':'systemd','CgroupVersion':'2','MemoryLimit':True,'SwapLimit':True,'CpuCfsPeriod':True,'CpuCfsQuota':True,'PidsLimit':True,'SecurityOptions':['name=apparmor,profile=default','name=seccomp,profile=builtin','name=cgroupns'],'Name':'private-fixture-daemon-name','Labels':['private-fixture-daemon-label']}
    if s['scenario']=='ordinary-admitted-security-duplicate':info['SecurityOptions']=['name=apparmor','name=apparmor']
    if s['scenario']=='ordinary-admitted-security-mixed':info['SecurityOptions']=['name=apparmor','name=apparmor,profile=default']
    if s['scenario']=='ordinary-admitted-security-malformed':info['SecurityOptions']=[True]
    if s['scenario']=='ordinary-admitted-security-unknown':info['SecurityOptions']=['name=apparmor','name=seccomp,profile=/private-fixture/custom.json']
    if s['scenario']=='ordinary-admitted-security-apparmor-custom':info['SecurityOptions']=['name=apparmor,profile=/private-fixture/custom.json']
    if s['scenario']=='ordinary-admitted-security-apparmor-unconfined':info['SecurityOptions']=['name=apparmor,profile=unconfined']
    if s['scenario']=='ordinary-admitted-security-apparmor-docker-default':info['SecurityOptions']=['name=apparmor,profile=docker-default']
    print(json.dumps(info))
   else:print(json.dumps({'Version':'29.9.1','GitCommit':'b26fb77','KernelVersion':'7.0.0-38-generic' if s['scenario'].startswith('ordinary-admitted26') else '6.8.0-147-generic','Os':'linux','Arch':'amd64','Platform':{'Name':'Docker Engine - Community','Private':'private-fixture-platform'},'Components':[{'Name':'Engine','Version':'29.9.1','Details':{'GitCommit':'b26fb77','Private':'private-fixture-component'}},{'Name':'containerd','Version':'v2.4.2','Details':{'GitCommit':'b7a25261e029d68978bbf290df0a62fc819b3c51'}},{'Name':'runc','Version':'1.5.2','Details':{'GitCommit':'v1.5.2-0-g29dd3dc2'}}],'ID':'private-fixture-daemon-id'}))
   sys.exit(0)
 if s['scenario'].startswith('ordinary-admitted') and args[:2]==['--host','unix:///var/run/docker.sock']:
  call=args[2:]
  if call[:2]==['ps','--all']:print('');sys.exit(0)
  if call[0]=='create':
   s['sentinel']={'Id':'a'*64,'Name':'/'+call[call.index('--name')+1],'Config':{'Labels':{'dev.fleur.guest-sentinel':call[call.index('--label')+1].split('=',1)[1]}},'State':{'Running':False}};save();print('a'*64);sys.exit(0)
  if call==['inspect','a'*64]:print(json.dumps([s['sentinel']]));sys.exit(0)
  if call==['rm','a'*64]:s.pop('sentinel');save();print('a'*64);sys.exit(0)
 if args==['context','show']:print('default');sys.exit(0)
 if args==['context','inspect','default','--format','{{json .Endpoints.docker}}']:print(json.dumps({'Host':'unix:///var/run/docker.sock'}));sys.exit(0)
 raise RuntimeError('No Docker mutation in smoke-authority fixture')
if name=='apt-get':
 s['simulationArguments']=args;save()
 if '--simulate' not in args:raise RuntimeError('No direct package mutation in fixture')
 print('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.');sys.exit(0)
s['unexpected'].append({'tool':name,'args':args});save();raise RuntimeError('Unknown fixture command')
'''
for name in ["bun", "uname", "systemd-detect-virt", "dpkg-query", "systemctl", "id", "getent", "apt-get", "stat", "docker", "python3"]:
    target = lab / name if name == "bun" else tools / name
    target.write_text("#!" + sys.executable + " -S\n" + TOOL)
    target.chmod(0o700)

if scenario == "existing-checkpoint":
    (lab / "fresh-linux-state.json").write_text("foreign checkpoint must survive")

apt_lists = root / "apt-lists"
apt_lists.mkdir()
if scenario.startswith("apt-index-"):
    (apt_lists / "lock").write_bytes(b"")
    (apt_lists / "lock").chmod(0o640)
    (apt_lists / "partial").mkdir(mode=0o700)
    (apt_lists / "auxfiles").mkdir(mode=0o755)
    (apt_lists / "auxfiles").chmod(0o755)
    (apt_lists / "archive.ubuntu.com_ubuntu_dists_noble_InRelease").write_bytes(b"owned authenticated InRelease fixture\n")
    (apt_lists / "archive.ubuntu.com_ubuntu_dists_noble_main_binary-amd64_Packages").write_bytes(b"Package: fixture\nVersion: 1\n")
    index_file = apt_lists / "archive.ubuntu.com_ubuntu_dists_noble_main_binary-amd64_Packages"
    if scenario == "apt-index-symlink":
        index_file.unlink()
        (root / "foreign-index").write_bytes(b"foreign index must survive")
        index_file.symlink_to(root / "foreign-index")
    if scenario == "apt-index-nonregular":
        index_file.unlink()
        os.mkfifo(index_file)
    if scenario == "apt-index-oversize":
        with index_file.open("r+b") as stream:
            stream.truncate(64 * 1024 * 1024 + 1)
    if scenario == "apt-index-entry-bound":
        for index in range(1020):
            (apt_lists / ("extra-%04d" % index)).write_bytes(b"")

original_scandir = os.scandir
original_rglob = Path.rglob
original_lstat = Path.lstat
enumeration = {"distinctValidDirectories": 0, "yielded": 0, "firstDirectoryMetadataAfterYielded": None, "enumerationCompleted": False}

def bounded_directory(path):
    return path.parent == lab / "package" and path.name.startswith("verification-directory-")

if scenario == "directory-bound":
    import time
    started = time.monotonic()
    inodes = set()
    for index in range(5001):
        directory = lab / "package" / ("verification-directory-%05d" % index)
        directory.mkdir(mode=0o700)
        inodes.add(original_lstat(directory).st_ino)
    enumeration["distinctValidDirectories"] = len(inodes)
    enumeration["creationSeconds"] = time.monotonic() - started

yielded_directories = set()

def directory_yielded(path):
    if bounded_directory(path):
        yielded_directories.add(str(path.relative_to(lab / "package")))
        enumeration["yielded"] = len(yielded_directories)

def rglob(path, pattern, *args, **kwargs):
    for entry in original_rglob(path, pattern, *args, **kwargs):
        if scenario == "directory-bound" and path == lab / "package":
            directory_yielded(entry)
        yield entry
    if scenario == "directory-bound" and path == lab / "package":
        enumeration["enumerationCompleted"] = True

def directory_metadata_observed():
    if enumeration["firstDirectoryMetadataAfterYielded"] is None:
        enumeration["firstDirectoryMetadataAfterYielded"] = enumeration["yielded"]

class DirectoryEntry:
    def __init__(self, entry):
        self.entry = entry
    def __getattr__(self, name):
        return getattr(self.entry, name)
    def stat(self, *, follow_symlinks=True):
        directory_metadata_observed()
        return self.entry.stat(follow_symlinks=follow_symlinks)

class Scan:
    def __init__(self, original):
        self.original = original
    def __iter__(self):
        return self
    def __next__(self):
        try:
            entry = next(self.original)
        except StopIteration:
            enumeration["enumerationCompleted"] = True
            raise
        if bounded_directory(Path(entry.path)):
            directory_yielded(Path(entry.path))
            return DirectoryEntry(entry)
        return entry
    def close(self):
        self.original.close()
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.close()

def scandir(path):
    entries = original_scandir(path)
    if scenario == "directory-bound" and isinstance(path, (str, os.PathLike)) and Path(path) == lab / "package":
        return Scan(entries)
    return entries

def lstat(path, *args, **kwargs):
    if scenario == "directory-bound" and bounded_directory(path):
        directory_metadata_observed()
    observed = original_lstat(path, *args, **kwargs)
    if scenario.startswith("apt-index-") and path == apt_lists / "lock":
        fields = list(observed)
        fields[4] = fields[5] = 0
        return os.stat_result(fields)
    return observed

original_open = os.open
original_fstat = os.fstat
original_fsync = os.fsync
original_path_open = Path.open
injected = set()

def record_fault(kind):
    injected.add(kind)
    state = json.loads(state_path.read_text())
    state["custodyFaultInjected"] = kind
    state_path.write_text(json.dumps(state))

def source_fault(path):
    if scenario in ("candidate-source-symlink", "candidate-source-mutation") and "candidate" not in injected and isinstance(path, (str, os.PathLike)) and Path(path) == lab / "package/bin/fleur.ts":
        record_fault("candidate")
        entry = lab / "package/bin/fleur.ts"
        original_size = entry.lstat().st_size
        if scenario == "candidate-source-mutation":
            with original_path_open(entry, "r+b") as stream:
                stream.write(b"X" * original_size)
                stream.flush()
        else:
            entry.rename(root / "original-candidate-entry")
            (root / "foreign-source").write_text("foreign source must survive".ljust(original_size, "!"))
            entry.symlink_to(root / "foreign-source")

def apt_open_witness(path):
    if scenario.startswith("apt-index-") and Path(path).parent == apt_lists:
        state = json.loads(state_path.read_text())
        state.setdefault("aptReads", []).append(Path(path).name)
        state_path.write_text(json.dumps(state))
        if Path(path).name == "lock" or scenario == "apt-index-unreadable" and Path(path).name.endswith("_Packages"):
            raise PermissionError(13, "Permission denied", "/var/lib/apt/lists/" + Path(path).name)
        if scenario == "apt-index-race" and Path(path).name.endswith("_Packages") and "apt-race" not in injected:
            injected.add("apt-race")
            Path(path).rename(apt_lists / "parked-index")
            Path(path).write_bytes(b"replacement must survive")

def path_open(path, *args, **kwargs):
    apt_open_witness(path)
    source_fault(path)
    return original_path_open(path, *args, **kwargs)

def descriptor_open(path, *args, **kwargs):
    if str(path) == '/etc/os-release':
        return original_open(os_release_alias, *args, **kwargs)
    if path == "/var/lib/apt/lists":
        return original_open(apt_lists, *args, **kwargs)
    if scenario.startswith("apt-index-") and kwargs.get("dir_fd") is not None and isinstance(path, str) and "/" not in path:
        held = original_fstat(kwargs['dir_fd'])
        expected = original_stat(apt_lists)
        if (held.st_dev, held.st_ino) == (expected.st_dev, expected.st_ino):
            apt_open_witness(apt_lists / path)
    if isinstance(path, (str, os.PathLike)):
        apt_open_witness(path)
    source_fault(path)
    fd = original_open(path, *args, **kwargs)
    if scenario == "resume-checkpoint-change" and "resume-checkpoint" not in injected and isinstance(path, (str, os.PathLike)) and Path(path) == lab / "package/bin/fleur.ts" and (lab / "fresh-linux-state.json").exists():
        record_fault("resume-checkpoint")
        with original_path_open(lab / "fresh-linux-state.json", "r+b") as stream:
            body = stream.read()
            stream.seek(0)
            stream.write(b"X" * len(body))
            stream.flush()
    if scenario == "root-replacement" and "root" not in injected and isinstance(path, (str, os.PathLike)) and Path(path) == lab:
        record_fault("root")
        lab.rename(root / "parked-lab")
        lab.mkdir(mode=0o700)
        (lab / "foreign-marker").write_text("foreign root must survive")
    return fd

def fsync(fd):
    value = original_fsync(fd)
    target = lab / "fresh-linux-state.json"
    if scenario == "checkpoint-byte-mutation" and "checkpoint" not in injected and stat.S_ISREG(os.fstat(fd).st_mode) and target.exists() and os.fstat(fd).st_ino == target.lstat().st_ino:
        record_fault("checkpoint")
        with original_path_open(target, "r+b") as stream:
            body = stream.read(2 * 1024 * 1024 + 1)
            stream.seek(0)
            stream.write(b"X" * len(body))
            stream.flush()
    target = lab / "fresh-linux-resume-started.json"
    if scenario == "resume-marker-mutation" and "resume-marker" not in injected and stat.S_ISREG(os.fstat(fd).st_mode) and target.exists() and os.fstat(fd).st_ino == target.lstat().st_ino:
        record_fault("resume-marker")
        with original_path_open(target, "r+b") as stream:
            body = stream.read()
            stream.seek(0)
            stream.write(b"X" * len(body))
            stream.flush()
    return value

original_stat = os.stat

def apt_stat(path, *args, **kwargs):
    if str(path) == '/etc/os-release':
        return original_stat(os_release_alias, *args, **kwargs)
    if path == "/var/lib/apt/lists":
        return original_stat(apt_lists, *args, **kwargs)
    observed = original_stat(path, *args, **kwargs)
    if scenario.startswith("apt-index-") and path == "lock" and kwargs.get("dir_fd") is not None:
        fields = list(observed)
        fields[4] = fields[5] = 0
        return os.stat_result(fields)
    return observed

original_read_text = Path.read_text
original_glob = Path.glob
original_popen = __import__("subprocess").Popen
original_monotonic = time.monotonic
clock_advance = 0
original_glob_glob = glob.glob
os_release_file = root/'fixture-os-release'
os_release_file.write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
os_release_file.chmod(0o444)
os_release_alias = root/'fixture-os-release-alias'
os_release_alias.symlink_to(os_release_file)
known = {"/etc/fleur-owned-guest": nonce + "\n", "/proc/1/comm": "systemd\n", "/etc/os-release": 'ID=ubuntu\nVERSION_ID="24.04"\n', "/proc/sys/kernel/random/boot_id": boot + "\n"}

def read_text(path, *args, **kwargs):
    return known[str(path)] if str(path) in known else original_read_text(path, *args, **kwargs)

def local_glob(path, pattern, *args, **kwargs):
    if str(path) == "/var/lib/apt/lists":
        return original_glob(apt_lists, pattern, *args, **kwargs) if scenario.startswith("apt-index-") else iter(())
    return original_glob(path, pattern, *args, **kwargs)

def popen(args, *positional, **kwargs):
    executable = Path(args[0])
    if executable == lab / "bun":
        return original_popen(args, *positional, **kwargs)
    allowed = tools / executable.name
    if allowed.is_file():
        return original_popen([str(allowed), *args[1:]], *positional, **kwargs)
    state = json.loads(state_path.read_text())
    state["unexpected"].append({"tool": str(executable), "args": args[1:]})
    state_path.write_text(json.dumps(state))
    raise RuntimeError("Fixture refused a physical host command")

os.environ.update(HOME=str(root), FIXTURE_ROOT=str(root), PATH=str(tools) + ":/usr/bin:/bin")
sys.argv = [str(source), nonce, *binding_arguments]
with patch("time.monotonic", side_effect=lambda: original_monotonic() + clock_advance + (61 if scenario == "command-orphan-timeout" and (root / "orphan-heartbeat").exists() else 0)), patch.object(os, "stat", side_effect=apt_stat), patch.object(Path, "rglob", rglob), patch.object(os, "scandir", side_effect=scandir), patch.object(Path, "lstat", lstat), patch.object(Path, "open", path_open), patch.object(os, "open", side_effect=descriptor_open), patch.object(os, "fsync", side_effect=fsync), patch.object(Path, "read_text", read_text), patch.object(Path, "glob", local_glob), patch.object(os, "getuid", return_value=uid), patch("glob.glob", side_effect=lambda pattern: [] if pattern.startswith("/etc/apt/") else original_glob_glob(pattern)), patch("subprocess.Popen", side_effect=popen):
    try:
        if scenario.startswith(("resume-doctor-data-", "resume-smoke-data-")) or scenario in ("fresh-resume", "resume-catalog-change", "owned26-resume-noble", "owned24-resume-resolute", "resume-stale-session", "resume-wrong-digest", "resume-replay", "resume-checkpoint-change", "resume-reordered-groups", "resume-boot-change", "resume-artifact-change", "resume-state-symlink", "resume-state-hardlink", "resume-state-oversize", "resume-deadline-expired", "resume-socket-change", "resume-lost-group", "resume-marker-mutation", "resume-smoke-install", "resume-smoke-access", "resume-smoke-image", "resume-human-groups"):
            first_output = io.StringIO()
            with contextlib.redirect_stdout(first_output):
                try:
                    runpy.run_path(str(source), run_name="__main__")
                except SystemExit as first_exit:
                    if first_exit.code != 3:
                        raise RuntimeError("Fixture initial workflow did not reach its genuine handoff")
            initial = json.loads(first_output.getvalue())
            (root / "first-session-report.json").write_text(json.dumps(initial))
            state = json.loads(state_path.read_text())
            state["freshSession"] = scenario != "resume-stale-session"
            state_path.write_text(json.dumps(state))
            if scenario == "resume-boot-change":
                known["/proc/sys/kernel/random/boot_id"] = "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee\n"
            if scenario in ('resume-catalog-change', 'owned26-resume-noble', 'owned24-resume-resolute'):
                replacement_name = 'native-candidate-ubuntu24-amd64.json' if scenario == 'owned26-resume-noble' else 'native-candidate-ubuntu26-amd64.json'
                replacement_bytes = (source.parent/replacement_name).read_bytes()
                replacement = json.loads(replacement_bytes)
                changed_metadata = {key: replacement[key] for key in ('formatVersion', 'catalogId', 'artifactAuthentication', 'installationEvidence', 'runtimeSupport', 'authentication', 'artifacts', 'limits')}
                changed_metadata.update(internalArtifact=True, catalogSha256=hashlib.sha256(replacement_bytes).hexdigest(),
                    legacyProfileAdmission={'verified':True, 'meaning':'internal-catalog-admission-only'}, provenance=metadata['provenance'])
                (lab/'package/internal-native-candidate.json').write_text(json.dumps(changed_metadata))
                (lab/'package/internal-native-candidate-catalog.json').write_bytes(replacement_bytes)
            if scenario == "resume-artifact-change":
                (lab / "package/bin/fleur.ts").write_text("Changed owned candidate after initial handoff\n")
            if scenario == "resume-state-symlink":
                (lab / "fresh-linux-state.json").rename(root / "retained-original-checkpoint")
                (lab / "fresh-linux-state.json").symlink_to(root / "retained-original-checkpoint")
            if scenario == "resume-state-hardlink":
                os.link(lab / "fresh-linux-state.json", root / "retained-checkpoint-link")
            if scenario == "resume-state-oversize":
                with original_path_open(lab / "fresh-linux-state.json", "r+b") as stream:
                    stream.truncate(2 * 1024 * 1024 + 1)
            if scenario == "resume-deadline-expired":
                clock_advance = 901
            state = json.loads(state_path.read_text())
            state["resumeFixtureTransition"] = scenario
            state_path.write_text(json.dumps(state))
            sys.argv = [str(source), nonce, "--resume", "0" * 64 if scenario == "resume-wrong-digest" else initial["checkpoint"]["sha256"], *binding_arguments]
            if scenario == "resume-replay":
                with contextlib.redirect_stdout(io.StringIO()):
                    try:
                        runpy.run_path(str(source), run_name="__main__")
                    except SystemExit as resume_exit:
                        if resume_exit.code != 4 or not (lab / "fresh-linux-resume-started.json").is_file():
                            raise RuntimeError("Fixture first resume did not claim its once-only boundary")
        runpy.run_path(str(source), run_name="__main__")
    finally:
        if scenario == "directory-bound":
            (root / "enumeration-witness.json").write_text(json.dumps(enumeration))

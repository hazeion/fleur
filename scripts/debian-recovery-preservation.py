"""Two-boot Debian canary fixture using the reviewed protected-read primitive.

The generated root command retains the normal fresh verifier's custody, tool,
process retirement and detached-chain checks. Only boot-owned chain identity and
an installed-service baseline for the renewed boot differ. This is never a
product setup capability.
"""
import hashlib
import json
import time

ROOT_CONFIGURATION = r'''
def absent(path):
 current='';parents=[]
 for part in path.strip('/').split('/'):
  parent=current or '/';info=os.lstat(parent)
  if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('Unsafe absent configuration ancestor')
  parents.append((parent,module.identity(info)))
  current=parent.rstrip('/')+'/'+part
  try:os.lstat(current)
  except FileNotFoundError:
   for name,identity in parents:
    if module.identity(os.lstat(name))!=identity:raise RuntimeError('Absent configuration ancestor changed')
   custody();return True
 return False

def configuration_entry(path,helper=False):
 custody()
 if absent(path):return None
 body,identities=module.protected_read(path,1048576,None if helper else 0o644,deadline=end)
 identity=identities[-1][1]
 dev,ino,mode,uid,gid,nlink,size,mtime,ctime=identity
 if len(body)!=size:raise RuntimeError('Configuration byte count changed')
 return {'kind':'file','uid':uid,'gid':gid,'mode':stat.S_IMODE(mode),'nlink':nlink,
         'dev':str(dev),'ino':str(ino),'size':size,'mtimeNs':str(mtime),'ctimeNs':str(ctime),'sha256':hashlib.sha256(body).hexdigest()}

def configuration():
 installed=CURRENT_BOOT or phase!='before'
 paths=('/etc/nftables.conf','/usr/lib/systemd/system/nftables.service')
 helper_paths=('/var/lib/systemd/deb-systemd-helper-enabled/nftables.service.dsh-also',
 '/var/lib/systemd/deb-systemd-helper-enabled/multi-user.target.wants/nftables.service',
 '/var/lib/systemd/deb-systemd-helper-masked/nftables.service',
 '/etc/systemd/system/nftables.service','/etc/systemd/system/multi-user.target.wants/nftables.service',
 '/run/systemd/system/nftables.service','/run/systemd/system/multi-user.target.wants/nftables.service')
 found=command(['/usr/bin/find','/etc/systemd/system','/run/systemd/system','/usr/lib/systemd/system','/lib/systemd/system','/var/lib/systemd',
 '-mindepth','1','-maxdepth','4','(','-name','nftables.service','-o','-name','nftables.service.d','-o','-name','nftables.service.dsh-also',')','-print']).splitlines()
 allowed=set(helper_paths)|{'/usr/lib/systemd/system/nftables.service'}
 for path in found:
  if path=='/lib/systemd/system/nftables.service' and os.path.realpath(path)=='/usr/lib/systemd/system/nftables.service':continue
  if path not in allowed:raise RuntimeError('Unexpected nftables unit or helper path')
 files={path:configuration_entry(path) for path in paths}
 helpers=[]
 for path in sorted(helper_paths):
  entry=configuration_entry(path,True)
  if entry is not None:helpers.append({'path':path,'entry':entry})
 raw=command(['/usr/bin/systemctl','show','nftables.service','--property=FragmentPath,DropInPaths,Transient'],(0,1,4));unit={}
 for line in raw.splitlines():
  key,separator,value=line.partition('=')
  if not separator or key not in ('FragmentPath','DropInPaths','Transient') or key in unit:raise RuntimeError('Ambiguous nftables unit configuration')
  unit[key]=value
 if set(unit)!={'FragmentPath','DropInPaths','Transient'}:raise RuntimeError('Incomplete nftables unit configuration')
 if installed:
  if command(['/usr/bin/dpkg','--root=/','--admindir=/var/lib/dpkg','--verify','nftables'])!='':raise RuntimeError('Installed nftables package files changed')
  for path in paths:
   if command(['/usr/bin/dpkg-query','--root=/','--admindir=/var/lib/dpkg','--search','--',path]).strip()!='nftables: '+path:raise RuntimeError('nftables configuration ownership differs')
 custody();return {'files':files,'helperFiles':helpers,'unit':unit}
'''


def root_source(guest, stage):
    if stage not in ('original', 'current'):
        raise RuntimeError('Fixed canary boot stage required')
    source = guest.DEBIAN_CANARY_ROOT
    replacements = {
        "chain='FL'+binding['nonce'].replace('-','')[:20]": "chain='FL'+hashlib.sha256((binding['nonce']+':'+binding['bootId']).encode('ascii')).hexdigest()[:20]",
        "'not-found' if phase=='before' else 'loaded'": "'not-found' if phase=='before' and not CURRENT_BOOT else 'loaded'",
        "'' if phase=='before' else 'disabled'": "'' if phase=='before' and not CURRENT_BOOT else 'disabled'",
        "custody();print(json.dumps(": ROOT_CONFIGURATION + "\ncustody();print(json.dumps(",
        "'cleanup':phase=='cleanup'": "'cleanup':phase=='cleanup','configuration':configuration(),'observedAtMonotonicNs':time.monotonic_ns()",
    }
    for before, after in replacements.items():
        if source.count(before) != 1:
            raise RuntimeError('Reviewed root canary source shape changed')
        source = source.replace(before, after)
    return 'import hashlib\nCURRENT_BOOT=' + repr(stage == 'current') + '\n' + source


class RecoveryPreservation:
    def __init__(self, guest, contract):
        self.guest = guest
        self.contract = contract

    def observe(self, stage, phase, binding):
        guest, contract = self.guest, self.contract
        if type(binding) is not guest.OwnedGuestBinding or stage not in contract.PHASES or phase not in contract.PHASES[stage]:
            raise RuntimeError('Complete owned recovery canary invocation required')
        guest.verify_owned_binding(binding)
        report = guest.REPORT.setdefault('debianRecoveryPreservation', {
            'scope': 'debian-recovery-two-boot-preservation', 'historicalKernelRulesContinuity': False,
        })
        if set(report) - {'scope', 'historicalKernelRulesContinuity', 'original', 'current'} or report['scope'] != 'debian-recovery-two-boot-preservation' or report['historicalKernelRulesContinuity'] is not False:
            raise RuntimeError('Closed two-boot preservation record required')
        if stage == 'current':
            original = report.get('original')
            if type(original) is not dict:
                raise RuntimeError('Original completed canary ledger required before renewed boot')
            contract.validate_boot_ledger(original['binding'], 'original', original)
            old = original['binding']
            if old['nonce'] != binding.nonce or old['uid'] != binding.uid or old['bootId'] == binding.bootId or old['manifestSha256'] == binding.manifestSha256:
                raise RuntimeError('Different real boot under the same owned fixture required')
        elif 'current' in report:
            raise RuntimeError('Historical canary evidence cannot be extended after reboot')
        ledger = report.setdefault(stage, {'scope': 'debian-recovery-owned-canary-v1', 'stage': stage,
                                          'binding': binding._asdict(), 'observations': {}})
        if set(ledger) != {'scope', 'stage', 'binding', 'observations'} or ledger['scope'] != 'debian-recovery-owned-canary-v1' or ledger['stage'] != stage or ledger['binding'] != binding._asdict():
            raise RuntimeError('Original canary boot ledger changed')
        observations = ledger['observations']
        required = contract.PHASES[stage]
        prior = required[:required.index(phase)]
        if type(observations) is not dict or tuple(observations) != prior:
            raise RuntimeError('Recovery canary phase sequence differs')
        deadline = time.monotonic() + guest.budget_seconds(30)
        request = {'binding': binding._asdict(), 'phase': contract.ROOT_PHASE[phase], 'deadline': deadline}
        _, text, _ = guest.run(['/usr/bin/sudo', '--non-interactive', '--', '/usr/bin/python3', '-I', '-c', root_source(guest, stage), json.dumps(request)],
                               timeout=30, absolute_deadline=deadline)
        if len(text.encode()) > 16384:
            raise RuntimeError('Recovery canary observation exceeded its bound')
        frame = json.loads(text, object_pairs_hook=unique_object)
        contract.validate_canary_frame(stage, binding._asdict(), phase, frame)
        if observations:
            first = observations[required[0]]
            if frame['observedAtMonotonicNs'] <= next(reversed(observations.values()))['observedAtMonotonicNs']:
                raise RuntimeError('Recovery canary phase time did not advance')
            for key in ('binding', 'backend', 'tool', 'selectedTool', 'toolVersion', 'chain', 'canary'):
                if frame[key] != first[key]:
                    raise RuntimeError('Owned canary changed within a boot')
        installed = phase != 'beforeInstall'
        if installed:
            anchor = (report['original']['observations']['afterInterruptedInstall'] if stage == 'current'
                      else observations.get('afterInterruptedInstall', frame))
            if frame['configuration'] != anchor['configuration']:
                raise RuntimeError('Installed nftables configuration changed')
        observations[phase] = frame
        if phase == 'cleanup':
            contract.validate_boot_ledger(binding._asdict(), stage, ledger)
            if stage == 'current':
                contract.validate_two_boot_preservation(report['original']['binding'], binding._asdict(), report)

    def product_boundary(self, phase, binding):
        if phase == 'before':
            return self.observe('original', 'beforeInstall', binding)
        if phase in ('freshLogin', 'afterRuntime', 'cleanup'):
            return self.observe('current', phase, binding)
        raise RuntimeError('Completed-effects interruption must be observed before recovery canary advancement')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate recovery observation field')
        result[key] = value
    return result

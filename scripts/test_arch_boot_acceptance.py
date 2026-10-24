"""Independent mutations of the fixed boot-observation acceptance boundary."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('review_arch_acceptance',Path(__file__).with_name('qualify-debian-kvm.py'))
qualification=importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)
SOURCE='a'*40
EMPTY=hashlib.sha256(b'').hexdigest()


def proof():
    # Fixtures describe producer reports, not native execution evidence.
    flags={name:False for name in ('installationVerified','nativeQualification','runtimeAdmission','humanConsentProof','nativeCpuPerformanceProof')}
    owner={'nonce':'12345678-1234-4234-8234-123456789abc','bootId':'87654321-4321-4321-8321-cba987654321','uid':1000,'manifestSha256':'b'*64}
    os_record={'id':'arch','versionId':None,'buildId':'rolling','sha256':'c'*64}
    root={**owner,'scope':'owned-guest-custody-validation','ok':True,'fixtureCustodyValidated':True,'osRelease':os_record,**flags}
    source_files={name:hashlib.sha256((qualification.REPO/name).read_bytes()).hexdigest() for name in qualification.ARCH_SOURCES}
    commands=[{'name':name,'command':args,'completed':True,'processGroupRetired':True,'exitCode':1,'stdoutBytes':0,'stderrBytes':0,'stdoutSha256':EMPTY,'stderrSha256':EMPTY,'parseComplete':False} for name,args in qualification.arch_commands().items()]
    files=[{'path':name,'state':'unknown'} for name in ['/etc/pacman.conf','/etc/nftables.conf','/usr/lib/systemd/system/nftables.service','/usr/bin/nft']]
    observed={'scope':'fixed-arch-read-only-boot-observation','ok':True,'custodyPreserved':True,'binding':{**owner,'fixtureCustodyValidated':True},'sourceSha256':source_files['scripts/arch-boot-observation.py'],'commands':commands,'files':files,**flags}
    pin=json.loads((qualification.REPO/'scripts/arch-boot-image.json').read_text())
    tools={name:{'resolved':name,'uid':0,'mode':0o755,'bytes':100,'sha256':'d'*64} for name in ['/usr/bin/qemu-img','/usr/bin/qemu-system-x86_64','/usr/bin/cloud-localds','/usr/bin/ssh','/usr/bin/ssh-keygen','/usr/bin/python3']}
    return {'formatVersion':1,'scope':'source-owned-arch-kvm-boot-observation','ok':True,'executed':True,**flags,
        'source':{'commit':SOURCE,'files':source_files},'accelerator':'kvm','toolchain':tools,
        'boot':{'ok':True,'lastBootObservation':{'ok':True,'state':'ready','cloudInitComplete':True,'nonceMatched':True,'transport':{'exitCode':0,'signal':None,'deadlineFired':False,'cleanupConfirmed':True}}},
        'image':{'pin':pin,'precheck':{'ok':True,'imageAuthenticated':True,'headerPrecheck':True,'fullStructureValidated':False,'sha256':pin['sha256'],'bytes':pin['bytes'],'headerPrefixSha256':pin['headerPrefixSha256']},'info':{'format':'qcow2','virtual-size':pin['virtualBytes']},'check':{'check-errors':0}},
        'custody':{'binding':owner,'osRelease':os_record,'before':copy.deepcopy(root),'after':copy.deepcopy(root),'pinnedHostKey':True,'overlay':{'dev':'1','ino':'2'},'qmpBefore':dict.fromkeys(['sameName','running','sameOverlay','kvmEnabled'],True),'qmpAfter':dict.fromkeys(['sameName','running','sameOverlay','kvmEnabled'],True)},
        'observation':observed,'observationTransport':{'exitCode':0,'stderrSha256':EMPTY,'completed':True},
        'cleanup':{'ownedVmReaped':True,'credentialsRemoved':True},'artifactDisposal':{'scope':'owned-full-system-guest-filesystem',**dict.fromkeys(['vmReaped','removalAttempted','scratchRemoved','overlayRemoved','complete'],True)}}


class ArchBootAcceptanceRequirements(unittest.TestCase):
    def assert_mutations_refuse(self,mutations):
        for path,value in mutations:
            with self.subTest(path=path,value=value):
                candidate=proof();target=candidate
                for key in path[:-1]:target=target[key]
                target[path[-1]]=value
                self.assertFalse(qualification.accepted_arch_observation(candidate,SOURCE))

    def test_observation_errors_are_retained_without_becoming_health_or_installation_claims(self):
        self.assertTrue(qualification.accepted_arch_observation(proof(),SOURCE))

    def test_source_image_and_full_structure_cannot_be_unbound_or_promoted(self):
        self.assert_mutations_refuse([(('source','commit'),'e'*40),(('source','files'),{}),(('image','pin','sha256'),'e'*64),
            (('image','precheck','sha256'),'e'*64),(('image','precheck','imageAuthenticated'),False),(('image','precheck','fullStructureValidated'),True),
            (('image','info','backing-filename'),'other.qcow2'),(('image','info','data-file'),'other.raw'),(('image','info','encrypted'),True),
            (('image','info','snapshots'),[{}]),(('image','check','check-errors'),1),(('image','check','leaks'),1)])

    def test_os_binding_before_after_overlay_and_kvm_are_mandatory(self):
        self.assert_mutations_refuse([(('custody','osRelease','versionId'),'rolling'),(('custody','osRelease','buildId'),'stable'),
            (('custody','after','manifestSha256'),'e'*64),(('custody','after','bootId'),'12345678-1234-4234-8234-123456789abc'),
            (('custody','overlay','ino'),'0'),(('custody','pinnedHostKey'),False),(('custody','qmpBefore','kvmEnabled'),False),
            (('custody','qmpAfter','sameOverlay'),1),(('observation','binding','nonce'),'12345678-1234-4234-8234-123456789abd'),
            (('observation','sourceSha256'),'e'*64),(('observation','runtimeAdmission'),True)])

    def test_all_fixed_commands_and_their_combined_bounds_are_required(self):
        self.assert_mutations_refuse([(('observation','commands'),[]),(('observation','commands',0,'command'),['/usr/bin/pacman','--sync']),
            (('observation','commands',0,'completed'),False),(('observation','commands',0,'processGroupRetired'),False),
            (('observation','commands',0,'exitCode'),True),(('observation','commands',0,'stdoutSha256'),'unknown'),
            (('observation','commands',0,'stdoutBytes'),2097153)])
        candidate=proof();candidate['observation']['commands'][0].update(stdoutBytes=2097152,stderrBytes=1)
        self.assertFalse(qualification.accepted_arch_observation(candidate,SOURCE))

    def test_tool_and_file_observations_cannot_disappear_or_claim_unsafe_custody(self):
        self.assert_mutations_refuse([(('toolchain',),{}),(('toolchain','/usr/bin/qemu-img','uid'),1000),
            (('toolchain','/usr/bin/qemu-img','mode'),0o777),(('toolchain','/usr/bin/qemu-img','resolved'),'/tmp/qemu-img'),
            (('observation','files'),[]),(('observation','files',0,'state'),'repaired')])

    def test_boot_transport_and_full_disposal_are_strict_and_cannot_use_numeric_booleans(self):
        self.assert_mutations_refuse([(('formatVersion',),True),(('boot','lastBootObservation','cloudInitComplete'),False),
            (('boot','lastBootObservation','transport','cleanupConfirmed'),False),(('observationTransport','exitCode'),4),
            (('cleanup','ownedVmReaped'),1),(('cleanup','credentialsRemoved'),False),(('artifactDisposal','overlayRemoved'),False),
            (('artifactDisposal','scratchRemoved'),False),(('artifactDisposal','complete'),1),(('installationVerified',),True)])

    def test_closed_selectors_refuse_crossed_authority_and_noncanonical_values(self):
        self.assertEqual(qualification.qualification_case({'arch_boot_observation':True}),'arch-boot-observation')
        self.assertEqual(qualification.qualification_case({'arch_boot_observation':'true','debian_recovery':'false','debian_helpers':''}),'arch-boot-observation')
        self.assertEqual(qualification.qualification_case({}),'fresh-installation')
        for value in [1,None,'True','true\n',[],{}]:
            with self.subTest(value=value),self.assertRaises(ValueError):qualification.qualification_case({'arch_boot_observation':value})
        for inputs in [{'arch_boot_observation':True,'debian_recovery':True},{'arch_boot_observation':True,'debian_helpers':'payload'},
                       {'arch_boot_observation':True,'command':'arbitrary'},{'arch_boot_observation':True,'image':'caller-url'}]:
            with self.subTest(inputs=inputs),self.assertRaises(ValueError):qualification.qualification_case(inputs)


if __name__=='__main__':unittest.main()

class DesktopInputSeparation(unittest.TestCase):
    def test_actual_defaulted_manual_event_preserves_existing_cases(self):
        for value in (False,'false'):
            event={'debian_helpers':'','debian_recovery':False,'arch_boot_observation':True,'desktop_runtime_images':value}
            self.assertEqual(qualification.qualification_case(event),'arch-boot-observation')
            event.update(debian_helpers='exact-helper-pair',debian_recovery=True,arch_boot_observation=False)
            self.assertEqual(qualification.qualification_case(event),'interrupted-recovery')
            event.update(debian_recovery=False)
            self.assertEqual(qualification.qualification_case(event),'fresh-installation')
    def test_producer_cannot_mix_with_or_select_native_qualification(self):
        for value in (True,'true',None,1,'TRUE','0',{},[]):
            for other in ({},{'arch_boot_observation':True},{'debian_helpers':'pair'},{'debian_helpers':'pair','debian_recovery':True}):
                with self.subTest(value=value,other=other),self.assertRaises(ValueError):qualification.qualification_case(dict(other,desktop_runtime_images=value))

"""Independent recovery terminal gates. Fixtures are protocol data, not native proof."""
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

HERE=Path(__file__).parent


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


existing=load('existing_kvm_requirement_fixtures',HERE/'test_qualify_debian_kvm.py')
module=existing.module
canaries=load('independent_recovery_canary_fixtures',HERE/'test_debian_recovery_contract.py')


def recovery_fixture():
    # Reuse the reviewed real-shaped ordinary producer fixture, without running
    # its test or inventing outer executionArtifact.packageName.
    tree=ast.parse((HERE/'test_qualify_debian_kvm.py').read_text())
    method=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='test_terminal_gate_requires_real_guest_disposal')
    assignments=[n for n in method.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in ('source','catalog','proof') for t in n.targets)]
    namespace={'self':existing.InputContract()}
    exec(compile(ast.Module(body=assignments,type_ignores=[]),'<ordinary-producer-fixture>','exec'),namespace)
    report,source=namespace['proof'],namespace['source']
    report['scope']='debian-interrupted-full-system-guest'
    old,new,preservation=canaries.preservation_fixture()
    guest=report['guest']
    guest.pop('debianDependencyPreservation')
    guest.update(assistedRecoveryQualified=True,automaticRecoveryQualified=False,
                 recoveryQualification='separately-scoped-read-only-inspection',debianRecoveryPreservation=preservation)
    names=('fresh-linux-guest.py','fleur-interrupted-guest.py','fleur-transition-owned-reboot.py',
           'fleur-interruption-supervisor-selftest.py','fleur-native-inspector-conformance.ts',
           'debian_recovery_contract.py','debian-recovery-preservation.py')
    record={'formatVersion':1,'scope':'source-owned-debian-interruption-inputs','sourceCommit':source,
            'ordinaryArchiveSha256':report['executionArtifact']['sha256'],
            'files':{name:hashlib.sha256(name.encode()).hexdigest() for name in names}}
    record['sha256']=hashlib.sha256(json.dumps(record,separators=(',',':')).encode()).hexdigest()
    report['qualificationSource']=copy.deepcopy(record)
    guest['qualificationSource']=copy.deepcopy(record)
    overlay={'dev':'2049','ino':'400'}
    transition={'originalBootId':old['bootId'],'currentBootId':new['bootId'],
                'originalManifestSha256':old['manifestSha256'],'currentManifestSha256':new['manifestSha256'],
                'nonce':old['nonce'],'uid':old['uid'],'runtimeAdmission':False,'humanConsentProof':False,
                'historicalTransactionOutcome':'unknown','helperSha256':record['files']['fleur-transition-owned-reboot.py']}
    report['interruptionReboot']={'originalBinding':old,'renewedBinding':new,'transition':transition,
        'qmpBefore':{'sameName':True,'running':True,'sameOverlay':True},'qmpAfter':{'sameName':True,'running':True,'sameOverlay':True},
        'beforeOverlay':overlay,'afterOverlay':copy.deepcopy(overlay),'sameContinuouslyHeldQmp':True,
        'samePinnedSshHostKey':True,'sameOwnedVmProcess':True}
    return report,source


class RecoveryTerminalRequirements(unittest.TestCase):
    def accepts(self,report,source):
        return module.accepted_recovery_guest(report,source)

    def test_real_shaped_ordinary_recovery_report_passes_without_outer_package_name(self):
        report,source=recovery_fixture()
        self.assertNotIn('packageName',report['executionArtifact'])
        saved=copy.deepcopy(report)
        self.assertIs(self.accepts(report,source),True)
        self.assertEqual(report,saved,'Terminal validation cannot repair proof')

    def test_exact_recovery_scope_and_matching_source_record_are_required(self):
        mutations=[lambda p:p.update(scope='fresh-full-system-guest'),lambda p:p.update(scope='generic-recovery'),
                   lambda p:p.pop('qualificationSource'),lambda p:p['guest'].pop('qualificationSource'),
                   lambda p:p['qualificationSource'].update(sourceCommit='c'*40),
                   lambda p:p['guest']['qualificationSource'].update(sha256='c'*64),
                   lambda p:p['qualificationSource'].update(ordinaryArchiveSha256='c'*64),
                   lambda p:p['guest']['qualificationSource']['files'].update(extra='c'*64),
                   lambda p:p['qualificationSource']['files'].pop('debian_recovery_contract.py')]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                report,source=recovery_fixture();mutate(report)
                self.assertIs(self.accepts(report,source),False)

    def test_native_reboot_continuity_and_two_boot_preservation_are_required(self):
        mutations=[lambda p:p.pop('interruptionReboot'),lambda p:p['interruptionReboot'].update(sameContinuouslyHeldQmp=False),
                   lambda p:p['interruptionReboot'].update(samePinnedSshHostKey=False),lambda p:p['interruptionReboot'].update(sameOwnedVmProcess=False),
                   lambda p:p['interruptionReboot']['afterOverlay'].update(ino='999'),
                   lambda p:p['guest'].pop('debianRecoveryPreservation'),
                   lambda p:p['guest']['debianRecoveryPreservation'].update(historicalKernelRulesContinuity=True),
                   lambda p:p['guest']['debianRecoveryPreservation']['original']['observations'].pop('cleanup'),
                   lambda p:p['guest']['debianRecoveryPreservation']['current']['observations'].pop('afterInspection'),
                   lambda p:p['guest']['debianRecoveryPreservation']['current']['observations']['cleanup'].update(cleanup=False),
                   lambda p:p['guest']['debianRecoveryPreservation']['current']['observations']['afterRuntime']['service'].update(ExecMainPID='7'),
                   lambda p:p['guest']['debianRecoveryPreservation']['current']['observations']['afterInspection']['configuration']['files']['/etc/nftables.conf'].update(sha256='d'*64),
                   lambda p:p['interruptionReboot']['renewedBinding'].update(bootId=p['interruptionReboot']['originalBinding']['bootId'])]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                report,source=recovery_fixture();mutate(report)
                self.assertIs(self.accepts(report,source),False)

    def test_numeric_one_cannot_stand_in_for_explicit_continuity_or_cleanup_confirmation(self):
        for section,field in [('qmpBefore','sameName'),('qmpBefore','running'),('qmpAfter','sameOverlay')]:
            with self.subTest(section=section,field=field):
                report,source=recovery_fixture()
                report['interruptionReboot'][section][field]=1
                self.assertIs(self.accepts(report,source),False)
        for field in ('ownedVmReaped','credentialsRemoved'):
            with self.subTest(cleanup=field):
                report,source=recovery_fixture();report['cleanup'][field]=1
                self.assertIs(self.accepts(report,source),False)

    def test_admitted_doctor_setup_and_runtime_disposal_gates_remain_required(self):
        mutations=[lambda p:p['guest'].update(assistedRecoveryQualified=False),
                   lambda p:p['guest'].update(automaticRecoveryQualified=True),
                   lambda p:p['guest'].update(recoveryQualification='automatic-repair'),
                   lambda p:p['executionArtifact'].update(kind='internal-candidate'),
                   lambda p:p['guest']['executionArtifact'].update(kind='internal-candidate'),
                   lambda p:p['guest']['executionArtifact'].update(packageName='fleur-internal-native-verification'),
                   lambda p:p['guest']['runs'][0].update(exitCode=4),
                   lambda p:p['guest']['runs'].pop(),
                   lambda p:p['guest']['runs'][1]['result']['data']['components']['release'].update(profile='ubuntu-26.04-x64-docker-29.9.1'),
                   lambda p:p['guest']['readySetupReprobes'][0].update(snapshotPreserved=False),
                   lambda p:p['guest']['readySetupReprobes'][1].update(grantsPreserved=False),
                   lambda p:p['guest']['restrictionProbe']['result'].update(bounded_probe_passed=False),
                   lambda p:p['guest']['restrictionProbe']['result'].update(cleanup_complete=False),
                   lambda p:p['guest'].update(sentinelCleanup=False),
                   lambda p:p['cleanup'].update(ownedVmReaped=False),lambda p:p['cleanup'].update(credentialsRemoved=False),
                   lambda p:p['artifactDisposal'].update(complete=False),lambda p:p.update(humanConsentProof=True),
                   lambda p:p['restrictionSource'].update(commit='c'*40)]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                report,source=recovery_fixture();mutate(report)
                self.assertIs(self.accepts(report,source),False)


class RecoveryModeInputRequirements(unittest.TestCase):
    def test_only_closed_explicit_recovery_inputs_select_fixed_recovery_driver(self):
        for value in (True,'true'):
            with self.subTest(value=value):
                self.assertIs(module.qualification_mode({'debian_helpers':'payload','debian_recovery':value}),True)
        for value in (False,'false'):
            with self.subTest(value=value):
                self.assertIs(module.qualification_mode({'debian_helpers':'','debian_recovery':value}),False)
        self.assertIs(module.qualification_mode({'debian_helpers':'payload'}),False)
        self.assertIs(module.qualification_mode({}),False)

    def test_missing_helpers_unknown_keys_and_noncanonical_modes_refuse(self):
        cases=[{'debian_recovery':True},{'debian_helpers':'','debian_recovery':'true'},
               {'debian_helpers':'payload','debian_recovery':True,'unknown':'value'}]
        cases += [{'debian_helpers':'payload','debian_recovery':value} for value in ('TRUE',' true','true\n',1,0,None,[],{})]
        for inputs in cases:
            with self.subTest(inputs=inputs),self.assertRaises((RuntimeError,ValueError)):
                module.qualification_mode(inputs)


if __name__=='__main__':unittest.main()

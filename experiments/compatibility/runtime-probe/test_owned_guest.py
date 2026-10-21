"""Real retained fixture files with external OS metadata/command protocols.

Root ownership is supplied by the OS seam, not established on this Mac. The
validator, descriptor traversal, bytes, inodes, links and mutations remain real.
"""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import owned_guest

NONCE = '12345678-1234-4234-8234-123456789abc'
BOOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'


class OwnedGuestCustody(unittest.TestCase):
    def observe(self, scenario='valid', arguments=None, control_binding=None, revalidate=None):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            bodies = {'etc/fleur-owned-guest': NONCE,
                      'etc/fleur-owned-guest.json': json.dumps({'formatVersion': 1, 'nonce': NONCE, 'bootId': BOOT, 'uid': 1000}),
                      'proc/sys/kernel/random/boot_id': BOOT+'\n',
                      'proc/1/comm': 'systemd\n',
                      'usr/lib/os-release': 'ID=ubuntu\nVERSION_ID="24.04"\n',
                      'usr/bin/systemd-detect-virt': 'owned root tool protocol fixture'}
            if scenario=='wrong-boot': bodies['etc/fleur-owned-guest.json']=bodies['etc/fleur-owned-guest.json'].replace(BOOT,'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee')
            if scenario=='wrong-uid': bodies['etc/fleur-owned-guest.json']=bodies['etc/fleur-owned-guest.json'].replace('1000','1001')
            if scenario=='duplicate-key': bodies['etc/fleur-owned-guest.json']=bodies['etc/fleur-owned-guest.json'].replace('{','{"nonce":"wrong",',1)
            for filename, body in bodies.items():
                file = root / filename
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(body)
                file.chmod(0o444)
            for directory in root.rglob('*'):
                if directory.is_dir(): directory.chmod(0o755)
            root.chmod(0o755)
            if scenario=='produce': (root/'etc/fleur-owned-guest.json').unlink()
            if scenario=='ancestor-symlink':
                (root/'etc').rename(root/'etc-original');(root/'etc').symlink_to('etc-original')
            if scenario == 'symlink':
                manifest=root/'etc/fleur-owned-guest.json';manifest.rename(root/'etc/original');manifest.symlink_to('original')
            if scenario == 'writable': (root/'etc/fleur-owned-guest.json').chmod(0o666)
            original_open=os.open;original_stat=os.stat;original_fstat=os.fstat
            paths={}
            def opened(path, flags, mode=0o777, *, dir_fd=None):
                text=str(path)
                translated=str(root/text.lstrip('/')) if text.startswith('/') else text
                fd=original_open(translated,flags,mode,dir_fd=dir_fd)
                logical=text if text.startswith('/') else paths[dir_fd].rstrip('/')+'/'+text
                paths[fd]=logical
                return fd
            def metadata(value, logical):
                fields={key:getattr(value,key) for key in ('st_mode','st_uid','st_gid','st_nlink','st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns')}
                fields.update(st_uid=0,st_gid=0)
                if scenario=='ancestor' and logical=='/etc':fields['st_mode'] |= 0o022
                if scenario=='foreign-owner' and logical=='/etc/fleur-owned-guest.json':fields['st_uid']=1001
                return SimpleNamespace(**fields)
            def fstat(fd):return metadata(original_fstat(fd),paths[fd])
            observations={}
            def observed_stat(path,*,dir_fd=None,follow_symlinks=True):
                text=str(path);translated=str(root/text.lstrip('/')) if text.startswith('/') else text
                logical=text if text.startswith('/') else paths[dir_fd].rstrip('/')+'/'+text
                value=metadata(original_stat(translated,dir_fd=dir_fd,follow_symlinks=follow_symlinks),logical)
                observations[logical]=observations.get(logical,0)+1
                if scenario=='changed-manifest' and logical=='/etc/fleur-owned-guest.json' and observations[logical]==1:
                    file=root/'etc/fleur-owned-guest.json';file.chmod(0o644);file.write_text(bodies['etc/fleur-owned-guest.json'].replace('1000','1001'));file.chmod(0o444)
                return value
            virtualization_calls=0
            clock=[100.0]
            self.virtualization_timeouts=[]
            def virtualized(*args,**kwargs):
                nonlocal virtualization_calls
                virtualization_calls+=1
                self.virtualization_timeouts.append(kwargs['timeout'])
                if scenario=='late-virtualization':clock[0]=111.0
                if scenario=='unrelated-parent-update' and virtualization_calls==2:
                    (root/'etc/unrelated-service-state').write_text('separate root-owned host state')
                return SimpleNamespace(returncode=0,stdout=b'qemu\n',stderr=b'')
            output=io.StringIO()
            with patch('time.monotonic',side_effect=lambda:clock[0]),patch('owned_guest.os.open',side_effect=opened),patch('owned_guest.os.fstat',side_effect=fstat),patch('owned_guest.os.stat',side_effect=observed_stat),patch('owned_guest.os.getuid',return_value=0 if scenario.startswith('produce') else 1000),patch('owned_guest.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=1000)),patch('owned_guest.platform.system',return_value='Linux'),patch('owned_guest.platform.machine',return_value='x86_64'),patch('owned_guest.subprocess.run',side_effect=virtualized),contextlib.redirect_stdout(output):
                if control_binding is None:
                    code=owned_guest.main(['--owned-guest-nonce',NONCE] if arguments is None else arguments)
                else:
                    from host_control import select_owned_context
                    values={**control_binding}
                    if values.get('manifest_sha256')=='fixture':values['manifest_sha256']=hashlib.sha256(bodies['etc/fleur-owned-guest.json'].encode()).hexdigest()
                    try:
                        context=select_owned_context(**values,remaining=1,deadline=101.0)
                        if revalidate=='expired':
                            from host_control import authorize_host_control
                            clock[0]=102.0
                            authorize_host_control(context,remaining=1)
                        report={'ok':context is not None, 'context':context.report() if context is not None else None}
                        code=0 if context is not None else 4
                    except (OSError,ValueError,RuntimeError):
                        report={'ok':False};code=4
                    print(json.dumps(report))
            if scenario.startswith('produce'): self.produced_manifest=json.loads((root/'etc/fleur-owned-guest.json').read_text())
            return code,json.loads(output.getvalue())

    def test_explicit_cli_validates_root_manifest_bound_to_real_fixture_bytes(self):
        code,report=self.observe()
        self.assertEqual(code,0)
        self.assertEqual(report['scope'],'owned-guest-custody-validation')
        self.assertEqual(report['nonce'],NONCE);self.assertEqual(report['bootId'],BOOT);self.assertEqual(report['uid'],1000)
        self.assertFalse(report['runtimeAdmission']);self.assertFalse(report['humanConsentProof']);self.assertFalse(report['nativeCpuPerformanceProof'])

    def test_malicious_root_manifest_or_binding_never_grants_fixture_custody(self):
        for scenario in ('symlink','writable','ancestor','foreign-owner','wrong-boot','wrong-uid','duplicate-key','ancestor-symlink','changed-manifest'):
            with self.subTest(scenario=scenario):
                code,report=self.observe(scenario)
                self.assertEqual(code,4);self.assertFalse(report['ok']);self.assertFalse(report['runtimeAdmission'])
                self.assertNotIn('fixtureCustodyValidated',report)

    def test_missing_or_noncanonical_explicit_nonce_is_refused(self):
        for arguments in ([],['--owned-guest-nonce'],['--owned-guest-nonce','12345678-1234-1234-1234-123456789abc'],['--owned-guest-nonce',NONCE.upper()],['--owned-guest-nonce','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']):
            with self.subTest(arguments=arguments):
                code,report=self.observe(arguments=arguments)
                self.assertEqual(code,4);self.assertFalse(report['ok'])

    def test_hosted_and_owned_selection_cannot_be_combined(self):
        with patch.dict(os.environ,owned_guest.HOSTED):
            code,report=self.observe()
        self.assertEqual(code,4);self.assertFalse(report['ok'])

    def test_partial_hosted_metadata_also_refuses_explicit_owned_selection(self):
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true'},clear=True):
            code,report=self.observe()
        self.assertEqual(code,4);self.assertFalse(report['ok'])

    def test_boot_producer_writes_exclusive_root_manifest_with_original_identity(self):
        code,report=self.observe('produce',['--create',NONCE])
        self.assertEqual(code,0);self.assertTrue(report['manifestCreated'])
        self.assertEqual(self.produced_manifest,{'formatVersion':1,'nonce':NONCE,'bootId':BOOT,'uid':1000})
        self.assertFalse(report['runtimeAdmission'])

    def test_unrelated_directory_contents_do_not_change_retained_manifest_identity(self):
        code,report=self.observe('unrelated-parent-update')
        self.assertEqual(code,0);self.assertTrue(report['fixtureCustodyValidated'])

    def test_late_virtualization_cannot_publish_custody_after_aggregate_budget(self):
        code,report=self.observe('late-virtualization')
        self.assertEqual(code,4);self.assertFalse(report['ok'])
        self.assertNotIn('fixtureCustodyValidated',report)

    def test_explicit_relative_budget_narrows_all_virtualization_commands(self):
        code,report=self.observe(arguments=['--owned-guest-nonce',NONCE,'--budget-seconds','0.25'])
        self.assertEqual(code,0);self.assertTrue(report['ok'])
        self.assertTrue(self.virtualization_timeouts)
        self.assertTrue(all(0<value<=0.25 for value in self.virtualization_timeouts))

    def test_budget_override_cannot_expand_or_make_deadline_nonfinite(self):
        for budget in ('0','-1','11','nan','inf','1e3'):
            with self.subTest(budget=budget):
                code,report=self.observe(arguments=['--owned-guest-nonce',NONCE,'--budget-seconds',budget])
                self.assertEqual(code,4);self.assertFalse(report['ok'])
                self.assertEqual(self.virtualization_timeouts,[])

    def test_runtime_mode_verifies_original_complete_binding_against_real_manifest(self):
        code,report=self.observe(control_binding={'nonce':NONCE,'boot_id':BOOT,'uid':1000,'manifest_sha256':'fixture'})
        self.assertEqual(code,0);self.assertTrue(report['ok'])
        self.assertEqual(report['context']['nonce'],NONCE)
        self.assertEqual((report['context']['bootId'],report['context']['uid']),(BOOT,1000))

    def test_runtime_original_binding_mismatch_is_refused(self):
        valid={'nonce':NONCE,'boot_id':BOOT,'uid':1000,'manifest_sha256':'fixture'}
        for field,value in (('nonce','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),('boot_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),('uid',1001),('manifest_sha256','0'*64),('uid',True)):
            with self.subTest(field=field):
                code,report=self.observe(control_binding={**valid,field:value})
                self.assertEqual(code,4);self.assertFalse(report['ok'])

    def test_partial_runtime_binding_is_refused_before_guest_commands(self):
        valid={'nonce':NONCE,'boot_id':BOOT,'uid':1000,'manifest_sha256':'fixture'}
        for missing in valid:
            with self.subTest(missing=missing):
                code,report=self.observe(control_binding={key:value for key,value in valid.items() if key!=missing})
                self.assertEqual(code,4);self.assertFalse(report['ok']);self.assertEqual(self.virtualization_timeouts,[])
        code,report=self.observe(control_binding={'nonce':NONCE})
        self.assertEqual(code,4);self.assertFalse(report['ok']);self.assertEqual(self.virtualization_timeouts,[])

    def test_runtime_revalidation_cannot_reset_original_context_deadline(self):
        code,report=self.observe(control_binding={'nonce':NONCE,'boot_id':BOOT,'uid':1000,'manifest_sha256':'fixture'},revalidate='expired')
        self.assertEqual(code,4);self.assertFalse(report['ok'])
        self.assertEqual(len(self.virtualization_timeouts),1)

    def test_boot_producer_never_replaces_an_existing_manifest(self):
        code,report=self.observe('produce-existing',['--create',NONCE])
        self.assertEqual(code,4);self.assertFalse(report['ok'])
        self.assertEqual(self.produced_manifest,{'formatVersion':1,'nonce':NONCE,'bootId':BOOT,'uid':1000})

if __name__=='__main__':unittest.main()

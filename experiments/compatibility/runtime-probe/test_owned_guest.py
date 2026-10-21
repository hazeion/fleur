"""Real retained fixture files with external OS metadata/command protocols.

Root ownership is supplied by the OS seam, not established on this Mac. The
validator, descriptor traversal, bytes, inodes, links and mutations remain real.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import owned_guest

NONCE = '12345678-1234-4234-8234-123456789abc'
BOOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'


class OwnedGuestCustody(unittest.TestCase):
    def observe(self, scenario='valid', arguments=None):
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
            def virtualized(*args,**kwargs):
                nonlocal virtualization_calls
                virtualization_calls+=1
                if scenario=='unrelated-parent-update' and virtualization_calls==2:
                    (root/'etc/unrelated-service-state').write_text('separate root-owned host state')
                return SimpleNamespace(returncode=0,stdout=b'qemu\n',stderr=b'')
            output=io.StringIO()
            with patch('owned_guest.os.open',side_effect=opened),patch('owned_guest.os.fstat',side_effect=fstat),patch('owned_guest.os.stat',side_effect=observed_stat),patch('owned_guest.os.getuid',return_value=0 if scenario.startswith('produce') else 1000),patch('owned_guest.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=1000)),patch('owned_guest.platform.system',return_value='Linux'),patch('owned_guest.platform.machine',return_value='x86_64'),patch('owned_guest.subprocess.run',side_effect=virtualized),contextlib.redirect_stdout(output):
                code=owned_guest.main(['--owned-guest-nonce',NONCE] if arguments is None else arguments)
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

    def test_boot_producer_writes_exclusive_root_manifest_with_original_identity(self):
        code,report=self.observe('produce',['--create',NONCE])
        self.assertEqual(code,0);self.assertTrue(report['manifestCreated'])
        self.assertEqual(self.produced_manifest,{'formatVersion':1,'nonce':NONCE,'bootId':BOOT,'uid':1000})
        self.assertFalse(report['runtimeAdmission'])

    def test_unrelated_directory_contents_do_not_change_retained_manifest_identity(self):
        code,report=self.observe('unrelated-parent-update')
        self.assertEqual(code,0);self.assertTrue(report['fixtureCustodyValidated'])

    def test_boot_producer_never_replaces_an_existing_manifest(self):
        code,report=self.observe('produce-existing',['--create',NONCE])
        self.assertEqual(code,4);self.assertFalse(report['ok'])
        self.assertEqual(self.produced_manifest,{'formatVersion':1,'nonce':NONCE,'bootId':BOOT,'uid':1000})

if __name__=='__main__':unittest.main()

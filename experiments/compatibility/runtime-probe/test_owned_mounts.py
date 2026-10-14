"""Owned mount lifecycle contracts; real kernel coverage runs in native CI."""
import unittest
from pathlib import Path


class MountScope(unittest.TestCase):
    def test_only_recorded_daemon_mount_classes_can_be_retired(self):
        from owned_mounts import plan
        root='/runner/owned'
        table=('1 0 8:1 / / rw - ext4 /dev/root rw\n'
               '2 1 8:1 /runner/owned/data /runner/owned/data rw shared:2 - ext4 /dev/root rw\n'
               '3 1 0:4 net:[12] /runner/owned/exec/netns/abc rw - nsfs nsfs rw\n'
               '4 1 8:1 /other /other rw - ext4 /dev/root rw\n')
        self.assertEqual([row['relative'] for row in plan(table,root)],['exec/netns/abc','data'])
        with self.assertRaises(ValueError):
            plan(table.replace('/runner/owned/data /runner/owned/data','/unrelated/source /runner/owned/data'),root)
        for additional in (
            '5 1 0:5 / /runner/owned/data/unknown rw - tmpfs tmpfs rw\n',
            '5 1 8:1 /other /other-peer rw shared:2 - ext4 /dev/root rw\n',
            '5 1 0:4 net:[14] /runner/owned/exec/netns/abc rw - nsfs nsfs rw\n',
        ):
            with self.subTest(additional=additional), self.assertRaises(ValueError):
                plan(table+additional,root)

    def test_mount_parser_decodes_paths_without_accepting_dot_segments(self):
        from owned_mounts import plan
        table='1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 /owned\\040space/data /owned\\040space/data rw - ext4 /dev/root rw\n'
        self.assertEqual(plan(table,'/owned space')[0]['relative'],'data')
        with self.assertRaises(ValueError):
            plan(table.replace('/owned\\040space/data','/owned\\040space/data/../data'),'/owned space')

    def test_snapshot_rejects_symlinks_and_wrong_owner_before_mount_operations(self):
        import tempfile
        from unittest.mock import patch
        from owned_mounts import capture
        with tempfile.TemporaryDirectory(prefix='fleur-mount-scope-') as temporary:
            root=Path(temporary).resolve(); token='fleur-vfs-'+'a'*32
            (root/'owner').write_text(token);(root/'data').mkdir();(root/'exec').mkdir()
            table='1 0 8:1 / / rw - ext4 /dev/root rw\n'
            with patch('owned_mounts._table',return_value=table):
                snapshot=capture(root,token)
                self.assertEqual(snapshot['mounts'],[])
                with self.assertRaises(ValueError):capture(root,'fleur-vfs-'+'b'*32)
                (root/'owner').unlink();(root/'owner').symlink_to(root/'data')
                with self.assertRaises((ValueError,OSError)):capture(root,token)
                alias=root/'alias';alias.symlink_to(root)
                with self.assertRaises((ValueError,OSError)):capture(alias,token)

    def test_replaced_mount_or_root_is_rejected_without_unmounting(self):
        import tempfile
        from unittest.mock import patch
        from owned_mounts import retire
        with tempfile.TemporaryDirectory(prefix='fleur-mount-replacement-') as temporary:
            root=Path(temporary).resolve();token='fleur-vfs-'+'a'*32
            (root/'owner').write_text(token);(root/'data').mkdir();(root/'exec').mkdir()
            identity=root.stat()
            expected={'root':[identity.st_dev,identity.st_ino,identity.st_uid],'mounts':[]}
            table='1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 '+str(root/'data')+' '+str(root/'data')+' rw - ext4 /dev/root rw\n'
            with patch('owned_mounts._table',return_value=table),patch('owned_mounts._unmount') as unmount:
                with self.assertRaises(ValueError):retire(root,token,expected)
                unmount.assert_not_called()
                expected['root'][1]+=1
                with self.assertRaises(ValueError):retire(root,token,expected)
                unmount.assert_not_called()

    def test_directory_removal_is_anchored_and_requires_zero_mounts(self):
        import tempfile
        from unittest.mock import patch
        from owned_mounts import capture, remove_roots
        with tempfile.TemporaryDirectory(prefix='fleur-mount-remove-') as temporary:
            root=Path(temporary).resolve();token='fleur-vfs-'+'a'*32
            (root/'owner').write_text(token);(root/'data').mkdir();(root/'exec').mkdir()
            (root/'unrelated').mkdir();(root/'unrelated/keep').write_text('preserve')
            empty='1 0 8:1 / / rw - ext4 /dev/root rw\n'
            with patch('owned_mounts._table',return_value=empty):snapshot=capture(root,token)
            mounted=empty+'2 1 8:1 '+str(root/'data')+' '+str(root/'data')+' rw - ext4 /dev/root rw\n'
            with patch('owned_mounts._table',return_value=mounted),self.assertRaises(ValueError):
                remove_roots(root,token,snapshot)
            self.assertTrue((root/'data').is_dir())
            (root/'data').rmdir();(root/'data').symlink_to(root/'unrelated')
            with patch('owned_mounts._table',return_value=empty),self.assertRaises(OSError):
                remove_roots(root,token,snapshot)
            self.assertEqual((root/'unrelated/keep').read_text(),'preserve')
            (root/'data').unlink();(root/'data').mkdir()
            with patch('owned_mounts._table',return_value=empty):remove_roots(root,token,snapshot)
            self.assertFalse((root/'data').exists());self.assertFalse((root/'exec').exists())
            self.assertEqual((root/'unrelated/keep').read_text(),'preserve')

"""Bounded full-file provenance hashing at actual file/read/clock boundaries."""
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from privileged_control import hash_control_file


class ControlBinaryHash(unittest.TestCase):
    def test_binary_larger_than_eight_mib_is_hashed_completely_despite_short_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'ctr';content=b'owned ctr provenance\n'*(9*1024*1024//21+1);path.write_bytes(content)
            self.assertEqual(len(content),9437190)
            read=os.read;calls=[]
            def short(fd,size):calls.append(size);return read(fd,min(size,65537))
            with patch('os.read',side_effect=short):actual=hash_control_file(path,deadline=time.monotonic()+3)
            self.assertEqual(actual,'d8ac598bce5b7cb50493572d96d1ea048616c35b49213b0fc8bb30d29b5c3be4');self.assertGreater(len(calls),100)

    def test_same_path_replacement_during_stream_refuses_old_inode_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'ctr';path.write_bytes(b'owned'*400000);read=os.read;changed=False
            def replace(fd,size):
                nonlocal changed
                data=read(fd,size)
                if not changed:
                    changed=True;replacement=Path(directory)/'replacement';replacement.write_bytes(b'owned'*400000);replacement.replace(path)
                return data
            with patch('os.read',side_effect=replace),self.assertRaisesRegex(ValueError,'custody changed'):
                hash_control_file(path,deadline=time.monotonic()+3)

    def test_absolute_clock_cannot_be_renewed_by_partial_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'ctr';path.write_bytes(b'owned'*400000);read=os.read;clock=[100.0];reads=[]
            def partial(fd,size):clock[0]+=.02;reads.append(size);return read(fd,min(size,65536))
            with patch('time.monotonic',side_effect=lambda:clock[0]),patch('os.read',side_effect=partial),self.assertRaisesRegex(ValueError,'deadline expired'):
                hash_control_file(path,deadline=100.05)
            self.assertEqual(len(reads),3)

    def test_oversized_binary_refuses_before_reading_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'ctr'
            with path.open('wb') as output:output.truncate(32*1024**2+1)
            with patch('os.read',side_effect=AssertionError('oversized content read')),self.assertRaisesRegex(ValueError,'size bound'):
                hash_control_file(path,deadline=time.monotonic()+3)


if __name__=='__main__':unittest.main()

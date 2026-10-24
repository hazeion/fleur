"""Independent absolute deadline requirements; no Docker or image interpretation."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

DIRECTORY=Path(__file__).resolve().parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    return module

inputs=load('review_boundary_inputs',DIRECTORY/'artifact_inputs.py')
outer=load('review_boundary_outer',DIRECTORY.parents[2]/'scripts/observe-desktop-runtime.py')

class AbsoluteBoundaryDeadlines(unittest.TestCase):
    def test_artifact_digest_completion_after_deadline_is_not_accepted(self):
        with tempfile.TemporaryFile() as file:
            file.write(b'x');file.flush()
            original=os.read;clock=[0]
            def read(fd,count):
                data=original(fd,count)
                if not data:clock[0]=11
                return data
            with patch.object(inputs.time,'monotonic',side_effect=lambda:clock[0]),patch.object(inputs.os,'read',side_effect=read):
                with self.assertRaisesRegex(ValueError,'deadline'):
                    inputs.digest_fd(file.fileno(),1,10)

    def test_buffered_channel_frame_is_not_published_after_deadline(self):
        channel=outer.Channel.__new__(outer.Channel)
        channel.pending=bytearray(b'{"kind":"ready"}\n');channel.errors=bytearray()
        with patch.object(outer.time,'monotonic',return_value=11):
            with self.assertRaisesRegex(RuntimeError,'DEADLINE'):
                channel.frame(10)

if __name__=='__main__':unittest.main()

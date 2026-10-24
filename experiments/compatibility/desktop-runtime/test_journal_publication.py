"""Independent retained journal publication boundaries, no Docker execution."""
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout

path=Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py'
spec=importlib.util.spec_from_file_location('review_journal_outer',path)
outer=importlib.util.module_from_spec(spec);sys.modules[spec.name]=outer;spec.loader.exec_module(outer)

class JournalPublication(unittest.TestCase):
    def read(self,directory):
        program=outer.journal_program().replace('/tmp',str(directory))
        actual=os.fstat
        def root_identity(fd):
            value=actual(fd)
            return SimpleNamespace(**{key:(0 if key=='st_uid' else getattr(value,key)) for key in
                ('st_dev','st_ino','st_mode','st_uid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')})
        with patch.object(os,'fstat',side_effect=root_identity),redirect_stdout(io.StringIO()):
            exec(compile(program,'<actual-generated-journal-reader>','exec'),{})

    def test_duplicate_json_fields_are_not_published_as_authoritative_journal(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp);file=directory/('guard-'+'a'*64+'.jsonl')
            file.write_bytes(b'{"kind":"binding","kind":"forged"}\n');file.chmod(0o600)
            with self.assertRaises(ValueError):self.read(directory)

    def test_special_permission_bits_are_outside_exact_root_journal_mode(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp);file=directory/('guard-'+'a'*64+'.jsonl')
            file.write_bytes(b'{"kind":"binding"}\n');file.chmod(0o4600)
            with self.assertRaises(ValueError):self.read(directory)

if __name__=='__main__':unittest.main()

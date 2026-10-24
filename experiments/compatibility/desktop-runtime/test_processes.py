import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
spec=importlib.util.spec_from_file_location('desktop_processes',Path(__file__).with_name('processes.py'))
processes=importlib.util.module_from_spec(spec);spec.loader.exec_module(processes)

class CommandTests(unittest.TestCase):
    def test_completed_command_keeps_exact_status_and_bytes(self):
        result=processes.bounded([sys.executable,'-c','import sys;print("out");sys.stderr.write("err\\n");sys.exit(3)'])
        self.assertEqual(result.returncode,3);self.assertEqual(result.stdout,b'out\n');self.assertEqual(result.stderr,b'err\n')
    def test_excess_output_stops_late_side_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory)/'late'
            code='import os,time;os.write(1,b"x"*16384);time.sleep(.5);open('+repr(str(marker))+',"w").write("late")'
            with self.assertRaisesRegex(RuntimeError,'COMMAND_OUTPUT_BOUND'):processes.bounded([sys.executable,'-c',code],limit=1024)
            time.sleep(.6);self.assertFalse(marker.exists())
    def test_timeout_retires_descendant_group_before_late_side_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory)/'late'
            descendant='import time;time.sleep(2);open('+repr(str(marker))+',"w").write("late")'
            code='import subprocess,sys,time;subprocess.Popen([sys.executable,"-c",'+repr(descendant)+']);time.sleep(9)'
            with self.assertRaisesRegex(RuntimeError,'COMMAND_DEADLINE_EXPIRED'):processes.bounded([sys.executable,'-c',code],timeout=1.5)
            time.sleep(2);self.assertFalse(marker.exists())
if __name__=='__main__':unittest.main()

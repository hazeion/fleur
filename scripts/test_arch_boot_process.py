"""Actual local child processes for the read-only collector's failure boundary."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('review_arch_process',Path(__file__).with_name('arch-boot-observation.py'))
observer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ReadonlyQueryRetirementRequirements(unittest.TestCase):
    def capture_children(self):
        children=[]
        original=subprocess.Popen
        def launch(*args,**kwargs):
            child=original(*args,**kwargs);children.append(child);return child
        return children,patch.object(observer.subprocess,'Popen',side_effect=launch)

    def assert_retired(self,children):
        self.assertEqual(len(children),1)
        self.assertIsNotNone(children[0].returncode)
        self.assertTrue(children[0].stdout.closed)
        self.assertTrue(children[0].stderr.closed)
        with self.assertRaises(ProcessLookupError):os.killpg(children[0].pid,0)

    def test_output_overflow_retires_actual_writer_before_late_side_effect(self):
        with tempfile.TemporaryDirectory() as name:
            witness=Path(name)/'late'
            children,capture=self.capture_children()
            source="import sys,pathlib;sys.stdout.buffer.write(b'x'*(9*1024*1024));sys.stdout.flush();pathlib.Path(sys.argv[1]).write_text('late')"
            with capture,self.assertRaisesRegex(ValueError,'output bound') as raised:
                observer.run([sys.executable,'-I','-c',source,str(witness)],time.monotonic()+3)
            facts=raised.exception.observation
            self.assertGreater(facts['stdoutBytes'],2*1024*1024)
            self.assertFalse(facts['completed'])
            self.assertEqual(len(facts['stdoutSha256']),64)
            self.assertFalse(witness.exists())
            self.assert_retired(children)

    def test_original_query_deadline_retires_actual_sleeping_child(self):
        children,capture=self.capture_children()
        with capture,self.assertRaises(TimeoutError) as raised:
            observer.run([sys.executable,'-I','-c','import time;time.sleep(60)'],time.monotonic()+0.15)
        self.assertFalse(raised.exception.observation['completed'])
        self.assert_retired(children)

    def test_retirement_uncertainty_retains_original_query_failure_and_partial_hashes(self):
        real_killpg=os.killpg
        def uncertain(pid,sig):
            if sig==0:raise PermissionError('controlled retirement observation failure')
            return real_killpg(pid,sig)
        children,capture=self.capture_children()
        with capture,patch.object(observer.os,'killpg',side_effect=uncertain),self.assertRaises(PermissionError) as raised:
            observer.run([sys.executable,'-I','-c',"import sys;sys.stdout.buffer.write(b'x'*(9*1024*1024));sys.stdout.flush()"],time.monotonic()+3)
        facts=raised.exception.observation
        self.assertEqual(facts['queryFailure'],'ValueError')
        self.assertEqual(facts['retirementError'],'PermissionError')
        self.assertFalse(facts['processGroupRetired'])
        self.assertFalse(facts['completed'])
        self.assertGreater(facts['stdoutBytes'],2*1024*1024)
        self.assert_retired(children)


if __name__=='__main__':unittest.main()

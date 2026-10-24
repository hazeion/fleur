"""Independent journal-to-live worker binding requirements."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

spec=importlib.util.spec_from_file_location('review_live_journal_outer',Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py')
outer=importlib.util.module_from_spec(spec);sys.modules[spec.name]=outer;spec.loader.exec_module(outer)
from worker_deadline import ROOT_GUARD

class LiveJournalBindingIntegrity(unittest.TestCase):
    def fixture(self):
        journals={};bindings={}
        for number in range(1,5):
            cid=str(number)*64;pid=123+number;deadline=456.25+number
            bindings[cid]={'containerId':cid,'pid':pid,'deadlineVmMonotonic':deadline}
            journals[cid]=[{'kind':'binding','nonce':'owned','bootId':'boot','containerId':cid,'pid':pid,'deadlineVmMonotonic':deadline,'rootGuardSha256':outer.sha(ROOT_GUARD)},
                {'kind':'record','record':{'kind':'armed'}},
                {'kind':'record','record':{'kind':'result','outcome':'deadline','physical_exit_confirmed':True,'kill_lateness_ms':1,'physical_exit_lateness_ms':2}},
                {'kind':'retired','exitCode':0,'records':2}]
        return journals,bindings

    def test_exact_recorded_live_identities_are_required_despite_matching_timings(self):
        journals,bindings=self.fixture()
        self.assertTrue(outer.valid_journals(journals,'owned','boot',expected_bindings=bindings))
        cid=next(iter(journals))
        for key,value in [('pid',999),('deadlineVmMonotonic',999.25),('containerId','f'*64)]:
            with self.subTest(key=key):
                changed=copy.deepcopy(journals);changed[cid][0][key]=value
                self.assertFalse(outer.valid_journals(changed,'owned','boot',expected_bindings=bindings))
        for changed in ({key:value for key,value in bindings.items() if key!=cid},{**bindings,'f'*64:bindings[cid]}):
            self.assertFalse(outer.valid_journals(journals,'owned','boot',expected_bindings=changed))

    def test_original_physical_tolerance_and_terminal_receipt_remain_strict(self):
        journals,bindings=self.fixture();cid=next(iter(journals))
        for row,key,value in [(2,'physical_exit_confirmed',1),(2,'kill_lateness_ms',251),(2,'physical_exit_lateness_ms',251),(2,'outcome','cancelled'),(3,'exitCode',True),(3,'records',True)]:
            with self.subTest(row=row,key=key):
                changed=copy.deepcopy(journals)
                (changed[cid][row]['record'] if row==2 else changed[cid][row])[key]=value
                self.assertFalse(outer.valid_journals(changed,'owned','boot',expected_bindings=bindings))

if __name__=='__main__':unittest.main()

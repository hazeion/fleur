import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('failure_category_outer',Path(__file__).resolve().parents[3]/'scripts/observe-desktop-runtime.py');outer=importlib.util.module_from_spec(spec);spec.loader.exec_module(outer)
class FailureCategories(unittest.TestCase):
    def test_fixed_transport_failure_categories_are_retained(self):
        self.assertEqual(outer.error_category(RuntimeError('inventory deadline')),'HOST_INVENTORY_DEADLINE')
        self.assertEqual(outer.error_category(RuntimeError('leader absent')),'HOST_RETAINED_LEADER_ABSENT')
    def test_arbitrary_exception_content_is_not_published(self):
        for error in (RuntimeError('private arbitrary detail'),ValueError('PRIVATE_DETAIL'),OSError('private filesystem location')):
            self.assertEqual(outer.error_category(error),'DESKTOP_OBSERVATION_FAILED')

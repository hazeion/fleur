import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('guard_binding_entry',Path(__file__).with_name('entry.py'))
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)

class AckDeadline(unittest.TestCase):
    def test_ack_cannot_publish_after_original_vm_deadline(self):
        binding={'nonce':'fixed'};data=b'{"kind":"ack","phase":"ready","nonce":"fixed"}\n'
        with patch.object(entry.time,'monotonic',side_effect=[0,0,31]),patch.object(entry.select,'select',return_value=([0],[],[])),patch.object(entry.os,'read',return_value=data):
            with self.assertRaisesRegex(RuntimeError,'ACK_DEADLINE_EXPIRED'):entry.acknowledge(binding,'ready')
    def test_guard_ack_keeps_original_deadline(self):
        with patch.object(entry.time,'monotonic',return_value=31),patch.object(entry.select,'select',return_value=([],[],[])):
            with self.assertRaisesRegex(RuntimeError,'ACK_DEADLINE_EXPIRED'):entry.acknowledge({'nonce':'fixed'},'guard-fixed',absolute_deadline=30)

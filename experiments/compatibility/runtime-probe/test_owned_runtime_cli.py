"""Actual report CLI rejects incomplete/expired/ambiguous owned authority before tools."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


class OwnedRuntimeCli(unittest.TestCase):
    def test_partial_expired_and_kernel_combined_bindings_refuse_before_host_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);marker=root/'called'
            tool=root/'docker';tool.write_text('#!/bin/sh\nprintf called > '+str(marker)+'\nexit 99\n');tool.chmod(0o700)
            full=['--owned-guest-nonce','12345678-1234-4234-8234-123456789abc','--owned-guest-boot-id','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','--owned-guest-uid','1000','--owned-guest-manifest-sha256','a'*64,'--owned-guest-deadline',str(time.monotonic()-1)]
            cases=[full[:2],full,full+['--kernel-private-network']]
            for arguments in cases:
                with self.subTest(arguments=arguments):
                    child=subprocess.run([sys.executable,'-B',str(Path(__file__).with_name('run.py')),*arguments],stdin=subprocess.DEVNULL,capture_output=True,timeout=3,env={**os.environ,'PATH':str(root)+':/usr/bin:/bin'})
                    self.assertEqual(child.returncode,1,child.stderr)
                    report=json.loads(child.stdout)
                    self.assertFalse(report['bounded_probe_passed']);self.assertFalse(report['v1_gate_passed'])
                    self.assertFalse(marker.exists(),'rejected owned selection reached Docker')


if __name__=='__main__':unittest.main()

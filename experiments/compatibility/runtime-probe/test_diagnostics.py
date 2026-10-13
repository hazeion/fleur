"""Fixed bounded diagnostic input never returns unrelated status data."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from diagnostics import SNAPSHOT_COMMAND, parse_snapshot

class DiagnosticSnapshot(unittest.TestCase):
    def test_actual_shell_collects_only_task_state_and_numeric_cgroup_fields(self):
        with tempfile.TemporaryDirectory(prefix='fleur-runtime-diagnostic-') as temporary:
            root = Path(temporary)
            task = root/'1'
            task.mkdir()
            (task/'status').write_text('Name:\tfixture-private\nPid:\t1\nState:\tR (running)\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t1\n')
            (root/'cpu.stat').write_text('usage_usec 30000000\nuser_usec 15000000\nsystem_usec 15000000\nnr_periods 300\nnr_throttled 290\nthrottled_usec 30000000\n')
            (root/'memory.events').write_text('low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n')
            (root/'memory.current').write_text('123456\n')
            (root/'pids.current').write_text('6\n')
            command = SNAPSHOT_COMMAND.replace('/proc/1/task/[0-9]*/status',str(root/'[0-9]*'/'status')).replace('/sys/fs/cgroup/',str(root)+'/')
            result = subprocess.run(['/bin/sh','-c',command],capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0)
            self.assertNotIn('fixture-private',result.stdout)
            self.assertNotIn('Name:',result.stdout)
            snapshot = parse_snapshot(result.stdout)
            self.assertEqual(snapshot['tasks'][0]['state'],'R')
            self.assertEqual(snapshot['cpu']['usage_usec'],30000000)
            self.assertEqual(snapshot['memory_current'],123456)
            self.assertEqual(snapshot['pids_current'],6)
            for bad in (result.stdout+'Name: forbidden\n', result.stdout.replace('State: R','State: unknown'),
                        result.stdout.replace('Pid: 1','Pid: 0'),result.stdout.replace('cpu usage_usec 30000000\n',''),
                        result.stdout+'cpu usage_usec 1\n','x'*16385):
                with self.subTest(bad=bad[:40]), self.assertRaises(ValueError):
                    parse_snapshot(bad)

"""Exercise fixed host status collection and fail-closed evidence acceptance."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from report import accept_threads
from threads import parse_threads, STATUS_COMMAND

GOOD = 'thread\nPid: 1\nNoNewPrivs: 1\nSeccomp: 2\nSeccomp_filters: 1\nend\nthread\nPid: 7\nNoNewPrivs: 1\nSeccomp: 2\nSeccomp_filters: 1\nend\n'

class AllThreads(unittest.TestCase):
    def test_shell_emits_only_admitted_fields_from_actual_tab_delimited_status(self):
        with tempfile.TemporaryDirectory(prefix='fleur-thread-status-') as temporary:
            root = Path(temporary)
            for pid in (1,7):
                path = root / str(pid)
                path.mkdir()
                (path/'status').write_text(f'Name:\tfixture-only\nPid:\t{pid}\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t1\n')
            command = STATUS_COMMAND.replace('/proc/1/task/[0-9]*/status',str(root/'[0-9]*'/'status'))
            result = subprocess.run(['/bin/sh','-c',command],text=True,capture_output=True,timeout=5)
            self.assertEqual(result.returncode,0)
            self.assertNotIn('Name:',result.stdout)
            self.assertNotIn('fixture-only',result.stdout)
            self.assertTrue(accept_threads(parse_threads(result.stdout)))

    def test_missing_duplicate_and_unfiltered_threads_cannot_pass(self):
        self.assertTrue(accept_threads(parse_threads(GOOD)))
        for bad in (GOOD.replace('Pid: 7','Pid: 1'), GOOD.replace('NoNewPrivs: 1','NoNewPrivs: 0'),
                    GOOD.replace('Seccomp: 2','Seccomp: 0'), GOOD.replace('Seccomp_filters: 1','Seccomp_filters: 2'),
                    GOOD.replace('Seccomp_filters: 1\n',''), GOOD+'Name: forbidden\n',
                    GOOD.replace('Pid: 7','Pid: true'),GOOD[:GOOD.index('thread',1)],'x'*8193):
            with self.subTest(bad=bad[:40]), self.assertRaises(ValueError):
                parse_threads(bad)
        rows = parse_threads(GOOD)
        for bad in (rows[:1],rows+rows,[],None, [dict(rows[0],pid=True),rows[1]],
                    [dict(rows[0],seccomp_filters=0),rows[1]]):
            self.assertFalse(accept_threads(bad))

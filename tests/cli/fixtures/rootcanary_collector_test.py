"""Real unprivileged children exercise the exact source-owned canary collector.

This isolates collection from root custody policy; it does not qualify that policy.
"""
import ast
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
import types
import unittest


class CanaryCollector(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[3] / "scripts/fresh-linux-guest.py"
        tree = ast.parse(source.read_text())
        program = next(ast.literal_eval(node.value) for node in tree.body
                       if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name)
                               and target.id == "DEBIAN_CANARY_ROOT" for target in node.targets))
        command = next(node for node in ast.parse(program).body
                       if isinstance(node, ast.FunctionDef) and node.name == "command")
        self.children = []

        def spawn(*args, **kwargs):
            child = subprocess.Popen(*args, **kwargs)
            self.children.append(child)
            return child

        self.scope = dict(os=os, time=time, signal=signal,
                          selectors=selectors,
                          subprocess=types.SimpleNamespace(Popen=spawn, PIPE=subprocess.PIPE,
                                                           DEVNULL=subprocess.DEVNULL),
                          custody=lambda: None, end=time.monotonic() + 2)
        exec(compile(ast.Module(body=[command], type_ignores=[]), str(source), "exec"), self.scope)

    def tearDown(self):
        # Even a deliberately defective collector cannot leave this test's child.
        for child in self.children:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=3)
            for stream in (child.stdout, child.stderr):
                if stream is not None:
                    stream.close()

    def assert_retired(self):
        self.assertEqual(len(self.children), 1)
        child = self.children[0]
        self.assertIsNotNone(child.returncode)
        self.assertTrue(child.stdout.closed)
        self.assertTrue(child.stderr.closed)
        with self.assertRaises(ProcessLookupError):
            os.killpg(child.pid, 0)

    def invoke(self, program):
        return self.scope["command"]([sys.executable, "-I", "-c", program])

    def test_stdout_excess_retires_actual_child(self):
        with self.assertRaisesRegex(RuntimeError, "output exceeded"):
            self.invoke("import os,time;os.write(1,b'x'*1048577);time.sleep(30)")
        self.assert_retired()

    def test_stderr_excess_retires_actual_child(self):
        with self.assertRaisesRegex(RuntimeError, "output exceeded"):
            self.invoke("import os,time;os.write(2,b'x'*65537);time.sleep(30)")
        self.assert_retired()

    def test_deadline_retires_actual_child(self):
        self.scope["end"] = time.monotonic() + 0.3
        start = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.invoke("import time;time.sleep(30)")
        self.assertLess(time.monotonic() - start, 3)
        self.assert_retired()

    def test_exited_leader_with_live_pipe_holder_is_retired(self):
        self.scope["end"] = time.monotonic() + 0.3
        with self.assertRaises(TimeoutError):
            self.invoke("import os,time;pid=os.fork();os._exit(0) if pid else time.sleep(30)")
        self.assert_retired()

    def test_selector_allocation_failure_retires_actual_child(self):
        def fail():
            raise OSError("injected selector allocation failure")
        self.scope["selectors"] = types.SimpleNamespace(DefaultSelector=fail,
                                                       EVENT_READ=selectors.EVENT_READ)
        with self.assertRaisesRegex(OSError, "selector allocation"):
            self.invoke("import time;time.sleep(30)")
        self.assert_retired()

    def test_selector_register_failure_retires_actual_child(self):
        class FailingRegister(selectors.DefaultSelector):
            def register(self, *args, **kwargs):
                raise OSError("injected selector registration failure")
        self.scope["selectors"] = types.SimpleNamespace(DefaultSelector=FailingRegister,
                                                       EVENT_READ=selectors.EVENT_READ)
        with self.assertRaisesRegex(OSError, "selector registration"):
            self.invoke("import time;time.sleep(30)")
        self.assert_retired()

    def test_selector_close_failure_still_closes_both_streams(self):
        class FailingClose(selectors.DefaultSelector):
            def close(self):
                super().close()
                raise OSError("injected selector close failure")
        self.scope["selectors"] = types.SimpleNamespace(DefaultSelector=FailingClose,
                                                       EVENT_READ=selectors.EVENT_READ)
        with self.assertRaisesRegex(OSError, "selector close"):
            self.invoke("print('owned completion')")
        self.assert_retired()


if __name__ == "__main__":
    unittest.main()

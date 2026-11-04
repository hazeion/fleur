"""Verify negative lint evidence through the runner's public CLI."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


FLOOR = json.loads(Path(__file__).resolve().parents[3].joinpath('scripts', 'bun-floor.json').read_text())['version']
FAKE_BUN = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if args == ['--version']:
    print('@FLOOR@')
elif args[0] == '-e':
    print('6.0.3')
elif args[-1] in ('tsconfig.negative.json', 'tsconfig.operations-negative.json'):
    filename = 'negative.ts' if args[-1] == 'tsconfig.negative.json' else 'operations.negative.ts'
    for code in ('TS2741', 'TS2322', 'TS2322'):
        print(f'{filename}(1,1): error {code}: intended invalid type')
    sys.exit(1)
elif 'invalid.ts' in args:
    case = os.environ['FLEUR_TEST_LINT_CASE']
    message = {'ruleId': '@typescript-eslint/no-explicit-any', 'severity': 2,
               'message': 'Unexpected any. Specify a different type.'}
    filename = Path.cwd() / 'invalid.ts'
    if case == 'parser':
        message.update(ruleId=None, fatal=True, message='Parsing error: unexpected token')
    elif case == 'fatal':
        message['fatal'] = True
    elif case == 'unrelated':
        message['ruleId'] = '@typescript-eslint/no-unused-vars'
    elif case == 'wrong-file':
        filename = Path.cwd() / 'other.ts'
    messages = [message]
    if case == 'mixed':
        messages.append(dict(message, ruleId='@typescript-eslint/no-unused-vars'))
    if case == 'unstructured':
        print('Parser failed before producing JSON')
    else:
        print(json.dumps([{'filePath': str(filename), 'messages': messages}]))
    sys.exit(1)
'''.replace('@FLOOR@', FLOOR)


class RunnerEvidenceTests(unittest.TestCase):
    def test_runtime_differing_from_the_nearest_record_is_rejected_in_the_fixture_layout(self):
        with tempfile.TemporaryDirectory(prefix='fleur-floor-test-') as directory:
            # The distribution fixtures copy `scripts/` and `tooling/` side by side.
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'scripts' / 'bun-floor.json').write_text(json.dumps({'version': '9.9.9'}))
            (root / 'tooling').mkdir()
            shutil.copyfile(Path(__file__).with_name('run.py'), root / 'tooling' / 'run.py')
            bun = root / 'fake-bun'
            bun.write_text('#!/bin/sh\necho 9.9.8\n')
            bun.chmod(0o700)
            result = subprocess.run([sys.executable, str(root / 'tooling' / 'run.py'), '--bun', str(bun)],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 2, result.stdout)
            self.assertIn('Runtime must report Bun 9.9.9; no fallback', result.stderr)

    def test_positive_operation_source_lint_failure_fails_verification(self):
        runner = Path(__file__).with_name('run.py')
        with tempfile.TemporaryDirectory(prefix='fleur-source-lint-test-') as directory:
            bun = Path(directory) / 'explicit fake bun'
            for engine in ('oxlint', 'eslint'):
                with self.subTest(engine=engine):
                    failure = ("\nif " + repr(engine) + " in args[0] and any(Path(value).name == 'operations.ts' for value in args):\n"
                               "    print('operation source violates the selected lint rule')\n    sys.exit(1)\n")
                    bun.write_text(FAKE_BUN + failure)
                    bun.chmod(0o700)
                    result = subprocess.run(
                        [sys.executable, str(runner), '--bun', str(bun)],
                        env=dict(os.environ, FLEUR_TEST_LINT_CASE='intended'),
                        capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, 1, result.stdout)
                    self.assertFalse(json.loads(result.stdout)['passed'])

    def test_negative_lint_requires_only_the_intended_file_and_rule(self):
        runner = Path(__file__).with_name('run.py')
        with tempfile.TemporaryDirectory(prefix='fleur-runner-test-') as directory:
            bun = Path(directory) / 'explicit fake bun'
            bun.write_text(FAKE_BUN)
            bun.chmod(0o700)
            for case in ('intended', 'parser', 'fatal', 'unrelated', 'wrong-file', 'mixed', 'unstructured'):
                with self.subTest(case=case):
                    result = subprocess.run(
                        [sys.executable, str(runner), '--bun', str(bun)],
                        env=dict(os.environ, FLEUR_TEST_LINT_CASE=case),
                        capture_output=True, text=True, timeout=30)
                    report = json.loads(result.stdout)
                    lint = next(row for row in report['checks'] if row['name'] == 'lint-negative')
                    self.assertEqual(lint['exit_code'], 1)
                    expected_pass = case == 'intended'
                    self.assertEqual(report['passed'], expected_pass, result.stdout)
                    self.assertEqual(result.returncode, 0 if expected_pass else 1)


if __name__ == '__main__':
    unittest.main()

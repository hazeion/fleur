#!/usr/bin/env python3
"""Run frozen tooling checks in an external disposable directory."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bun', required=True, help='Explicit Bun 1.4.3 executable')
    args = parser.parse_args()
    bun = str(Path(args.bun).resolve())
    version = subprocess.run([bun, '--version'], capture_output=True, text=True, timeout=30)
    if version.returncode or version.stdout.strip() != '1.4.3':
        parser.error('Runtime must report Bun 1.4.3; no fallback')
    checks = []
    with tempfile.TemporaryDirectory(prefix='fleur-tooling-') as destination:
        root = Path(destination)
        shutil.copytree(Path(__file__).parent, root, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('node_modules', '__pycache__'))

        def run(name, arguments, directory=root, expected=0):
            try:
                result = subprocess.run([bun, *arguments], cwd=directory,
                                        capture_output=True, text=True, timeout=180)
                output = (result.stdout + result.stderr).replace(str(root), '<experiment>')
                row = {'name': name, 'exit_code': result.returncode, 'expected_exit': expected,
                       'matches_expected_exit': result.returncode == expected,
                       'output_sha256': hashlib.sha256(output.encode()).hexdigest(),
                       'output_excerpt': output[:4000], 'output_truncated': len(output) > 4000}
                if name == 'lint-engine':
                    row['matches_expected_exit'] = row['matches_expected_exit'] and output.strip() == '6.0.3'
                if name in ('types-negative', 'operations-negative'):
                    diagnostics = [line for line in output.splitlines() if ': error TS' in line]
                    row['intended_diagnostics_only'] = (
                        len(diagnostics) == 3 and all(line.startswith('negative.ts(' if name == 'types-negative' else 'operations.negative.ts(') for line in diagnostics)
                        and 'TS2741' in output and 'TS2322' in output)
                if name == 'lint-negative':
                    try:
                        reports = json.loads(result.stdout)
                        report = reports[0] if isinstance(reports, list) and len(reports) == 1 else None
                        messages = report.get('messages') if isinstance(report, dict) else None
                        message = messages[0] if isinstance(messages, list) and len(messages) == 1 else None
                        row['intended_diagnostics_only'] = (
                            isinstance(message, dict)
                            and isinstance(report.get('filePath'), str)
                            and Path(report['filePath']).resolve() == (directory / 'invalid.ts').resolve()
                            and message.get('ruleId') == '@typescript-eslint/no-explicit-any'
                            and message.get('severity') == 2
                            and message.get('fatal', False) is False
                            and not result.stderr.strip())
                    except json.JSONDecodeError:
                        row['intended_diagnostics_only'] = False
                checks.append(row)
                return result.returncode == expected
            except subprocess.TimeoutExpired:
                checks.append({'name': name, 'status': 'timeout', 'matches_expected_exit': False})
                return False

        if run('install-main', ['install', '--frozen-lockfile']):
            run('runtime', ['test', 'fixture.test.ts', 'patch.test.ts'])
            run('types-positive', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'])
            run('types-negative', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.negative.json'], expected=1)
            run('operations-positive', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.operations.json'])
            run('operations-negative', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.operations-negative.json'], expected=1)
            run('oxlint', ['node_modules/oxlint/bin/oxlint', 'fixture.ts', 'fixture.test.ts',
                           'patch.test.ts', 'operations.ts', 'declarations.ts'])
        if run('install-lint', ['install', '--frozen-lockfile'], root / 'lint'):
            run('lint-engine', ['-e', 'import ts from "typescript"; console.log(ts.version)'], root / 'lint')
            run('lint-positive', ['node_modules/eslint/bin/eslint.js', 'valid.ts'], root / 'lint')
            run('lint-sources', ['lint/node_modules/eslint/bin/eslint.js', '--config',
                                'lint/eslint.config.js', 'fixture.ts', 'fixture.test.ts',
                                'patch.test.ts', 'operations.ts', 'declarations.ts'])
            run('lint-negative', ['node_modules/eslint/bin/eslint.js', '--format', 'json', 'invalid.ts'], root / 'lint', expected=1)
    passed = all(row.get('matches_expected_exit') and row.get('intended_diagnostics_only', True) for row in checks)
    print(json.dumps({'observed_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'scope': 'Tooling subset only; no database, browser, sandbox or release support claim',
                      'passed': passed, 'checks': checks}, indent=2))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())

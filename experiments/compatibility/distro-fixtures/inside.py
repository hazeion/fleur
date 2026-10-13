"""Execute every available fixture check, preserving individual failures."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess

EVIDENCE = Path('/evidence')
ROOT = Path('/fixtures')
BUN = '/runtime/bun'
checks = []


def run(name, command, cwd=ROOT, timeout=300):
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        output = result.stdout + result.stderr
        (EVIDENCE / (name + '.txt')).write_text(output)
        checks.append({'name': name, 'exit_code': result.returncode,
                       'output_sha256': hashlib.sha256(output.encode()).hexdigest()})
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired) as error:
        (EVIDENCE / (name + '.txt')).write_text(str(error))
        checks.append({'name': name, 'exit_code': None, 'error': type(error).__name__})
        return False


def main():
    EVIDENCE.mkdir(exist_ok=True)
    identity = {'os_release': Path('/etc/os-release').read_text(),
                'kernel': platform.release(), 'architecture': platform.machine(),
                'scope': 'container userspace, host kernel shared; no native host installation proof'}
    (EVIDENCE / 'identity.json').write_text(json.dumps(identity, indent=2))
    architecture = 'arm64' if platform.machine() in ('arm64', 'aarch64') else 'x86_64'
    bootstrapped = run('runtime-bootstrap', ['python3', 'platforms/bootstrap.py', '--system',
                      'Linux', '--architecture', architecture, '--out', '/runtime'])
    if bootstrapped:
        os.environ['PATH'] = '/runtime:' + os.environ['PATH']
        # These copies contain the locked Drizzle declaration patch and its provenance.
        run('tooling-first', ['python3', 'tooling/run.py', '--bun', BUN], timeout=900)
        run('tooling-second', ['python3', 'tooling/run.py', '--bun', BUN], timeout=900)
        rendering = ROOT / 'rendering'
        installed = run('rendering-install', [BUN, 'install', '--frozen-lockfile'], rendering)
        lint_installed = run('rendering-lint-install', [BUN, 'install', '--frozen-lockfile'], rendering / 'lint')
        if installed:
            run('rendering-types', [BUN, 'run', 'types'], rendering)
            run('rendering-build', [BUN, 'run', 'build'], rendering)
            run('rendering-unit-first', [BUN, 'run', 'test'], rendering)
            run('rendering-unit-second', [BUN, 'run', 'test'], rendering)
            if lint_installed:
                run('rendering-lint', [BUN, 'run', 'lint'], rendering)
            browser_installed = run('browser-install', [BUN, './node_modules/@playwright/test/cli.js',
                                                       'install', 'chromium'], rendering)
            if browser_installed:
                # Same default Chromium launch as the fixture: record the actual launched version.
                run('browser-identity', [BUN, '-e', '''import {chromium} from '@playwright/test';
import {createHash} from 'node:crypto'; import {readFileSync} from 'node:fs';
const browser=await chromium.launch();
const executable=chromium.executablePath();
console.log(JSON.stringify({launchedDefaultVersion:browser.version(), fullChromiumExecutable:executable,
 fullChromiumExecutableSha256:createHash('sha256').update(readFileSync(executable)).digest('hex'),
 browserPins:JSON.parse(readFileSync('node_modules/playwright-core/browsers.json','utf8'))},null,2));
await browser.close();'''], rendering)
                run('browser-first', [BUN, 'run', 'browser'], rendering)
                run('browser-second', [BUN, 'run', 'browser'], rendering)
    report = {'scope': 'frozen rendering/tooling on distro userspace; no complete platform or isolation claim',
              'v1_gate_passed': False, 'identity': identity, 'checks': checks,
              'passed': bool(checks) and all(row['exit_code'] == 0 for row in checks)}
    (EVIDENCE / 'fixtures.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

"""Preserve bounded redacted diagnostic evidence, including subprocess timeouts."""
import hashlib
import subprocess


def run_check(name, arguments, cwd, environment, timeout, redactions):
    status = 'completed'
    try:
        result = subprocess.run(arguments, cwd=cwd, env=environment, text=True,
                                capture_output=True, timeout=timeout)
        stdout, stderr, code = result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired as error:
        status, code = 'timeout', None
        stdout, stderr = error.stdout or b'', error.stderr or b''
    def decode(value):
        return value.decode('utf8', errors='replace') if isinstance(value, bytes) else value
    output = decode(stdout) + decode(stderr)
    for value, replacement in redactions:
        output = output.replace(value, replacement)
    excerpt = output if len(output) <= 5000 else output[:2500] + '\n<bounded omitted output>\n' + output[-2500:]
    return {'name': name, 'exit_code': code, 'status': status, 'timeout_seconds': timeout,
            'passed': status == 'completed' and code == 0, 'required': True,
            'output_sha256': hashlib.sha256(output.encode()).hexdigest(),
            'output_excerpt': excerpt, 'output_truncated': len(output) > 5000}

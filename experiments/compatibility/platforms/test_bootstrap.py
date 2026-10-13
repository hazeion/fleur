"""Check native identity through bootstrap CLI and the external OS-query seam."""
import contextlib
import ctypes
import errno
import io
import json
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

import bootstrap


class NativeIdentityTests(unittest.TestCase):
    def test_translation_query_accepts_only_native_or_enoent(self):
        cases = (
            ('native', 0, 0, ctypes.sizeof(ctypes.c_int), True),
            ('absent', None, errno.ENOENT, ctypes.sizeof(ctypes.c_int), True),
            ('permission', None, errno.EPERM, ctypes.sizeof(ctypes.c_int), False),
            ('translated', 1, 0, ctypes.sizeof(ctypes.c_int), False),
            ('malformed-value', 2, 0, ctypes.sizeof(ctypes.c_int), False),
            ('negative-value', -1, 0, ctypes.sizeof(ctypes.c_int), False),
            ('malformed-size', 0, 0, 1, False),
        )
        for name, value, error, size, native in cases:
            with self.subTest(case=name):
                def query(key, output, output_size, new_value, new_size):
                    self.assertEqual(key, b'sysctl.proc_translated')
                    self.assertIsNone(new_value)
                    self.assertEqual(new_size, 0)
                    ctypes.set_errno(error)
                    if error:
                        return -1
                    ctypes.cast(output, ctypes.POINTER(ctypes.c_int))[0] = value
                    ctypes.cast(output_size, ctypes.POINTER(ctypes.c_size_t))[0] = size
                    return 0

                library = Mock()
                library.sysctlbyname.side_effect = query

                def command(args, **kwargs):
                    if args[-1] == 'hw.cputype':
                        return subprocess.CompletedProcess(args, 0, '7\n', '')
                    # Old subprocess seam reproduces the reviewed loss of errno.
                    return subprocess.CompletedProcess(args, 1 if error else 0,
                                                       '' if error else str(value), '')

                stdout = io.StringIO()
                with patch.object(sys, 'argv', ['bootstrap.py', '--system', 'Darwin',
                                                '--architecture', 'x86_64', '--out', '/unused']), \
                     patch.object(bootstrap.platform, 'system', return_value='Darwin'), \
                     patch.object(bootstrap.platform, 'machine', return_value='x86_64'), \
                     patch.object(bootstrap.platform, 'mac_ver', return_value=('15.7.7', (), '')), \
                     patch.object(bootstrap.subprocess, 'run', side_effect=command), \
                     patch('ctypes.CDLL', return_value=library), \
                     patch.object(bootstrap.urllib.request, 'urlopen', side_effect=OSError('no artifact acquired')) as download, \
                     contextlib.redirect_stdout(stdout):
                    result = bootstrap.main()
                report = json.loads(stdout.getvalue())
                self.assertEqual(result, 1)
                self.assertFalse(report['ok'])
                self.assertFalse(report['v1_gate_passed'])
                self.assertEqual(report.get('native_identity_verified', False), native)
                self.assertEqual(report['failure_stage'], 'runtime archive' if native else 'host identity')
                self.assertEqual(download.call_count, 1 if native else 0)


if __name__ == '__main__':
    unittest.main()

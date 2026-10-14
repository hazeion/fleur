"""Actual downloader behavior against a local controlled HTTP service."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

DOWNLOADER = Path(__file__).with_name('arch-download.sh')


class ArchiveTransport(unittest.TestCase):
    def exercise(self, statuses):
        requests = []
        class Archive(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                requests.append(self.path)
                status = statuses[min(len(requests) - 1, len(statuses) - 1)]
                self.send_response(status)
                self.end_headers()
                self.wfile.write(b'frozen snapshot payload\n' if status == 200 else b'archive unavailable\n')
        with ThreadingHTTPServer(('127.0.0.1', 0), Archive) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / 'extra.db.part'
                url = f'http://127.0.0.1:{server.server_port}/repos/2026/10/12/extra/os/x86_64/extra.db'
                result = subprocess.run(['/bin/sh', str(DOWNLOADER), url, str(output)],
                                        capture_output=True, text=True, timeout=15)
                content = output.read_bytes() if output.exists() else None
            server.shutdown()
            worker.join(timeout=2)
        return result, content, requests

    def test_transient_archive_failure_retries_exact_url_without_partial_bytes(self):
        result, content, requests = self.exercise([503, 200])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(content, b'frozen snapshot payload\n')
        self.assertEqual(requests, ['/repos/2026/10/12/extra/os/x86_64/extra.db'] * 2)

    def test_permanent_missing_snapshot_is_not_retried(self):
        result, content, requests = self.exercise([404])
        self.assertEqual(result.returncode, 22)
        self.assertIsNone(content)
        self.assertEqual(len(requests), 1)

    def test_persistent_transient_failure_stops_after_three_attempts(self):
        result, content, requests = self.exercise([503])
        self.assertEqual(result.returncode, 22)
        self.assertIsNone(content)
        self.assertEqual(len(requests), 3)


if __name__ == '__main__':
    unittest.main()

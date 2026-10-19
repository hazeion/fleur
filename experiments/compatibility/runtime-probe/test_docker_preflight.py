"""Default Engine reads use fixed routes, real Unix transport and one deadline."""
import contextlib
import http.server
import json
import os
from pathlib import Path
import socket
import socketserver
import tempfile
import threading
import time
import unittest

from configuration import read_default_docker_control, ContainerdControlUnverified


@contextlib.contextmanager
def engine_fixture(*, delay=0, oversized=False, replace=False):
    requests=[]
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            requests.append(self.path)
            body=json.dumps({'ID':'owned-engine'} if self.path=='/v1.48/info' else {'Version':'28.0.4'}).encode()
            if oversized:body=b'private-host-output'*5000
            self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers()
            if replace and self.path=='/v1.48/info':
                os.rename(self.server.server_address,self.server.server_address+'.old')
                with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as replacement:replacement.bind(self.server.server_address)
            try:
                if delay:
                    for byte in body:
                        self.wfile.write(bytes([byte]));self.wfile.flush();time.sleep(delay)
                else:self.wfile.write(body)
            except (BrokenPipeError,ConnectionResetError):pass
    class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
        daemon_threads=True
    with tempfile.TemporaryDirectory(prefix='fleur-docker-',dir='/tmp') as directory:
        endpoint=str(Path(directory)/'engine.sock')
        with Server(endpoint,Handler) as server:
            thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.01});thread.start()
            try:yield endpoint,requests
            finally:server.shutdown();thread.join()


class DefaultEngineMetadata(unittest.TestCase):
    def test_reads_only_fixed_readonly_routes_and_preserves_server_metadata(self):
        with engine_fixture() as (endpoint,requests):
            info,version,phases=read_default_docker_control(endpoint,timeout=2)
        self.assertEqual(info,{'ID':'owned-engine'})
        self.assertEqual(version,{'Version':'28.0.4'})
        self.assertEqual(requests,['/v1.48/info','/version'])
        self.assertEqual(set(phases),{'docker-default-info','docker-default-version'})
        self.assertTrue(all(type(value) is int and value>=0 for value in phases.values()))

    def test_trickled_body_cannot_renew_the_absolute_deadline(self):
        with engine_fixture(delay=.03) as (endpoint,requests):
            started=time.monotonic()
            with self.assertRaises(ContainerdControlUnverified) as caught:
                read_default_docker_control(endpoint,timeout=.2)
            self.assertLess(time.monotonic()-started,1)
            self.assertTrue(caught.exception.observations['timed_out'])
            self.assertEqual(requests,['/v1.48/info'])

    def test_oversized_body_is_rejected_without_disclosing_its_contents(self):
        with engine_fixture(oversized=True) as (endpoint,requests):
            with self.assertRaises(ContainerdControlUnverified) as caught:
                read_default_docker_control(endpoint,timeout=2)
            self.assertEqual(caught.exception.observations['response_bytes'],65537)
            self.assertNotIn('private-host-output',str(caught.exception.observations))
            self.assertEqual(requests,['/v1.48/info'])

    def test_replaced_socket_is_rejected_before_second_metadata_request(self):
        with engine_fixture(replace=True) as (endpoint,requests):
            with self.assertRaises(ContainerdControlUnverified):
                read_default_docker_control(endpoint,timeout=2)
            self.assertEqual(requests,['/v1.48/info'])

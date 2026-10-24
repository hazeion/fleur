"""Requirements for sanitized, identity-bound Debian candidate observations."""
import ast
import copy
import hashlib
import json
from pathlib import Path
import unittest

source = Path(__file__).with_name('fresh-linux-guest.py')
tree = ast.parse(source.read_text())
tree.body = [node for node in tree.body if not isinstance(node, ast.Try)]
namespace = {}
exec(compile(tree, str(source), 'exec'), namespace)


class DebianDaemonObservation(unittest.TestCase):
    def setUp(self):
        self.info = {'ServerVersion': '29.9.1', 'KernelVersion': '6.12.113+deb13-cloud-amd64', 'OSType': 'linux', 'Architecture': 'x86_64', 'Driver': 'overlayfs', 'CgroupDriver': 'systemd', 'CgroupVersion': '2', 'MemoryLimit': True, 'SwapLimit': True, 'CpuCfsPeriod': True, 'CpuCfsQuota': True, 'PidsLimit': True, 'SecurityOptions': ['name=seccomp,profile=builtin', 'name=cgroupns'], 'Name': 'private-daemon', 'Labels': ['private-label']}
        self.server = {'Version': '29.9.1', 'GitCommit': 'b26fb77', 'KernelVersion': self.info['KernelVersion'], 'Os': 'linux', 'Arch': 'amd64', 'Platform': {'Name': 'Docker Engine - Community', 'Private': 'private-platform'}, 'Components': [{'Name': 'Engine', 'Version': '29.9.1', 'Details': {'GitCommit': 'b26fb77', 'Private': 'private-component'}}, {'Name': 'containerd', 'Version': 'v2.4.2', 'Details': {'GitCommit': 'b7a25261e029d68978bbf290df0a62fc819b3c51'}}, {'Name': 'runc', 'Version': '1.5.2', 'Details': {'GitCommit': 'v1.5.2-0-g29dd3dc2'}}]}
        self.ids = ['daemon-id', 'daemon-id']
        self.calls = []
        def run(args, timeout=0):
            self.assertEqual(timeout, 10)
            self.assertEqual(args[:3], ['docker', '--host', 'unix:///var/run/docker.sock'])
            query = args[3:]
            self.calls.append(query)
            if query == ['info', '--format', '{{.ID}}']:
                return 0, self.ids.pop(0) + '\n', ''
            if query == ['info', '--format', '{{json .}}']:
                return 0, json.dumps(self.info), ''
            if query == ['version', '--format', '{{json .Server}}']:
                return 0, json.dumps(self.server), ''
            raise AssertionError(query)
        namespace['run'] = run

    def observe(self):
        return namespace['observe_debian_candidate_daemon'](['docker', '--host', 'unix:///var/run/docker.sock'])

    def test_records_actual_tuple_and_hashes_identity_without_private_metadata(self):
        result = self.observe()
        self.assertFalse(result['runtimeAdmission'])
        self.assertFalse(result['restartContinuityProof'])
        self.assertEqual(result['daemonIdSha256'], hashlib.sha256(b'daemon-id').hexdigest())
        self.assertEqual(result['info']['CgroupDriver'], 'systemd')
        self.assertEqual(result['info']['CgroupVersion'], '2')
        self.assertEqual(result['info']['SecurityOptions'], ['name=cgroupns', 'name=seccomp,profile=builtin'])
        self.assertEqual(result['server']['Components'][1]['Version'], 'v2.4.2')
        self.assertNotIn('private-', json.dumps(result))
        self.assertNotIn('daemon-id', json.dumps(result))
        self.assertEqual(len(self.calls), 4)

    def test_changed_or_malformed_daemon_identity_refuses(self):
        for ids in (['daemon-id', 'different'], ['', ''], ['bad identity', 'bad identity'], ['a' * 257, 'a' * 257]):
            with self.subTest(ids=ids):
                self.ids = list(ids)
                with self.assertRaises(RuntimeError):
                    self.observe()

    def test_unknown_duplicate_or_malformed_security_refuses(self):
        for options in (['name=unknown'], ['name=cgroupns', 'name=cgroupns'], [None], 'name=cgroupns'):
            with self.subTest(options=options):
                self.ids = ['daemon-id', 'daemon-id']
                self.info['SecurityOptions'] = options
                with self.assertRaises(RuntimeError):
                    self.observe()

    def test_partial_ambiguous_or_incoherent_components_refuse(self):
        valid = copy.deepcopy(self.server)
        variants = [{**valid, 'Version': '29.9.2'}, {**valid, 'KernelVersion': 'other-kernel'}, {**valid, 'Arch': 'arm64'}, {**valid, 'Components': valid['Components'][:2]}, {**valid, 'Components': valid['Components'] + [valid['Components'][0]]}]
        wrong_build = copy.deepcopy(valid)
        wrong_build['Components'][0]['Details']['GitCommit'] = 'other'
        variants.append(wrong_build)
        for server in variants:
            with self.subTest(server=server):
                self.ids = ['daemon-id', 'daemon-id']
                self.server = server
                with self.assertRaises(RuntimeError):
                    self.observe()


if __name__ == '__main__':
    unittest.main()

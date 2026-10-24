"""Producer artifacts must pass the consumer's closed source binding grammar."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('review_desktop_binding_entry', HERE / 'entry.py')
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)


class ProducerBindingFormat(unittest.TestCase):
    def binding(self):
        # These five controller inputs are required by the image producer contract.
        sources = {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
            for name in ('Dockerfile', 'entry.py', 'export_worker.py', 'processes.py', 'guardian_guard.py')}
        sources.update({'runtime-probe/run.py': 'a' * 64, 'rendering/package.json': 'b' * 64,
            'rendering/bun.lock': 'c' * 64})
        return {'nonce': 'a1234567-1234-4234-8234-123456789abc',
            'bootId': 'b1234567-1234-4234-8234-123456789abc', 'daemonId': 'owned-desktop-daemon',
            'kernel': '7.0.14-linuxkit', 'sourceCommit': 'd' * 40, 'sources': sources,
            'guardianId': 'e' * 64, 'preparedImage': None}

    def test_real_producer_controller_filenames_are_admitted_without_losing_source_hashes(self):
        binding = self.binding()
        self.assertIn('Dockerfile', binding['sources'])
        self.assertTrue(entry.valid_binding(binding))

    def test_only_the_exact_root_dockerfile_is_an_extensionless_source_exception(self):
        for name in ('Makefile', '__init__', 'dockerfile', '../Dockerfile',
                'runtime-probe/Dockerfile', 'rendering/Dockerfile', '/Dockerfile'):
            binding = self.binding()
            binding['sources'] = dict(binding['sources'], **{name: 'f' * 64})
            self.assertFalse(entry.valid_binding(binding), name)
        binding = self.binding()
        binding['sources']['Dockerfile'] = True
        self.assertFalse(entry.valid_binding(binding))


if __name__ == '__main__':
    unittest.main()

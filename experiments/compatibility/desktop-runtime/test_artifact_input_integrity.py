"""Independent JSON publication/custody requirements; never loads an image."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('review_artifact_input_integrity', Path(__file__).with_name('artifact_inputs.py'))
loader = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = loader
spec.loader.exec_module(loader)


class ArtifactPublicationIntegrity(unittest.TestCase):
    def fixture(self, directory):
        cleanup = {'formatVersion': 1, 'scope': 'disposable-image-preparation-retirement',
            'cleanup': [{'resource': 'container', 'absent': True}, {'resource': 'image', 'absent': True}],
            'ok': True, 'runtimeAdmission': False, 'nativeQualification': False}
        pins = {}
        for name in loader.FILES:
            body = (json.dumps(cleanup if name == 'preparation-cleanup.json' else {'trusted': True}) + '\n').encode()
            (directory / name).write_bytes(body)
            (directory / name).chmod(0o600)
            pins[name] = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
        origin = {'formatVersion': 1, 'scope': 'desktop-qualification-image-preparation',
            'runtimeAdmission': False, 'nativeQualification': False, 'sourceCommit': 'a' * 40,
            'controllerImageId': 'sha256:' + 'b' * 64, 'artifacts': pins,
            'cleanup': copy.deepcopy(cleanup['cleanup']), 'ok': True}
        catalog = {'formatVersion': 1, 'scope': 'source-owned-desktop-preparation-inputs',
            'runtimeAdmission': False, 'producer': {'workflowRunId': 123, 'artifactId': 456,
            'zipSha256': 'c' * 64, 'imageOriginSha256': ''}, 'origin': origin}
        self.publish_origin(directory, catalog)
        return catalog

    def publish_origin(self, directory, catalog, actual=None):
        body = (json.dumps(catalog['origin'] if actual is None else actual) + '\n').encode()
        (directory / 'image-origin.json').write_bytes(body)
        (directory / 'image-origin.json').chmod(0o600)
        catalog['producer']['imageOriginSha256'] = hashlib.sha256(body).hexdigest()

    def test_short_regular_file_reads_still_publish_the_complete_authenticated_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            catalog = self.fixture(path)
            with loader.open_artifacts(path, catalog) as held:
                original_read = os.read
                with patch.object(loader.os, 'read', side_effect=lambda fd, count: original_read(fd, min(count, 2))):
                    self.assertEqual(held.read_json('source-manifest.json'), {'trusted': True})

    def test_json_changed_after_initial_verification_is_never_published(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            catalog = self.fixture(path)
            with loader.open_artifacts(path, catalog) as held:
                original_verify = held.verify
                changed = False
                def replace_after_verification(name):
                    nonlocal changed
                    fd = original_verify(name)
                    if not changed:
                        changed = True
                        (path / name).write_bytes(b'{"trusted":false}\n')
                    return fd
                with patch.object(held, 'verify', side_effect=replace_after_verification):
                    with self.assertRaises(ValueError):
                        held.read_json('source-manifest.json')

    def test_stated_exact_private_file_and_directory_modes_are_enforced(self):
        for name, mode in [('runtime-image.tar', 0o700), ('runtime-image.tar', 0o400), ('directory', 0o500)]:
            with self.subTest(name=name, mode=oct(mode)), tempfile.TemporaryDirectory() as directory:
                path = Path(directory)
                catalog = self.fixture(path)
                (path if name == 'directory' else path / name).chmod(mode)
                try:
                    with self.assertRaises(ValueError):
                        with loader.open_artifacts(path, catalog):
                            pass
                finally:
                    path.chmod(0o700)

    def test_actual_origin_cannot_coerce_json_boolean_to_source_integer(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            catalog = self.fixture(path)
            malformed = copy.deepcopy(catalog['origin'])
            malformed['formatVersion'] = True
            self.publish_origin(path, catalog, malformed)
            self.assertTrue(loader.valid_catalog(catalog))
            with self.assertRaises(ValueError):
                with loader.open_artifacts(path, catalog):
                    pass

    def test_pinned_cleanup_receipt_must_match_closed_success_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            catalog = self.fixture(path)
            receipt = json.loads((path / 'preparation-cleanup.json').read_text())
            receipt['cleanup'][0]['absent'] = 1
            body = (json.dumps(receipt) + '\n').encode()
            (path / 'preparation-cleanup.json').write_bytes(body)
            catalog['origin']['artifacts']['preparation-cleanup.json'] = {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
            self.publish_origin(path, catalog)
            self.assertTrue(loader.valid_catalog(catalog))
            with self.assertRaises(ValueError):
                with loader.open_artifacts(path, catalog):
                    pass


if __name__ == '__main__':
    unittest.main()

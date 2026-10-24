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

    def test_exact_tracked_runtime_ignore_file_is_part_of_the_source_binding(self):
        binding=self.binding();binding['sources']['runtime-probe/.gitignore']=hashlib.sha256((HERE.parent/'runtime-probe/.gitignore').read_bytes()).hexdigest()
        self.assertTrue(entry.valid_binding(binding))
        for name in ('.gitignore','rendering/.gitignore','runtime-probe/.env','runtime-probe/../.gitignore'):
            altered=self.binding();altered['sources'][name]='f'*64
            self.assertFalse(entry.valid_binding(altered),name)

    def test_only_the_exact_root_dockerfile_is_an_extensionless_source_exception(self):
        for name in ('Makefile', '__init__', 'dockerfile', '../Dockerfile',
                'runtime-probe/Dockerfile', 'rendering/Dockerfile', '/Dockerfile'):
            binding = self.binding()
            binding['sources'] = dict(binding['sources'], **{name: 'f' * 64})
            self.assertFalse(entry.valid_binding(binding), name)
        binding = self.binding()
        binding['sources']['Dockerfile'] = True
        self.assertFalse(entry.valid_binding(binding))

class CompleteProducerSourceContract(unittest.TestCase):
    def test_every_selected_tracked_source_is_accepted_by_the_real_consumer(self):
        import subprocess
        producer_spec=importlib.util.spec_from_file_location('binding_source_producer',HERE/'export_images.py')
        producer=importlib.util.module_from_spec(producer_spec);producer_spec.loader.exec_module(producer)
        root=HERE.parents[2]
        paths=subprocess.check_output(['git','ls-files','--','experiments/compatibility/runtime-probe','experiments/compatibility/rendering/package.json','experiments/compatibility/rendering/bun.lock','experiments/compatibility/desktop-runtime'],cwd=root,text=True).splitlines()
        sources={}
        for relative in paths:
            name=producer.source_name(relative)
            if name is not None:
                self.assertNotIn(name,sources)
                sources[name]=hashlib.sha256((root/relative).read_bytes()).hexdigest()
        self.assertIn('runtime-probe/.gitignore',sources)
        runtime={str(Path(relative).relative_to('experiments/compatibility')) for relative in paths if Path(relative).parent==Path('experiments/compatibility/runtime-probe')}
        self.assertEqual({name for name in sources if name.startswith('runtime-probe/')},runtime)
        self.assertEqual({name for name in sources if not name.startswith('runtime-probe/')},{'Dockerfile','entry.py','export_worker.py','processes.py','guardian_guard.py','rendering/package.json','rendering/bun.lock'})
        binding=ProducerBindingFormat().binding();binding['sources']=sources
        self.assertTrue(entry.valid_binding(binding))


if __name__ == '__main__':
    unittest.main()

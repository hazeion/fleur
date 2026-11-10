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
        paths=subprocess.check_output(['git','ls-files','--','scripts/bun-floor.json','experiments/compatibility/runtime-probe','experiments/compatibility/rendering/package.json','experiments/compatibility/rendering/bun.lock','experiments/compatibility/desktop-runtime'],cwd=root,text=True).splitlines()
        sources={}
        for relative in paths:
            name=producer.source_name(relative)
            if name is not None:
                self.assertNotIn(name,sources)
                sources[name]=hashlib.sha256((root/relative).read_bytes()).hexdigest()
        self.assertIn('runtime-probe/.gitignore',sources)
        runtime={str(Path(relative).relative_to('experiments/compatibility')) for relative in paths if Path(relative).parent==Path('experiments/compatibility/runtime-probe')}
        self.assertEqual({name for name in sources if name.startswith('runtime-probe/')},runtime)
        self.assertEqual({name for name in sources if not name.startswith('runtime-probe/')},{'Dockerfile','entry.py','export_worker.py','processes.py','guardian_guard.py','rendering/package.json','rendering/bun.lock','bun-floor.json'})
        binding=ProducerBindingFormat().binding();binding['sources']=sources
        self.assertTrue(entry.valid_binding(binding))


class ControllerImageInputs(unittest.TestCase):
    """The Dockerfile's per-architecture inputs must match what the controller and runtime consumers execute."""
    def test_each_lane_pins_its_own_base_digest_compiler_symlink_and_compiler_hash_apple_silicon_first(self):
        import re
        profile_spec=importlib.util.spec_from_file_location('binding_runtime_profile',HERE.parent/'runtime-probe/runtime_profile.py')
        profiles=importlib.util.module_from_spec(profile_spec);profile_spec.loader.exec_module(profiles)
        dockerfile=(HERE/'Dockerfile').read_text();native=(HERE.parents[2]/'src/runtime/native/build.ts').read_text()
        bases=re.findall(r'^FROM ubuntu@sha256:([a-f0-9]{64}) AS base-(arm64|amd64)$',dockerfile,re.M)
        compilers=re.findall(r'^\s*(arm64|amd64)\) triplet=([a-z0-9_-]+); pin=([a-f0-9]{64}) ;;',dockerfile,re.M)
        self.assertEqual([lane for _,lane in bases],['arm64','amd64']);self.assertEqual([lane for lane,_,_ in compilers],['arm64','amd64'])
        self.assertEqual(len({digest for digest,_ in bases}),2)
        controllers=dict(re.findall(r'^\s*(arm64|x64): \{ controller: "ubuntu@sha256:([a-f0-9]{64})"',native,re.M))
        self.assertEqual(dict((lane,digest) for digest,lane in bases),{'arm64':controllers['arm64'],'amd64':controllers['x64']})
        for lane,triplet,pin in compilers:
            self.assertEqual(triplet,profiles.PROFILES[lane]['compiler_target'],lane)
            self.assertEqual(pin,entry.COMPILERS[lane],lane);self.assertEqual(pin,profiles.PROFILES[lane]['compiler_sha256'],lane)
        self.assertIn('FROM base-${TARGETARCH}',dockerfile);self.assertRegex(dockerfile,r'(?m)^\s*\*\) .*exit 1 ;;')
        self.assertEqual(dockerfile.count('gcc-13=13.3.0-6ubuntu2~24.04.1'),1)
        self.assertIn('echo "$pin  /usr/local/bin/gcc" | sha256sum --check',dockerfile)


if __name__ == '__main__':
    unittest.main()

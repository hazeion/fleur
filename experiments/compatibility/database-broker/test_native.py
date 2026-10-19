import unittest
from native import attach_host_threads


class ThreadEvidenceTests(unittest.TestCase):
    def test_worker_cannot_replace_the_hosts_actual_observation(self):
        with self.assertRaisesRegex(RuntimeError, 'Worker cannot supply'):
            attach_host_threads({'host_threads': ['forged']}, ['host-observed'])

    def test_missing_host_measurement_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'did not complete'):
            attach_host_threads({'kind': 'runtime-evidence'}, None)

    def test_driver_attaches_only_the_separately_collected_host_measurement(self):
        worker = {'kind': 'runtime-evidence'}
        observed = [{'pid': 1, 'no_new_privs': 1, 'seccomp': 2, 'seccomp_filters': 1}]
        result = attach_host_threads(worker, observed)
        self.assertEqual(result['host_threads'], observed)
        self.assertNotIn('host_threads', worker)


class WorkerSourceStagingTests(unittest.TestCase):
    def test_database_worker_stages_and_hashes_shared_gc_probe_with_same_bootstrap(self):
        import hashlib,tempfile
        from pathlib import Path
        from native import stage_worker_sources
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';target=root/'target';source.mkdir();target.mkdir()
            (source/'bootstrap.ts').write_text("import {verifyRetainedHeap} from './heap_probe';\n")
            (source/'application.js').write_text('registeredDatabaseOperation();\n')
            (source/'heap_probe.ts').write_text('export function verifyRetainedHeap() { throw new Error("not a fixture attestation"); }\n')
            facts=stage_worker_sources(source,target)
            self.assertEqual(set(facts),{'bootstrap.ts','application.js','heap_probe.ts'})
            for name in facts:
                self.assertEqual((target/name).read_bytes(),(source/name).read_bytes())
                self.assertEqual(facts[name],hashlib.sha256((source/name).read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()

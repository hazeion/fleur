import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
spec=importlib.util.spec_from_file_location('desktop_export',Path(__file__).with_name('export_images.py'))
producer=importlib.util.module_from_spec(spec);spec.loader.exec_module(producer)

class ProducerIdentityTests(unittest.TestCase):
    def test_container_and_image_with_same_name_have_independent_absence(self):
        name='fleur-desktop-preparation-a1234567-1234-4234-8234-123456789abc'
        def daemon(args,**kwargs):
            if '--type' in args and args[args.index('--type')+1]=='container':return SimpleNamespace(returncode=1,stdout='\n',stderr='Error: No such container: '+name+'\n')
            return SimpleNamespace(returncode=0,stdout='{"Id":"sha256:remaining-image"}',stderr='')
        self.assertIsNone(producer.inspect_preparation('container',name,daemon))
        self.assertEqual(producer.inspect_preparation('image',name,daemon),{'Id':'sha256:remaining-image'})
    def test_wrong_target_or_unknown_transport_is_not_absence(self):
        name='fleur-desktop-preparation-a1234567-1234-4234-8234-123456789abc'
        for result in (SimpleNamespace(returncode=1,stdout='\n',stderr='Error: No such container: foreign\n'),SimpleNamespace(returncode=124,stdout='',stderr=''),SimpleNamespace(returncode=1,stdout='extra\n',stderr='Error: No such container: '+name+'\n')):
            with self.assertRaises(RuntimeError):producer.inspect_preparation('container',name,lambda *args,**kwargs:result)

class ExplicitImageReferenceTests(unittest.TestCase):
    def test_actual_daemon_latest_diagnostic_stays_bound_to_the_requested_image(self):
        nonce='a1234567-1234-4234-8234-123456789abc'
        container,image=producer.preparation_names(nonce)
        def daemon(args,**kwargs):
            target=args[args.index('--type')+2]
            canonical=target if ':' in target else target+':latest'
            return SimpleNamespace(returncode=1,stdout='\n',stderr='Error response from daemon: No such image: '+canonical+'\n')
        self.assertIsNone(producer.inspect_preparation('image',image,daemon))
        self.assertEqual(image,container+':latest')

class NativeLaneTests(unittest.TestCase):
    def test_preparation_lane_is_derived_from_the_native_runner_apple_silicon_first(self):
        self.assertEqual(producer.native_architecture('Linux','aarch64'),'arm64')
        self.assertEqual(producer.native_architecture('Linux','x86_64'),'amd64')
    def test_foreign_or_translated_runners_refuse_before_any_build(self):
        for system,machine in (('Darwin','arm64'),('Darwin','x86_64'),('Linux','arm64'),('Linux','armv7l'),('Linux','i686'),('Linux',''),('Windows','AMD64'),('Linux',None)):
            with self.assertRaises(RuntimeError,msg=(system,machine)):producer.native_architecture(system,machine)
    def test_built_controller_image_must_carry_the_lane_architecture_before_any_export(self):
        import json
        for architecture,foreign in (('arm64','amd64'),('amd64','arm64')):
            calls=[]
            def daemon(args,value):calls.append(args);return (json.dumps(value)+'\n').encode()
            good={'Id':'sha256:'+'a'*64,'Os':'linux','Architecture':architecture}
            self.assertEqual(producer.built_image('fleur-desktop-preparation-x:latest',architecture,lambda args:daemon(args,good)),'sha256:'+'a'*64)
            self.assertEqual(calls,[['docker','image','inspect','fleur-desktop-preparation-x:latest','--format','{{json .}}']])
            for changed in ({**good,'Architecture':foreign},{**good,'Os':'windows'},{**good,'Architecture':None},{'Id':good['Id'],'Architecture':architecture},{**good,'Id':'a'*64},[good]):
                with self.assertRaises(RuntimeError,msg=(architecture,changed)):producer.built_image('fleur-desktop-preparation-x:latest',architecture,lambda args:daemon(args,changed))

class PreparationOutputTests(unittest.TestCase):
    """The producer's outputs for each lane, with git and Docker replaced by recorders."""
    def prepare(self,machine,output):
        import json,os,sys,tempfile
        from unittest.mock import patch
        consumer_spec=importlib.util.spec_from_file_location('desktop_export_consumer',Path(__file__).with_name('artifact_inputs.py'))
        consumer=importlib.util.module_from_spec(consumer_spec);sys.modules[consumer_spec.name]=consumer;consumer_spec.loader.exec_module(consumer)
        commit='d'*40;calls=[];baked={}
        tracked=['experiments/compatibility/desktop-runtime/Dockerfile','experiments/compatibility/desktop-runtime/entry.py','experiments/compatibility/runtime-probe/run.py']
        def run(args,**kwargs):
            calls.append(list(args));out=b''
            if args[:2]==['git','rev-parse']:out=(commit+'\n').encode()
            elif args[:2]==['git','ls-tree']:out=('\n'.join(tracked)+'\n').encode()
            elif args[:2]==['git','show']:out=(producer.ROOT/args[2].split(':',1)[1]).read_bytes()
            elif args[:2]==['docker','build']:baked.update(json.loads((Path(args[-1])/'controller/source-manifest.json').read_text()))
            elif args[:3]==['docker','image','inspect']:out=(json.dumps({'Id':'sha256:'+'1'*64,'Os':'linux','Architecture':producer.MACHINES[machine]})+'\n').encode()
            elif args[:2]==['docker','run']:
                mounted=Path(args[args.index('--volume',args.index('--volume')+1)+1].split(':')[0])
                for name in ('runtime-image.tar','runtime-preparation.json','controller-packages.tsv','controller-tools.json'):(mounted/name).write_bytes(b'worker output\n')
            elif args[:3]==['docker','image','save']:Path(args[args.index('--output')+1]).write_bytes(b'controller archive\n')
            return SimpleNamespace(returncode=0,stdout=out,stderr=b'')
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted'}),patch.object(producer.platform,'system',lambda:'Linux'),patch.object(producer.platform,'machine',lambda:machine),patch.object(producer.subprocess,'run',run),patch.object(producer,'inspect_preparation',lambda kind,target:None):
            producer.main(output)
        return commit,calls,baked,consumer
    def test_each_lane_records_its_architecture_without_widening_the_baked_manifest_or_the_origin(self):
        import json,tempfile
        for machine,architecture in (('aarch64','arm64'),('x86_64','amd64')):
            with tempfile.TemporaryDirectory() as directory:
                output=Path(directory)/'images';commit,calls,baked,consumer=self.prepare(machine,output)
                build=next(args for args in calls if args[:2]==['docker','build'])
                self.assertEqual(build[2:4],['--platform','linux/'+architecture])
                self.assertEqual(set(baked),{'sourceCommit','sources'})
                manifest=json.loads((output/'source-manifest.json').read_text())
                self.assertEqual(manifest,{'architecture':architecture,'sourceCommit':commit,'sources':baked['sources']})
                self.assertEqual(set(baked['sources']),{'Dockerfile','entry.py','runtime-probe/run.py'})
                origin=json.loads((output/'image-origin.json').read_text())
                self.assertEqual((origin['controllerImageId'],origin['sourceCommit']),('sha256:'+'1'*64,commit))
                self.assertTrue(consumer.valid_entry({'producer':{'workflowRunId':1,'artifactId':1,'zipSha256':'e'*64,'imageOriginSha256':'f'*64},'origin':origin}))
                self.assertEqual(calls.index(next(args for args in calls if args[:3]==['docker','image','inspect'])),calls.index(next(args for args in calls if args[:2]==['docker','run']))-1)
    def test_a_foreign_runner_machine_refuses_before_git_or_docker_run(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):self.prepare('armv7l',Path(directory)/'images')
            self.assertFalse((Path(directory)/'images').exists())

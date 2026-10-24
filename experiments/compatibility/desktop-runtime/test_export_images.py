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

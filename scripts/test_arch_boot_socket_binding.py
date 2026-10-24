"""Independent fixed-unit closure and retained native-output requirements."""
import ast
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('review_arch_socket',Path(__file__).with_name('arch-boot-observation.py'))
observer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class SocketObservationBindingRequirements(unittest.TestCase):
    common='LoadState=not-found\nActiveState=inactive\nSubState=dead\nFragmentPath=\nDropInPaths=\nUnitFileState=\nTransient=no\n'

    def test_actual_collector_loop_binds_each_delayed_parser_to_its_fixed_unit(self):
        source=Path(observer.__file__)
        tree=ast.parse(source.read_text())
        main=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='main')
        operation=next(node for node in main.body if isinstance(node,ast.Try))
        loop=next(node for node in operation.body if isinstance(node,ast.For) and isinstance(node.target,ast.Name) and node.target.id=='unit')
        calls=[]
        def observe(name,args,parse):calls.append((name,args,parse))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[loop],type_ignores=[])),str(source),'exec'),{'observe':observe,'service_fields':observer.service_fields})
        self.assertEqual([row[0] for row in calls],['unit-docker.service','unit-docker.socket','unit-containerd.service','unit-nftables.service'])
        for name,args,parse in calls:
            unit=name.removeprefix('unit-')
            self.assertEqual(args[:3],['/usr/bin/systemctl','show',unit])
            self.assertEqual(args[3],'--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,DropInPaths,Transient,MainPID')
            if unit=='docker.socket':
                self.assertNotIn('MainPID',parse(0,self.common,''))
                with self.assertRaises(ValueError):parse(0,self.common+'MainPID=0\n','')
            else:
                with self.assertRaises(ValueError):parse(0,self.common,'')
                self.assertEqual(parse(0,self.common+'MainPID=0\n','')['MainPID'],'0')

    def test_canonical_socket_bytes_match_the_retained_native_query_digest(self):
        # b6 read-only artifact12560989065 recorded110 bytes with this digest.
        # Independent reconstruction matched it; the historical report remains
        # parseComplete=false rather than being rewritten as new execution.
        self.assertEqual(len(self.common.encode()),110)
        self.assertEqual(hashlib.sha256(self.common.encode()).hexdigest(),'150a53b30df87a361b9cc6c57eafac8c3dc31f3482820000df428b8ee63ab911')
        self.assertEqual(observer.service_fields(0,self.common,'',unit='docker.socket')['LoadState'],'not-found')


if __name__=='__main__':unittest.main()

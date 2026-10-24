"""Closed read-only Arch observation parsing requirements."""
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('arch_observation',Path(__file__).with_name('arch-boot-observation.py'))
observation=importlib.util.module_from_spec(spec)
spec.loader.exec_module(observation)

class PackageObservationRequirements(unittest.TestCase):
    def test_inventory_requires_unique_real_package_rows(self):
        self.assertEqual(observation.inventory('bash 5.3.3-1\nlinux 6.17.1.arch1-1\n'),{'bash':'5.3.3-1','linux':'6.17.1.arch1-1'})
        for text in ('','bash 1\nbash 1\n','bash 1 extra\n','bash 1\n\n','bash 1\nerror: failed\n'):
            with self.subTest(text=text),self.assertRaises(ValueError):
                observation.inventory(text)

    def test_official_pacman_version_banner_retains_both_backend_versions(self):
        text = "\n .--.                  Pacman v7.1.0 - libalpm v16.0.0\n/ _.-' .-.  .-.  .-.   Copyright (C) 2006-2025 Pacman Development Team\n"
        self.assertEqual(observation.backend_version(0,text,''),{'pacman':'7.1.0','libalpm':'16.0.0'})
        for code,out,err in [(1,text,''),(0,text,'error'),(0,text+text,''),(0,'Pacman v7.1.0 - libalpm v16.0.0\n','')]:
            with self.assertRaises(ValueError):
                observation.backend_version(code,out,err)

    def test_known_missing_requires_exact_individual_not_found_rows(self):
        names=('docker','docker-compose','containerd','runc')
        errors=''.join("error: package '"+name+"' was not found\n" for name in names)
        self.assertEqual(observation.known_packages(1,'',errors),{'installed':{},'absent':list(names)})
        self.assertEqual(observation.known_packages(1,'docker 1:29.9.0-1\n',errors.split('\n',1)[1]),{'installed':{'docker':'1:29.9.0-1'},'absent':list(names[1:])})
        for code,out,err in [(0,'',errors),(1,'',''),(1,'',errors+errors),(2,'',errors),
                             (1,'',errors.replace('not found','unavailable')),(1,'other 1\n',errors),
                             (1,'docker 1\n',errors),(0,'docker 1\n','')]:
            with self.subTest(code=code,out=out,err=err),self.assertRaises(ValueError):
                observation.known_packages(code,out,err)

class UnitObservationRequirements(unittest.TestCase):
    common = 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\nFragmentPath=\nDropInPaths=\nTransient=no\n'

    def test_socket_uses_only_properties_implemented_by_socket_units(self):
        result = observation.service_fields(0,self.common,'',unit='docker.socket')
        self.assertEqual(result['LoadState'],'not-found')
        self.assertNotIn('MainPID',result)

    def test_service_still_requires_its_main_process_property(self):
        for unit in ('docker.service','containerd.service','nftables.service'):
            with self.subTest(unit=unit):
                with self.assertRaises(ValueError):
                    observation.service_fields(0,self.common,'',unit=unit)
                self.assertEqual(observation.service_fields(0,self.common+'MainPID=0\n','',unit=unit)['MainPID'],'0')

    def test_unit_kind_does_not_relax_other_closed_properties(self):
        for unit,out in [('docker.socket',self.common+'MainPID=0\n'),('docker.socket',self.common.replace('Transient=no\n','')),('arbitrary.socket',self.common),('docker.socket',self.common+'LoadState=loaded\n')]:
            with self.subTest(unit=unit,out=out), self.assertRaises(ValueError):
                observation.service_fields(0,out,'',unit=unit)

if __name__=='__main__':
    unittest.main()

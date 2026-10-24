"""Execute the real wrapper finalization after a failed guest, without provisioning."""
import ast
import contextlib
import io
import json
from pathlib import Path
import unittest


def finalization_code(source=None):
    path=Path(__file__).with_name('qualify-debian-kvm.py')
    tree=ast.parse(path.read_text() if source is None else source)
    main=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='main')
    operation=next(node for node in main.body if isinstance(node,ast.Try))
    return compile(ast.fix_missing_locations(ast.Module(body=operation.finalbody,type_ignores=[])),str(path),'exec')


class FailedGuestFinalPreservationRequirements(unittest.TestCase):
    def observe(self,*,retired=True,package_after=None,final_packages=None,final_docker=None,failed=True,observation_error=False,baselines_known=True):
        packages={'package':'authenticated prepared baseline'} if package_after is None else package_after
        docker={'daemon':'original'}
        events=[]
        report={'ok':not failed}
        if failed:report['error']={'type':'RuntimeError','message':'Original guest failure'}
        def retire(_services):events.append('retire');return retired
        def snapshot():
            events.append('packages')
            if observation_error:raise OSError('Controlled host read refusal')
            return packages if final_packages is None else final_packages
        def daemon():events.append('docker');return docker if final_docker is None else final_docker
        namespace={'retire_services':retire,'services':[],'report':report,'interrupted':False,'package_after':packages if baselines_known else None,
            'before':docker if baselines_known else None,'package_snapshot':snapshot,'docker_snapshot':daemon,'root':None,'previous':{},'json':json}
        with contextlib.redirect_stdout(io.StringIO()) as output:exec(finalization_code(),namespace)
        self.assertEqual(json.loads(output.getvalue()),report)
        return report,events

    def test_failed_guest_still_collects_fresh_host_snapshots_after_retirement(self):
        report,events=self.observe()
        self.assertEqual(events,['retire','packages','docker'])
        self.assertFalse(report['ok'])
        self.assertEqual(report['error']['message'],'Original guest failure')
        self.assertEqual(report['hostFinalPreservation'],{'collected':True,'servicesRetired':True,
            'packageSnapshot':{'package':'authenticated prepared baseline'},'dockerSnapshot':{'daemon':'original'},
            'packagesUnchanged':True,'dockerUnchanged':True})

    def test_changed_packages_or_daemon_invalidate_an_otherwise_successful_guest(self):
        for arguments in ({'final_packages':{'changed':'package'}},{'final_docker':{'daemon':'different'}}):
            with self.subTest(arguments=arguments):
                report,events=self.observe(failed=False,**arguments)
                self.assertEqual(events,['retire','packages','docker'])
                self.assertFalse(report['ok'])
                self.assertIn('changed during guest',report['error']['message'])

    def test_unknown_snapshot_preserves_original_guest_failure_and_does_not_claim_collection(self):
        report,events=self.observe(observation_error=True)
        self.assertEqual(events,['retire','packages'])
        self.assertFalse(report['ok'])
        self.assertEqual(report['error']['message'],'Original guest failure')
        self.assertEqual(report['hostFinalPreservation'],{'collected':False,'servicesRetired':True,'errorType':'OSError'})

    def test_no_snapshot_is_taken_until_every_owned_service_is_retired(self):
        report,events=self.observe(retired=False,failed=False)
        self.assertEqual(events,['retire'])
        self.assertFalse(report['ok'])
        self.assertEqual(report['hostFinalPreservation'],{'collected':False,'servicesRetired':False})

    def test_preflight_failure_without_baselines_cannot_fabricate_preservation_evidence(self):
        report,events=self.observe(baselines_known=False)
        self.assertEqual(events,['retire'])
        self.assertFalse(report['ok'])
        self.assertNotIn('hostFinalPreservation',report)

    def test_a_changed_final_snapshot_does_not_overwrite_the_primary_guest_failure(self):
        report,_events=self.observe(final_packages={'changed':'package'})
        self.assertFalse(report['ok'])
        self.assertFalse(report['hostFinalPreservation']['packagesUnchanged'])
        self.assertEqual(report['error']['message'],'Original guest failure')


if __name__=='__main__':unittest.main()

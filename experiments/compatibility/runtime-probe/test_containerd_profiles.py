"""Reviewed hosted images must match one complete exact containerd build."""
import unittest
from configuration import audit_containerd_control

BUILDS=(('v2.4.1','f2551031d7276a770f65f98c9b52e57e7dad07e8'),
        ('v2.4.2','b7a25261e029d68978bbf290df0a62fc819b3c51'))
ARGUMENTS=['dockerd','--containerd=/run/containerd/containerd.sock']


def server(build):
    version,revision=build
    return {'Version':'28.0.4','GitCommit':'6430e49','Components':[
        {'Name':'containerd','Version':version,'Details':{'GitCommit':revision}},
        {'Name':'runc','Version':'1.5.2','Details':{'GitCommit':'v1.5.2-0-g29dd3dc2'}}]}


def cli(client,daemon):
    return f'Client:\n Version: {client[0]}\n Revision: {client[1]}\nServer:\n Version: {daemon[0]}\n Revision: {daemon[1]}\n'


class ExactContainerdProfiles(unittest.TestCase):
    def test_each_reviewed_complete_build_is_admitted_and_reported_exactly(self):
        for build in BUILDS:
            with self.subTest(version=build[0]):
                result=audit_containerd_control(ARGUMENTS,{},server(build),cli(build,build))
                self.assertEqual(result['containerd_version'],build[0][1:])
                self.assertEqual(result['containerd_commit'],build[1])
                self.assertTrue(result['ctr_revision_verified'])

    def test_mixed_version_revision_pairs_are_rejected_for_every_source(self):
        for index,build in enumerate(BUILDS):
            hybrid=(build[0],BUILDS[1-index][1])
            for component,client,daemon in ((hybrid,build,build),(build,hybrid,build),(build,build,hybrid)):
                with self.subTest(component=component,client=client,daemon=daemon),self.assertRaises(ValueError):
                    audit_containerd_control(ARGUMENTS,{},server(component),cli(client,daemon))

    def test_separately_valid_client_server_or_docker_builds_cannot_be_combined(self):
        for index,build in enumerate(BUILDS):
            other=BUILDS[1-index]
            for component,client,daemon in ((build,other,build),(build,build,other),(other,build,build)):
                with self.subTest(component=component,client=client,daemon=daemon),self.assertRaises(ValueError):
                    audit_containerd_control(ARGUMENTS,{},server(component),cli(client,daemon))

    def test_unreviewed_versions_and_changed_revisions_remain_rejected(self):
        for build in (('v2.4.3',BUILDS[1][1]),('v2.4.2','0'*40),('v2.4.1','0'*40)):
            with self.subTest(build=build),self.assertRaises(ValueError):
                audit_containerd_control(ARGUMENTS,{},server(build),cli(build,build))

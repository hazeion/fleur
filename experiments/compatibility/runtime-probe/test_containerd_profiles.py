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


class OwnedGuestCompleteProfile(unittest.TestCase):
    def test_owned_scope_matches_the_observed_complete_server_tuple(self):
        observed=server(BUILDS[1]); observed.update(Version='29.9.1',GitCommit='b26fb77')
        result=audit_containerd_control(ARGUMENTS,{},observed,cli(BUILDS[1],BUILDS[1]),host_scope='owned-guest')
        self.assertEqual((result['docker_version'],result['docker_commit']),('29.9.1','b26fb77'))
        self.assertEqual((result['containerd_version'],result['containerd_commit']),('2.4.2',BUILDS[1][1]))
        self.assertEqual((result['runc_version'],result['runc_commit']),('1.5.2','v1.5.2-0-g29dd3dc2'))

    def test_owned_tuple_never_crosses_host_scope_or_server_commit(self):
        owned=server(BUILDS[1]);owned.update(Version='29.9.1',GitCommit='b26fb77')
        client_commit={**owned,'GitCommit':'dfc520d'}
        for observed,scope in ((owned,'github-hosted'),(server(BUILDS[1]),'owned-guest'),(client_commit,'owned-guest'),(owned,'unknown'),(owned,{'docker_version':'29.9.1'})):
            with self.subTest(scope=scope),self.assertRaises(ValueError):
                audit_containerd_control(ARGUMENTS,{},observed,cli(BUILDS[1],BUILDS[1]),host_scope=scope)

    def test_owned_component_counts_and_all_ctr_sources_must_match_exact_build(self):
        import copy
        owned=server(BUILDS[1]);owned.update(Version='29.9.1',GitCommit='b26fb77')
        malformed=[]
        for name in ('containerd','runc'):
            missing=copy.deepcopy(owned);missing['Components']=[row for row in missing['Components'] if row['Name']!=name];malformed.append(missing)
            duplicate=copy.deepcopy(owned);duplicate['Components'].append(next(row for row in duplicate['Components'] if row['Name']==name));malformed.append(duplicate)
        old_component=server(BUILDS[0]);old_component.update(Version='29.9.1',GitCommit='b26fb77');malformed.append(old_component)
        wrong_runc=copy.deepcopy(owned);wrong_runc['Components'][1]['Details']['GitCommit']='wrong';malformed.append(wrong_runc)
        for observed in malformed:
            with self.subTest(observed=observed),self.assertRaises(ValueError):
                audit_containerd_control(ARGUMENTS,{},observed,cli(BUILDS[1],BUILDS[1]),host_scope='owned-guest')
        for detail in ('',cli(BUILDS[0],BUILDS[1]),cli(BUILDS[1],BUILDS[0]),cli(BUILDS[1],BUILDS[1])+'Server:\n Version: v2.4.2\n'):
            with self.subTest(detail=detail),self.assertRaises(ValueError):
                audit_containerd_control(ARGUMENTS,{},owned,detail,host_scope='owned-guest')

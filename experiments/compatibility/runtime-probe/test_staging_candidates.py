"""Read-only parent facts; eligibility never follows from a conventional name."""
import unittest


class ExistingStagingParents(unittest.TestCase):
    def test_shared_shm_is_ineligible_and_private_noexec_state_is_eligible(self):
        from staging_candidates import candidate_report
        snapshot={'filesystem':'tmpfs','propagation':'private','writable':True,
                  'executable':False,'nosuid':True,'nodev':True,'secure_owner':True,
                  'secure_mode':True,'mount_identity_verified':True,
                  'free_bytes':512*1024*1024,'free_inodes':8192,'memory_available_bytes':512*1024*1024}
        def inspect(label,path):
            return dict(snapshot,propagation='shared' if label=='shm' else 'private')
        report=candidate_report(inspector=inspect)
        records={row['candidate']:row for row in report['candidates']}
        self.assertEqual(set(records),{'runner-temp','shm','run','mnt','tmp'})
        self.assertFalse(records['shm']['exec_state_eligible'])
        self.assertEqual(records['shm']['reason'],'shared-parent')
        self.assertTrue(records['run']['exec_state_eligible'])
        self.assertFalse(records['run']['executable'])
        self.assertTrue(report['any_eligible'])
        self.assertFalse(report['allocation_attempted'])

    def test_capacity_identity_and_ownership_failures_remain_ineligible(self):
        from staging_candidates import candidate_report
        base={'filesystem':'tmpfs','propagation':'private','writable':True,'executable':True,
              'nosuid':True,'nodev':True,'secure_owner':True,'secure_mode':True,
              'mount_identity_verified':True,'free_bytes':512*1024*1024,'free_inodes':8192,'memory_available_bytes':512*1024*1024}
        for changed,reason in (({'free_bytes':1},'insufficient-capacity'),
                               ({'free_inodes':1},'insufficient-inodes'),
                               ({'mount_identity_verified':False},'mount-unverified'),
                               ({'secure_owner':False},'unsafe-ownership'),
                               ({'propagation':'slave'},'slave-parent')):
            with self.subTest(changed=changed):
                report=candidate_report(inspector=lambda *_:dict(base,**changed))
                self.assertFalse(report['any_eligible'])
                self.assertTrue(all(row['reason']==reason for row in report['candidates']))
                self.assertTrue(all(row['status']=='observed' for row in report['candidates']))

    def test_extra_or_malformed_inspection_details_never_leak(self):
        import json
        from staging_candidates import candidate_report
        base={'filesystem':'tmpfs','propagation':'shared','writable':True,'executable':False,
              'nosuid':True,'nodev':True,'secure_owner':True,'secure_mode':True,
              'mount_identity_verified':True,'free_bytes':512*1024*1024,'free_inodes':8192,'memory_available_bytes':512*1024*1024,
              'private_path':'/private/secret-path','user_name':'private-user'}
        report=candidate_report(inspector=lambda *_:base)
        self.assertFalse(report['any_eligible'])
        self.assertNotIn('secret-path',json.dumps(report));self.assertNotIn('private-user',json.dumps(report))
        malformed=candidate_report(inspector=lambda *_:dict(base,free_bytes=True))
        self.assertFalse(malformed['any_eligible'])
        self.assertTrue(all(row['reason']=='unverified' for row in malformed['candidates']))
        self.assertLess(len(json.dumps(report)),8192)

    def test_tmpfs_capacity_without_memory_headroom_is_not_eligible(self):
        from staging_candidates import candidate_report
        snapshot={'filesystem':'tmpfs','propagation':'private','writable':True,'executable':False,
                  'nosuid':True,'nodev':True,'secure_owner':True,'secure_mode':True,
                  'mount_identity_verified':True,'free_bytes':512*1024*1024,'free_inodes':8192,
                  'memory_available_bytes':1024}
        report=candidate_report(inspector=lambda *_:snapshot)
        self.assertFalse(report['any_eligible'])
        self.assertTrue(all(row['reason']=='insufficient-memory' for row in report['candidates']))

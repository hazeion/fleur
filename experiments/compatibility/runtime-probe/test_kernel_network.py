"""Host-helper transport tests; simulated kernel data is not native Linux proof."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from kernel_network import inspect_kernel_profile, KernelProfileUnverified, HELPER, valid_kernel_profile

CID = "a" * 64

class KernelProfileTests(unittest.TestCase):
    def profile(self, changes=None, *, adapter_extra="", timeout=3, peer=None):
        directory=tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root=pathlib.Path(directory.name)
        cg="/system.slice/docker-"+CID+".scope"
        rows={
            "/proc/42/cgroup":"0::"+cg+"\n",
            "/proc/42/stat":"42 (worker) S "+"0 "*18+"100 0\n",
            "/proc/42/status":"Uid:\t65534\t65534\t65534\t65534\nGid:\t65534\t65534\t65534\t65534\nCapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapBnd:\t0000000000000000\nNoNewPrivs:\t1\n",
            "/proc/42/mountinfo":"21 1 0:4 / / ro,relatime - overlay overlay rw\n",
            "/proc/self/mountinfo":"22 1 0:9 / /sys/fs/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup rw\n",
            "/proc/42/net/dev":"Inter-|   Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n lo: "+"0 "*16+"\n",
            "/proc/42/net/route":"Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n",
            "/proc/42/net/ipv6_route":"0"*32+" 00 "+"0"*32+" 00 "+"0"*32+" ffffffff 00000001 00000000 00200200 lo\n",
            "/sys/fs/cgroup"+cg+"/memory.max":"536870912\n",
            "/sys/fs/cgroup"+cg+"/memory.swap.max":"0\n",
            "/sys/fs/cgroup"+cg+"/pids.max":"64\n",
            "/sys/fs/cgroup"+cg+"/cpu.max":"100000 100000\n",
        }
        rows.update(changes or {})
        for name, content in rows.items():
            path=root/name.lstrip("/");path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(content)
        for name in ("proc/self/ns/net","proc/42/ns/net","proc/43/ns/net"):
            path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.touch()
        adapter="""import os,select
original_open=os.open
original_stat=os.stat
ROOT=ROOT_VALUE
def mapped_open(path,*args,**kwargs):
    if path=='/proc/'+str(os.getpid()): path='/proc/self'
    elif path=='/proc/self' and args and args[0]&os.O_NOFOLLOW: raise OSError('proc self is a symlink')
    if isinstance(path,str) and path.startswith(('/proc/','/sys/fs/cgroup')): path=ROOT+path
    return original_open(path,*args,**kwargs)
def mapped_stat(path,*args,**kwargs):
    if isinstance(path,str) and path.startswith('/proc/'): path=ROOT+path
    return original_stat(path,*args,**kwargs)
os.open=mapped_open
os.stat=mapped_stat
os.geteuid=lambda:0
pidfd,writer=os.pipe()
os.pidfd_open=lambda pid,flags=0:os.dup(pidfd)
""".replace("ROOT_VALUE",repr(str(root)))+adapter_extra
        original_popen=subprocess.Popen
        def launch(args, **kwargs):
            self.assertEqual(args[:5],["/usr/bin/sudo","-n","/usr/bin/env","-i","PATH=/usr/bin:/bin"])
            self.assertIn("--kill-after=0.2s",args)
            self.assertIn("/usr/bin/python3",args)
            return original_popen([sys.executable,"-I","-u","-c",adapter+HELPER],**kwargs)
        with patch("kernel_network.subprocess.Popen",side_effect=launch):
            return inspect_kernel_profile(CID,42,timeout,peer=peer)

    def test_peer_identity_and_distinct_namespace_are_required(self):
        peer={'container_id':'b'*64,'pid':43}
        rows={'/proc/43/cgroup':'0::/system.slice/docker-'+'b'*64+'.scope\n',
              '/proc/43/stat':'43 (peer) S '+'0 '*18+'101 0\n'}
        self.assertTrue(valid_kernel_profile(self.profile(rows,peer=peer)))
        extra="""def reused_namespace_stat(path,*args,**kwargs):
    if path=='ns/net' and original_stat(kwargs.get('dir_fd')).st_ino==original_stat(ROOT+'/proc/43').st_ino:
        return original_stat(ROOT+'/proc/42/ns/net')
    return mapped_stat(path,*args,**kwargs)
os.stat=reused_namespace_stat
"""
        # Compare via the opened directory descriptor, as the real helper does.
        extra=extra.replace("original_stat(kwargs.get('dir_fd'))","os.fstat(kwargs.get('dir_fd'))")
        with self.assertRaises(KernelProfileUnverified):self.profile(rows,peer=peer,adapter_extra=extra)
        rows['/proc/43/cgroup']='0::/unrelated\n'
        with self.assertRaises(KernelProfileUnverified):self.profile(rows,peer=peer)

    def test_kernel_evidence_verifies_profile_and_separate_loopback_namespace(self):
        proof=self.profile()
        self.assertEqual(proof,{"kernel_network_isolated":True,"loopback_only":True,"external_routes":0,
            "profile_verified":True,"read_only_root":True,"unprivileged":True,"cgroup_verified":True,
            "process_identity_verified":True,"memory_max":536870912,"memory_swap_max":0,"pids_max":64,"cpu_count":1})
        self.assertNotIn(CID,json.dumps(proof))

    def test_only_complete_typed_kernel_proof_is_valid(self):
        proof=self.profile()
        self.assertTrue(valid_kernel_profile(proof))
        for key in proof:
            changed=dict(proof);changed.pop(key)
            self.assertFalse(valid_kernel_profile(changed))
            changed=dict(proof);changed[key]=int(proof[key]) if type(proof[key]) is bool else str(proof[key])
            self.assertFalse(valid_kernel_profile(changed))
        self.assertFalse(valid_kernel_profile({**proof,"pid":42}))
        self.assertFalse(valid_kernel_profile(None))

    def test_cgroup_requires_exact_identity_before_other_process_reads(self):
        for row in ["0::/system.slice/docker-"+CID+"f.scope\n", "0::/../"+CID+"\n", "0::/unrelated\n", "1:memory:/"+CID+"\n"]:
            with self.subTest(row=row),self.assertRaises(KernelProfileUnverified):
                self.profile({"/proc/42/cgroup":row},adapter_extra="""def forbidden_other_reads(path,*args,**kwargs):
    if path in ('status','stat','net/dev','mountinfo'): raise AssertionError('read before identity')
    return mapped_open(path,*args,**kwargs)
os.open=forbidden_other_reads
""")

    def test_excess_resource_limits_are_rejected(self):
        path="/sys/fs/cgroup/system.slice/docker-"+CID+".scope/"
        for name,value in [('memory.max','max'),('memory.max','1073741824'),('memory.swap.max','536870912'),
                           ('pids.max','65'),('cpu.max','200000 100000'),('cpu.max','max 100000')]:
            with self.subTest(name=name,value=value),self.assertRaises(KernelProfileUnverified):
                self.profile({path+name:value+"\n"})

    def test_unrestricted_process_or_writable_root_is_rejected(self):
        valid="Uid: 65534 65534 65534 65534\nGid: 65534 65534 65534 65534\nCapEff: 0000000000000000\nCapPrm: 0000000000000000\nCapBnd: 0000000000000000\nNoNewPrivs: 1\n"
        for original,replacement in [('Uid: 65534','Uid: 0'),('Gid: 65534','Gid: 0'),('CapEff: 0000000000000000','CapEff: 0000000000000001'),
            ('CapPrm: 0000000000000000','CapPrm: 0000000000000001'),('CapBnd: 0000000000000000','CapBnd: 0000000000000001'),('NoNewPrivs: 1','NoNewPrivs: 0')]:
            with self.subTest(field=original),self.assertRaises(KernelProfileUnverified):
                self.profile({"/proc/42/status":valid.replace(original,replacement)})
        with self.assertRaises(KernelProfileUnverified):
            self.profile({"/proc/42/mountinfo":"21 1 0:4 / / rw,relatime - overlay overlay rw\n"})

    def test_host_namespace_or_external_interface_is_rejected(self):
        with self.assertRaises(KernelProfileUnverified):
            self.profile(adapter_extra="""def host_namespace_stat(path,*args,**kwargs):
    if path=='ns/net': return original_stat(ROOT+'/proc/self/ns/net')
    return mapped_stat(path,*args,**kwargs)
os.stat=host_namespace_stat
""")
        with self.assertRaises(KernelProfileUnverified):
            self.profile({"/proc/42/net/dev":"Inter-| Receive | Transmit\n face |bytes\n lo: "+"0 "*16+"\n eth0: "+"0 "*16+"\n"})

    def test_external_ipv4_and_ipv6_routes_are_rejected(self):
        ipv4="Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n"
        for row in ["lo 00000000 00000000 0001 0 0 0 00000000 0 0 0\n", "lo 0000007F 0100000A 0003 0 0 0 000000FF 0 0 0\n"]:
            with self.subTest(row=row),self.assertRaises(KernelProfileUnverified):
                self.profile({"/proc/42/net/route":ipv4+row})
        external="20010db8000000000000000000000000 40 "+"0"*32+" 00 "+"0"*32+" 00000000 00000000 00000000 00000001 lo\n"
        with self.assertRaises(KernelProfileUnverified): self.profile({"/proc/42/net/ipv6_route":external})

    def test_exit_during_evidence_read_is_rejected_by_pidfd(self):
        with self.assertRaises(KernelProfileUnverified):
            self.profile(adapter_extra="""def exit_on_status(path,*args,**kwargs):
    global writer
    if path=='status' and writer is not None: os.close(writer);writer=None
    return mapped_open(path,*args,**kwargs)
os.open=exit_on_status
""")

    def test_changed_starttime_or_cgroup_is_rejected(self):
        for name,replacement in [('stat',"42 (worker) S "+"0 "*18+"200 0\n"),('cgroup','0::/unrelated\n')]:
            extra="""reads=0
def mutate_on_second_read(path,*args,**kwargs):
    global reads
    if path==NAME:
        reads+=1
        if reads==2:
            with open(ROOT+'/proc/42/'+NAME,'w') as stream: stream.write(REPLACEMENT)
    return mapped_open(path,*args,**kwargs)
os.open=mutate_on_second_read
""".replace('NAME',repr(name)).replace('REPLACEMENT',repr(replacement))
            with self.subTest(name=name),self.assertRaises(KernelProfileUnverified): self.profile(adapter_extra=extra)

    def test_limits_changed_while_inspecting_are_rejected(self):
        extra="""def change_limits_on_status(path,*args,**kwargs):
    if path=='status':
        with open(ROOT+'/sys/fs/cgroup/system.slice/docker-'+CID_VALUE+'.scope/memory.max','w') as stream: stream.write('max\\n')
    return mapped_open(path,*args,**kwargs)
os.open=change_limits_on_status
""".replace('CID_VALUE',repr(CID))
        with self.assertRaises(KernelProfileUnverified): self.profile(adapter_extra=extra)

    def test_helper_output_is_bounded_and_never_included_in_errors(self):
        original_popen=subprocess.Popen
        for stream,bound in [('stdout',2048),('stderr',1024)]:
            source='import sys;sys.stdin.buffer.read();sys.'+stream+'.write("private-host-path"*'+str(bound)+');sys.'+stream+'.flush()'
            with self.subTest(stream=stream),patch('kernel_network.subprocess.Popen',side_effect=lambda args,**kwargs:original_popen([sys.executable,'-I','-u','-c',source],**kwargs)):
                with self.assertRaisesRegex(KernelProfileUnverified,'^kernel-profile-output-bound$') as caught:
                    inspect_kernel_profile(CID,42,1)
                self.assertNotIn('private-host-path',str(caught.exception))

    def test_hanging_helper_is_bounded_and_reaped(self):
        original_popen=subprocess.Popen;children=[]
        def launch(args,**kwargs):
            process=original_popen([sys.executable,'-I','-u','-c','import time;time.sleep(30)'],**kwargs)
            children.append(process);return process
        started=time.monotonic()
        with patch('kernel_network.subprocess.Popen',side_effect=launch),self.assertRaises(KernelProfileUnverified):
            inspect_kernel_profile(CID,42,.6)
        self.assertLess(time.monotonic()-started,1.2)
        self.assertIsNotNone(children[0].poll())

    def test_malformed_or_incomplete_helper_result_is_rejected(self):
        original_popen=subprocess.Popen
        for result in ['{}','[]','{"profile_verified":true}','not-json']:
            source='import sys;sys.stdin.buffer.read();print('+repr(result)+')'
            with self.subTest(result=result),patch('kernel_network.subprocess.Popen',side_effect=lambda args,**kwargs:original_popen([sys.executable,'-I','-u','-c',source],**kwargs)),self.assertRaises(KernelProfileUnverified):
                inspect_kernel_profile(CID,42,1)

    def test_invalid_identity_is_rejected_before_privileged_execution(self):
        for cid, pid in [("a" * 63, 42), ("../host", 42), (CID, 0), (CID, True), (CID, "42")]:
            with self.subTest(cid=cid, pid=pid), patch("kernel_network.subprocess.Popen") as launch:
                with self.assertRaises(KernelProfileUnverified):
                    inspect_kernel_profile(cid, pid)
                launch.assert_not_called()

if __name__ == "__main__":
    unittest.main()

class PeerRequestValidation(unittest.TestCase):
    def test_malformed_peer_is_refused_before_privileged_execution(self):
        for peer in ('unbounded',{'container_id':'b'*64,'pid':True},
                     {'container_id':'b'*64,'pid':43,'unbounded':'x'*100000},
                     {'container_id':CID,'pid':43}):
            with self.subTest(peer_type=type(peer).__name__),patch('kernel_network.subprocess.Popen',side_effect=AssertionError('privileged helper started')):
                with self.assertRaises(KernelProfileUnverified):inspect_kernel_profile(CID,42,peer=peer)

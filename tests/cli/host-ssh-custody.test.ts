import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const nonce = "12345678-1234-1234-1234-123456789abc";

test("completed boot SSH never authorizes a destructive signal after its leader was reaped", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-boot-ssh-custody-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.exit(75);\n`, { mode: 0o700 });
    // External OS signaling seam. Never deliver a destructive signal to a
    // group whose original leader has already disappeared.
    await writeFile(join(root, "signals.ts"), `import {appendFileSync} from 'node:fs';const original=process.kill.bind(process);process.kill=((pid,signal)=>{if(pid<0&&signal!==0){let gone=false;try{original(-pid,0);}catch(error){gone=error.code==='ESRCH';}if(gone){appendFileSync(process.env.FIXTURE_ROOT+'/unsafe-signals',JSON.stringify({signal,leaderGone:true})+'\\n');return true;}}return original(pid,signal);});\n`);
    const child = Bun.spawn([process.execPath, "--preload", join(root, "signals.ts"), resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(3);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "pending" });
    expect(await Bun.file(join(root, "unsafe-signals")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

test("completed workflow SSH never authorizes a destructive signal after its leader was reaped", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-ssh-custody-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.stdout.write('FLEUR_SESSION_READY=12345678-1234-1234-1234-123456789abc\\n{}');process.exit(4);\n`, { mode: 0o700 });
    // External OS signaling seam. Never deliver a destructive signal to a
    // group whose original leader has already disappeared.
    await writeFile(join(root, "signals.ts"), `import {appendFileSync} from 'node:fs';const original=process.kill.bind(process);process.kill=((pid,signal)=>{if(pid<0&&signal!==0){let gone=false;try{original(-pid,0);}catch(error){gone=error.code==='ESRCH';}if(gone){appendFileSync(process.env.FIXTURE_ROOT+'/unsafe-signals',JSON.stringify({signal,leaderGone:true})+'\\n');return true;}}return original(pid,signal);});\n`);
    const child = Bun.spawn([process.execPath, "--preload", join(root, "signals.ts"), resolve(import.meta.dir, "../../scripts/observe-fresh-linux-session.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "SESSION_FAILED" } });
    expect(await Bun.file(join(root, "unsafe-signals")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);


test("system Python retains an exited SSH leader until its pipe-holding descendant is refused and retired", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-ssh-pipeholder-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); expect(python).not.toBeNull();
    const pending = { formatVersion: 1, ok: false, phase: "new-login-required", runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline: {}, checkpoint: { sha256: "b".repeat(64), bytes: 800 }, accessHandoff: { after: { user: { name: "fleur", uid: 1000 }, group: { gid: 997 }, accountGroups: [997, 1000], sessionGroups: [1000] } } };
    const response = "FLEUR_SESSION_READY=" + nonce + "\n" + JSON.stringify(pending);
    await writeFile(join(tools, "ssh"), `#!${python}\nimport os,pathlib,time\nroot=pathlib.Path(os.environ['FIXTURE_ROOT'])\npid=os.fork()\nif pid==0:\n time.sleep(10);os._exit(0)\n(root/'leader').write_text(str(os.getpid()))\n(root/'survivor').write_text(str(pid))\nos.write(1,${JSON.stringify(response)}.encode())\nos._exit(3)\n`, { mode: 0o700 });
    await writeFile(join(root, "signals.ts"), `import {appendFileSync} from 'node:fs';const original=process.kill.bind(process);process.kill=((pid,signal)=>{if(pid<0&&signal!==0){let gone=false;try{original(-pid,0);}catch(error){gone=error.code==='ESRCH';}appendFileSync(process.env.FIXTURE_ROOT+'/signals',JSON.stringify({signal,leaderGone:gone})+'\\n');if(gone)return true;}return original(pid,signal);});\n`);
    const child = Bun.spawn([process.execPath, "--preload", join(root, "signals.ts"), resolve(import.meta.dir, "../../scripts/observe-fresh-linux-session.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining("surviving owned SSH process group") } });
    const signals = (await Bun.file(join(root, "signals")).text()).trim().split("\n").map((line) => JSON.parse(line) as { leaderGone: boolean });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.leaderGone === false)).toBe(true);
    const leader = Number(await Bun.file(join(root, "leader")).text());
    const survivor = Number(await Bun.file(join(root, "survivor")).text());
    expect(() => process.kill(leader, 0)).toThrow();
    expect(() => process.kill(survivor, 0)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);


async function stalledBootRetirement(mode: "denied" | "accepted") {
  const root = await mkdtemp(join(tmpdir(), "fleur-boot-" + mode + "-retirement-"));
  let driver: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    // A real launch receipt precedes Bun startup; exec preserves that SSH PID.
    // The finite stall outlasts the 4s work and unchanged 3s cleanup allowances.
    await writeFile(join(tools, "ssh"), `#!/bin/sh\nprintf '{"pid":%s,"ppid":%s}\\n' "$$" "$PPID" > "$FIXTURE_ROOT/ssh-started"\nexec ${quote(process.execPath)} --eval 'setTimeout(()=>process.exit(0),12000)'\n`, { mode: 0o700 });
    const entry = `
import {mock} from 'bun:test';
import * as actual from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
const originalSpawn=actual.spawn;const relays=[];
mock.module('node:child_process',()=>({...actual,spawn:function(...args){
 const child=originalSpawn.apply(this,args);
 if(args[0]==='python3'&&args[1]?.[1]===${JSON.stringify(resolve(import.meta.dir, "../../scripts/retained-ssh.py"))}){
  const receipt={pid:child.pid,closed:false,code:null,signal:null};
  writeFileSync(process.env.FIXTURE_ROOT+'/relay-started',JSON.stringify(receipt));
  const ended=new Promise(resolve=>child.once('close',(code,signal)=>{Object.assign(receipt,{closed:true,code,signal});writeFileSync(process.env.FIXTURE_ROOT+'/relay-closed',JSON.stringify(receipt));resolve();}));
  relays.push({child,receipt,ended});
 }
 return child;
}}));
const originalKill=process.kill.bind(process);
process.kill=((pid,signal)=>{
 if(pid<0&&signal!==0){
  appendFileSync(process.env.FIXTURE_ROOT+'/signals',JSON.stringify({pid,signal,mode:${JSON.stringify(mode)}})+'\\n');
  ${mode === "denied" ? "throw Object.assign(new Error('Owned fixture EPERM'),{code:'EPERM'});" : "return true;"}
 }
 return originalKill(pid,signal);
});
const {observeBoot}=await import(${JSON.stringify(resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"))});
const started=performance.now();
try {
 const observed=await observeBoot(${JSON.stringify({ port: 2222, identity: join(root, "key"), knownHosts: join(root, "hosts"), nonce })},4000);
 console.log(JSON.stringify({kind:'public',observed,elapsedMs:performance.now()-started}));
} finally {
 // Real EOF reaches the real Python fallback, which retains and reaps SSH.
 // Fixture recovery cannot change the already-recorded public cleanup result.
 for(const relay of relays)relay.child.stdin?.end();
 let timer;
 try{await Promise.race([Promise.all(relays.map(relay=>relay.ended)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture relay recovery is unconfirmed')),2000);})]);}
 finally{clearTimeout(timer);}
 console.log(JSON.stringify({kind:'recovery',relays:relays.map(relay=>relay.receipt)}));
}
`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    driver = child;
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Retain the real public result before consulting startup/signal markers.
    console.info(stdout); if (stderr) console.error(stderr);
    expect(exit, stderr + stdout).toBe(0);
    const [publicReceipt, recovery] = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(publicReceipt.kind).toBe("public");
    expect(publicReceipt.observed).toMatchObject({ ok: false, state: "failed", error: { code: "BOOT_OBSERVATION_FAILED", message: expect.stringContaining("cleanup is unconfirmed") }, transport: { timeoutMs: 4000, deadlineFired: true, terminationRequested: true, cleanupConfirmed: false, stdoutBytes: 0, stderrBytes: 0 } });
    expect(publicReceipt.elapsedMs).toBeGreaterThanOrEqual(4000);
    expect(publicReceipt.elapsedMs).toBeLessThan(8000);
    const launch = JSON.parse(await Bun.file(join(root, "ssh-started")).text());
    expect(launch.pid).toBeGreaterThan(0);
    const signals = (await Bun.file(join(root, "signals")).text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(signals.map((signal) => signal.signal)).toContain("SIGTERM");
    expect(signals.map((signal) => signal.signal)).toContain("SIGKILL");
    expect(signals.every((signal) => signal.pid === -launch.pid && signal.mode === mode)).toBe(true);
    expect(recovery).toMatchObject({ kind: "recovery", relays: [{ pid: launch.ppid, closed: true, code: 0, signal: null }] });
  } finally {
    // Even if assertions or the driver fail, observe real fallback retirement
    // before deleting fixture files. No stale numeric PID receives a signal.
    if (driver) await driver.exited;
    const paths = ["relay-started", "ssh-started"];
    const pids: number[] = [];
    for (const name of paths) if (await Bun.file(join(root, name)).exists()) pids.push(JSON.parse(await Bun.file(join(root, name)).text()).pid);
    const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } };
    const end = performance.now() + 2000;
    while (pids.some((pid) => !gone(pid)) && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pids.every(gone), "Owned fixture processes must actually retire before removal").toBe(true);
    await rm(root, { recursive: true, force: true });
  }
}

test("boot returns bounded incomplete cleanup when its stalled owned SSH group refuses host signals", async () => {
  await stalledBootRetirement("denied");
}, 14000);

test("boot returns bounded incomplete cleanup when accepted host signals do not retire its SSH group", async () => {
  await stalledBootRetirement("accepted");
}, 14000);


test("unknown state in a different process group cannot invalidate the retained SSH group", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-foreign-ps-state-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); expect(python).not.toBeNull();
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.exit(75);\n`, { mode: 0o700 });
    // External /bin/ps command boundary. The actual SSH child and waitid remain
    // real. Only the unrelated host inventory row is a synthetic OS response.
    await writeFile(join(tools, "python3"), `#!${python}\nimport subprocess,sys,runpy,pathlib,os\noriginal=subprocess.Popen\nleader=None\ndef popen(args,*positional,**kwargs):\n global leader\n if args==['/bin/ps','-axo','pid=,pgid=,stat='] or args==['/bin/ps','-x','-g',str(leader),'-o','pid=,pgid=,stat=']:\n  pathlib.Path(os.environ['FIXTURE_ROOT']+'/inventory-injection').write_text('injected')\n  rows=str(leader)+' '+str(leader)+' Z\\n'+str(leader+1)+' 1 ?E\\n'\n  return original([sys.executable,'-I','-c','import sys;sys.stdout.write('+repr(rows)+')'],*positional,**kwargs)\n child=original(args,*positional,**kwargs)\n if args[0]=='ssh':leader=child.pid\n return child\nsubprocess.Popen=popen\nrunpy.run_path(sys.argv[2],run_name='__main__')\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(3);
    expect(await Bun.file(join(root, "inventory-injection")).text()).toBe("injected");
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "pending" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

test("unknown state in the retained SSH group still refuses cleanup evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-owned-ps-state-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); expect(python).not.toBeNull();
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.exit(75);\n`, { mode: 0o700 });
    // External /bin/ps command boundary. The actual SSH child and waitid remain
    // real. The synthetic unknown-state member belongs to the retained group.
    await writeFile(join(tools, "python3"), `#!${python}\nimport subprocess,sys,runpy,pathlib,os\noriginal=subprocess.Popen\nleader=None\ndef popen(args,*positional,**kwargs):\n global leader\n if args==['/bin/ps','-axo','pid=,pgid=,stat='] or args==['/bin/ps','-x','-g',str(leader),'-o','pid=,pgid=,stat=']:\n  pathlib.Path(os.environ['FIXTURE_ROOT']+'/inventory-injection').write_text('injected')\n  rows=str(leader)+' '+str(leader)+' Z\\n'+str(leader+1)+' '+str(leader)+' ?E\\n'\n  return original([sys.executable,'-I','-c','import sys;sys.stdout.write('+repr(rows)+')'],*positional,**kwargs)\n child=original(args,*positional,**kwargs)\n if args[0]=='ssh':leader=child.pid\n return child\nsubprocess.Popen=popen\nrunpy.run_path(sys.argv[2],run_name='__main__')\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(await Bun.file(join(root, "inventory-injection")).text()).toBe("injected");
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "failed", error: { message: expect.stringContaining("inventory owned state") } });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);


test("retired pipeholding members do not receive a queued KILL while fresh inventory is delayed", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-ssh-slow-retirement-inventory-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); expect(python).not.toBeNull();
    await writeFile(join(tools, "ssh"), `#!${python}\nimport os,time\npid=os.fork()\nif pid==0:\n time.sleep(10);os._exit(0)\nos.write(1,b'FLEUR_SESSION_READY=${nonce}\\n{}')\nos._exit(4)\n`, { mode: 0o700 });
    // Delay only the external cleanup-inventory command. The first real ps
    // snapshot discovers the live descendant; TERM delivery is never replaced.
    await writeFile(join(tools, "python3"), `#!${python}\nimport subprocess,sys,runpy,time,pathlib,os\noriginal=subprocess.Popen\ncalls=0\nleader=None\ndef popen(args,*positional,**kwargs):\n global calls,leader\n if args==['/bin/ps','-axo','pid=,pgid=,stat='] or args==['/bin/ps','-x','-g',str(leader),'-o','pid=,pgid=,stat=']:\n  calls+=1\n  if calls==2:\n   pathlib.Path(os.environ['FIXTURE_ROOT']+'/slow-inventory').write_text('started')\n   time.sleep(0.25)\n child=original(args,*positional,**kwargs)\n if args[0]=='ssh':leader=child.pid\n return child\nsubprocess.Popen=popen\nrunpy.run_path(sys.argv[2],run_name='__main__')\n`, { mode: 0o700 });
    await writeFile(join(root, "signals.ts"), `import {appendFileSync} from 'node:fs';const original=process.kill.bind(process);process.kill=((pid,signal)=>{try{const result=original(pid,signal);if(pid<0&&signal!==0)appendFileSync(process.env.FIXTURE_ROOT+'/signals',JSON.stringify({signal,status:'delivered'})+'\\n');return result;}catch(error){if(pid<0&&signal!==0)appendFileSync(process.env.FIXTURE_ROOT+'/signals',JSON.stringify({signal,status:error.code})+'\\n');throw error;}});\n`);
    const child = Bun.spawn([process.execPath, "--preload", join(root, "signals.ts"), resolve(import.meta.dir, "../../scripts/observe-fresh-linux-session.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(await Bun.file(join(root, "slow-inventory")).text()).toBe("started");
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining("surviving owned SSH process group") } });
    const signals = (await Bun.file(join(root, "signals")).text()).trim().split("\n").map((line) => JSON.parse(line) as { signal: string; status: string });
    expect(signals).toEqual([{ signal: "SIGTERM", status: "delivered" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

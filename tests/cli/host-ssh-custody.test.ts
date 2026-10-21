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

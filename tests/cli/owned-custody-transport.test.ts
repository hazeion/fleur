import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function observed(mode: string, budget = 1000) {
  const root = await mkdtemp(join(tmpdir(), "fleur-custody-transport-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required for SSH protocol fixture");
    const bin = join(root, "bin"); await mkdir(bin);
    const ssh = join(bin, "ssh");
    await writeFile(ssh, `#!${python}
import os,sys,time,signal
from pathlib import Path
mode=os.environ['CUSTODY_FIXTURE_MODE'];root=Path(os.environ['CUSTODY_FIXTURE_ROOT'])
(root/'arguments').write_text('\\n'.join(sys.argv[1:]))
if mode=='stall':time.sleep(2)
if mode=='holder':
 pid=os.fork()
 if pid:os._exit(0)
 def stop(number,frame):
  (root/'holder-result').write_text('terminated');os._exit(0)
 signal.signal(signal.SIGTERM,stop)
 time.sleep(2);(root/'holder-result').write_text('expired');os._exit(0)
if mode=='overflow':
 body=b'x'*(2*1024*1024+65536)
 while body:body=body[os.write(1,body):]
else:os.write(1,b'{}\\n')
`); await chmod(ssh, 0o700);
    const script = resolve(import.meta.dir, "../../scripts/observe-owned-guest-custody.ts");
    const args = [process.execPath, script, "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", "12345678-1234-4234-8234-123456789abc", "--budget-ms", String(budget)];
    const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: bin + ":" + process.env.PATH, CUSTODY_FIXTURE_MODE: mode, CUSTODY_FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    const command = await readFile(join(root, "arguments"), "utf8");
    const holder = mode === "holder" ? await readFile(join(root, "holder-result"), "utf8") : undefined;
    return { exit, result, command, holder };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("owned custody transport proves local SSH retirement before accepting exit zero", async () => {
  const proof = await observed("complete");
  expect(proof.exit).toBe(0);
  expect(proof.result).toMatchObject({ scope: "owned-guest-custody-transport", ok: true, runtimeAdmission: false, transport: { exitCode: 0, signal: null, deadlineFired: false }, localCleanup: { retired: true, budgetMs: 3000 } });
  expect(proof.result.stdout).toBeUndefined();
  expect(proof.command).toContain("ConnectTimeout=3");
  expect(proof.command).toContain("--budget-seconds 1");
}, 10000);

test("owned custody transport refuses deadline completion and retires the actual SSH group", async () => {
  const proof = await observed("stall", 400);
  expect(proof.exit).toBe(4);
  expect(proof.result).toMatchObject({ ok: false, error: { code: "HOST_DEADLINE" }, transport: { deadlineFired: true, terminationRequested: true }, localCleanup: { retired: true } });
}, 10000);

test("owned custody transport rejects a completed leader with an actual pipeholding descendant", async () => {
  const proof = await observed("holder", 1000);
  expect(proof.exit).toBe(4);
  expect(proof.result).toMatchObject({ ok: false, localCleanup: { retired: true, error: "SURVIVING_GROUP_REFUSED" } });
  expect(proof.holder).toBe("terminated");
}, 10000);

test("owned custody transport bounds total output and retains failed proof and cleanup separately", async () => {
  const proof = await observed("overflow", 2000);
  expect(proof.exit).toBe(4);
  expect(proof.result).toMatchObject({ ok: false, error: { code: "OUTPUT_LIMIT" }, transport: { outputLimitExceeded: true }, localCleanup: { retired: true } });
  expect(proof.result.transport.stdoutBytes).toBeGreaterThan(2 * 1024 * 1024);
  expect(JSON.stringify(proof.result)).not.toContain("xxxxxxxx");
}, 10000);

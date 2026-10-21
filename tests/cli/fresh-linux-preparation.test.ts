import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const script = resolve(import.meta.dir, "../../scripts/observe-fresh-linux-preparation.ts");
const nonce = "12345678-1234-4234-9234-123456789abc";
const archiveSha256 = "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18";
async function fixture(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "fleur-preparation-protocol-"));
  const tools = join(root, "tools"); await mkdir(tools); await mkdir(join(root, "lab"));
  await writeFile(join(root, "nonce"), nonce);
  const python = Bun.which("python3"); if (!python) throw new Error("Existing host Python is required");
  await symlink(python, join(tools, "python3"));
  await writeFile(join(tools, "ssh"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT;const scenario=process.env.FIXTURE_SCENARIO;const remote=process.argv.at(-1);await Bun.write(root+'/remote',remote);if(scenario==='early-ssh137')process.exit(137);if(scenario==='host-key'){process.stderr.write('SECRET transport material');process.exit(255);}const prefix=${JSON.stringify("cd() { command cd \"$FIXTURE_ROOT/lab\"; }\ncat() { command cat \"$FIXTURE_ROOT/nonce\"; }\npython3() { \"$FIXTURE_ROOT/tools/guest-python3\" \"$@\"; }\n")};const child=Bun.spawn(['/bin/sh','-c',prefix+remote],{stdin:'ignore',stdout:'inherit',stderr:'inherit',env:process.env});process.exit(await child.exited);\n`, { mode: 0o700 });
  await writeFile(join(tools, "guest-python3"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT;const scenario=process.env.FIXTURE_SCENARIO;await Bun.write(root+'/python-called','yes');const frame=(stage,state)=>process.stdout.write(JSON.stringify({formatVersion:1,scope:'guest-bun-preparation-event',stage,state,elapsedMs:1})+'\\n');frame('archive-authentication','started');if(scenario==='bun-slow')await Bun.sleep(20000);if(scenario==='bun-killed')process.exit(137);if(scenario==='unknown-stage'){frame('SECRET','completed');process.exit(137);}if(scenario==='overflow'){process.stdout.write('SECRET'.repeat(400000));process.exit(137);}if(scenario==='bun-failed'){process.stdout.write(JSON.stringify({formatVersion:1,scope:'guest-bun-preparation',ok:false,error:{code:'PREPARATION_FAILED',message:'SECRET'}})+'\\n');process.exit(4);}for(const stage of ['archive-authentication','zip-entry-validation','executable-extraction','retained-output-authentication','archive-reauthentication','output-custody']){if(stage!=='archive-authentication')frame(stage,'started');frame(stage,'completed');}process.stdout.write(JSON.stringify({formatVersion:1,scope:'guest-bun-preparation',ok:true,archiveSha256:${JSON.stringify(archiveSha256)},archiveBytes:50000000,executableBytes:100000000,executableSha256:'a'.repeat(64)})+'\\n');\n`, { mode: 0o700 });
  await writeFile(join(tools, "tar"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT;const name=process.argv.at(-1);await Bun.write(root+'/tar-calls',(await Bun.file(root+'/tar-calls').exists()?await Bun.file(root+'/tar-calls').text():'')+name+'\\n');if(process.env.FIXTURE_SCENARIO==='candidate-failed'&&name==='fleur-internal-native-candidate.tgz')process.exit(2);if(process.env.FIXTURE_SCENARIO==='restriction-killed'&&name==='runtime-probe.tar')process.exit(137);\n`, { mode: 0o700 });
  const observe = async (budget = 10000) => {
    const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce, "--budget-ms", String(budget)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: tools + ":/usr/bin:/bin", HOME: root, FIXTURE_ROOT: root, FIXTURE_SCENARIO: scenario }, timeout: 15000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exit, stderr, result: JSON.parse(stdout) };
  };
  return { root, observe };
}
for (const scenario of ["early-ssh137", "bun-killed", "candidate-failed", "restriction-killed"] as const) {
  test(`preparation exit evidence identifies last reached stage without claiming timeout: ${scenario}`, async () => {
    const { root, observe } = await fixture(scenario);
    try {
      const observed = await observe();
      expect(observed.exit).toBe(4); expect(observed.stderr).toBe("");
      expect(observed.result).toMatchObject({ scope: "fresh-linux-preparation-observation", ok: false, transport: { deadlineFired: false, timeoutMs: 10000 }, error: { code: "PREPARATION_COMMAND_EXIT" } });
      expect(observed.result.transport.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(observed.result.transport.elapsedMs).toBeLessThan(10000);
      expect(observed.result.lastStage?.stage ?? null).toBe({ "early-ssh137": null, "bun-killed": "archive-authentication", "candidate-failed": "candidate-extraction", "restriction-killed": "restriction-extraction" }[scenario]);
      expect(observed.result.transport.exitCode).toBe(scenario === "candidate-failed" ? 2 : 137);
      expect(JSON.stringify(observed.result)).not.toContain("SECRET");
      if (["candidate-failed", "restriction-killed"].includes(scenario)) expect(observed.result.bun?.ok).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
test("preparation separates a local deadline from guest exit137 and retains the in-progress archive stage", async () => {
  const { root, observe } = await fixture("bun-slow");
  try {
    const observed = await observe(500);
    expect(observed.exit).toBe(4);
    expect(observed.result).toMatchObject({ ok: false, transport: { deadlineFired: true, timeoutMs: 500 }, lastStage: { stage: "archive-authentication", state: "started" }, error: { code: "PREPARATION_HOST_DEADLINE" } });
    expect(observed.result.transport.elapsedMs).toBeGreaterThanOrEqual(500);
    expect(observed.result.transport.elapsedMs).toBeLessThan(2500);
    expect(await Bun.file(join(root, "tar-calls")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);
test("preparation success requires Bun identity and both archive commands, with no compiler action", async () => {
  const { root, observe } = await fixture("success");
  try {
    const observed = await observe();
    expect(observed).toMatchObject({ exit: 0, stderr: "", result: { ok: true, transport: { deadlineFired: false, exitCode: 0 }, lastStage: { stage: "complete", state: "completed" }, bun: { archiveSha256 } } });
    expect((await readFile(join(root, "tar-calls"), "utf8")).trim().split("\n")).toEqual(["fleur-internal-native-candidate.tgz", "runtime-probe.tar"]);
    const remote = await readFile(join(root, "remote"), "utf8");
    expect(remote).not.toContain("sudo"); expect(remote).not.toContain("dpkg");
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const scenario of ["host-key", "unknown-stage", "overflow", "bun-failed"] as const) {
  test(`preparation reports only allowlisted diagnostics and stays incomplete: ${scenario}`, async () => {
    const { root, observe } = await fixture(scenario);
    try {
      const observed = await observe();
      expect(observed.exit).toBe(4); expect(observed.result.ok).toBe(false);
      expect(JSON.stringify(observed.result)).not.toContain("SECRET");
      expect(await Bun.file(join(root, "tar-calls")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("an exited SSH leader with inherited pipes cannot stretch the preparation deadline", async () => {
  const { root, observe } = await fixture("success");
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing host Python is required");
    await writeFile(join(root, "tools/ssh"), `#!${process.execPath}\nconst child=Bun.spawn([${JSON.stringify(python)},'-c','import time;time.sleep(2)'],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});await Bun.write(process.env.FIXTURE_ROOT+'/descendant',String(child.pid));process.exit(137);\n`, { mode: 0o700 });
    const observed = await observe(500);
    expect(observed.exit).toBe(4);
    expect(observed.result).toMatchObject({ transport: { deadlineFired: true }, error: { code: "PREPARATION_HOST_DEADLINE" } });
    expect(observed.result.transport.elapsedMs).toBeLessThan(1500);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

test("real Bun preparation keeps its default result and emits only opt-in authentication-stage evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-real-preparation-events-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing host Python is required");
    await writeFile(join(root, "bun.zip"), "corrupted archive fixture");
    for (const enabled of [false, true]) {
      const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "../../scripts/prepare-fresh-linux-guest.py")], { cwd: root, env: { HOME: root, PATH: process.env.PATH, ...(enabled ? { FLEUR_GUEST_PREPARATION_EVENTS: "yes" } : {}) }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit).toBe(4); expect(stderr).toBe("");
      const frames = stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(frames.at(-1)).toMatchObject({ formatVersion: 1, scope: "guest-bun-preparation", ok: false, error: { code: "PREPARATION_FAILED" } });
      expect(frames).toHaveLength(enabled ? 2 : 1);
      if (enabled) expect(frames[0]).toMatchObject({ scope: "guest-bun-preparation-event", stage: "archive-authentication", state: "started", elapsedMs: expect.any(Number) });
      expect(await Bun.file(join(root, "bun")).exists()).toBe(false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

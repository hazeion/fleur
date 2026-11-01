import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import bunFloor from "../../scripts/bun-floor.json";
const script = resolve(import.meta.dir, "../../scripts/observe-fresh-linux-preparation.ts");
const nonce = "12345678-1234-4234-9234-123456789abc";
const archiveSha256 = bunFloor.archives["linux-x64"].sha256;
async function fixture(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "fleur-preparation-protocol-"));
  const tools = join(root, "tools"); await mkdir(tools); await mkdir(join(root, "lab"));
  await writeFile(join(root, "nonce"), nonce);
  const python = Bun.which("python3"); if (!python) throw new Error("Existing host Python is required");
  await symlink(python, join(tools, "python3"));
  await writeFile(join(tools, "ssh"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT;const scenario=process.env.FIXTURE_SCENARIO;const remote=process.argv.at(-1);await Bun.write(root+'/remote',remote);if(scenario==='early-ssh137')process.exit(137);if(scenario==='bun-slow'){for(const frame of [{formatVersion:1,scope:'guest-artifact-preparation-event',stage:'bun-preparation',state:'started'},{formatVersion:1,scope:'guest-bun-preparation-event',stage:'archive-authentication',state:'started',elapsedMs:0}])process.stdout.write(JSON.stringify(frame)+'\\n');await Bun.sleep(20000);process.exit(0);}if(scenario==='host-key'){process.stderr.write('SECRET transport material');process.exit(255);}const prefix=${JSON.stringify("cd() { command cd \"$FIXTURE_ROOT/lab\"; }\ncat() { command cat \"$FIXTURE_ROOT/nonce\"; }\npython3() { \"$FIXTURE_ROOT/tools/guest-python3\" \"$@\"; }\n")};const child=Bun.spawn(['/bin/sh','-c',prefix+remote],{stdin:'ignore',stdout:'inherit',stderr:'inherit',env:process.env});process.exit(await child.exited);\n`, { mode: 0o700 });
  await writeFile(join(tools, "guest-python3"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT;const scenario=process.env.FIXTURE_SCENARIO;await Bun.write(root+'/python-called','yes');const frame=(stage,state)=>process.stdout.write(JSON.stringify({formatVersion:1,scope:'guest-bun-preparation-event',stage,state,elapsedMs:1})+'\\n');frame('archive-authentication','started');if(scenario==='bun-slow')await Bun.sleep(20000);if(scenario==='bun-killed')process.exit(137);if(scenario==='unknown-stage'){frame('SECRET','completed');process.exit(137);}if(scenario==='overflow'){await new Promise((resolve,reject)=>process.stdout.write('SECRET'.repeat(400000),error=>error?reject(error):resolve()));process.exit(137);}if(scenario==='bun-failed'){process.stdout.write(JSON.stringify({formatVersion:1,scope:'guest-bun-preparation',ok:false,error:{code:'PREPARATION_FAILED',message:'SECRET'}})+'\\n');process.exit(4);}for(const stage of ['archive-authentication','zip-entry-validation','executable-extraction','retained-output-authentication','archive-reauthentication','output-custody']){if(stage!=='archive-authentication')frame(stage,'started');frame(stage,'completed');}process.stdout.write(JSON.stringify({formatVersion:1,scope:'guest-bun-preparation',ok:true,archiveSha256:${JSON.stringify(archiveSha256)},archiveBytes:50000000,executableBytes:100000000,executableSha256:'a'.repeat(64)})+'\\n');\n`, { mode: 0o700 });
  await writeFile(join(tools, "tar"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT;const name=process.argv.at(-1);await Bun.write(root+'/tar-calls',(await Bun.file(root+'/tar-calls').exists()?await Bun.file(root+'/tar-calls').text():'')+name+'\\n');if(process.env.FIXTURE_SCENARIO==='candidate-failed'&&name==='fleur-internal-native-candidate.tgz')process.exit(2);if(process.env.FIXTURE_SCENARIO==='restriction-killed'&&name==='runtime-probe.tar')process.exit(137);\n`, { mode: 0o700 });
  const observe = async (budget = 10000, started?: (child: ReturnType<typeof Bun.spawn>) => void) => {
    const preload = await Bun.file(join(root, "signal-denied.ts")).exists() ? ["--preload", join(root, "signal-denied.ts")] : [];
    const child = Bun.spawn([process.execPath, ...preload, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce, "--budget-ms", String(budget)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: tools + ":/usr/bin:/bin", HOME: root, FIXTURE_ROOT: root, FIXTURE_SCENARIO: scenario }, timeout: 15000 });
    started?.(child);
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (started) await writeFile(join(root, "public-observation.json"), JSON.stringify({ stdout, stderr, exit }));
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
  }, 20000);
}
test("preparation separates a local deadline from guest exit137 and retains the in-progress archive stage", async () => {
  const { root, observe } = await fixture("bun-slow");
  try {
    const observed = await observe(4000);
    expect(observed.exit).toBe(4);
    expect(observed.result).toMatchObject({ ok: false, transport: { deadlineFired: true, timeoutMs: 4000 }, lastStage: { stage: "archive-authentication", state: "started" }, error: { code: "PREPARATION_HOST_DEADLINE" } });
    expect(observed.result.transport.elapsedMs).toBeGreaterThanOrEqual(4000);
    expect(observed.result.transport.elapsedMs).toBeLessThan(6000);
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
}, 20000);
for (const scenario of ["host-key", "unknown-stage", "overflow", "bun-failed"] as const) {
  test(`preparation reports only allowlisted diagnostics and stays incomplete: ${scenario}`, async () => {
    const { root, observe } = await fixture(scenario);
    try {
      const observed = await observe();
      expect(observed.exit).toBe(4); expect(observed.result.ok).toBe(false);
      expect(JSON.stringify(observed.result)).not.toContain("SECRET");
      if (scenario === "overflow") {
        expect(observed.result.transport.outputLimitExceeded, JSON.stringify(observed.result.transport)).toBe(true);
        expect(observed.result.transport.deadlineFired).toBe(false);
      }
      expect(await Bun.file(join(root, "tar-calls")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20000);
}

test("an exited SSH leader with inherited pipes cannot stretch the preparation deadline", async () => {
  const { root, observe } = await fixture("success");
  let driver: ReturnType<typeof Bun.spawn> | undefined;
  let retirementConfirmed = false;
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing host Python is required");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    // Receipt before exec preserves the actual relay PID without replacing its
    // protocol or wait/reap implementation. Finally only observes these PIDs.
    await rm(join(root, "tools/python3"));
    await writeFile(join(root, "tools/python3"), `#!/bin/sh\nprintf '%s' "$$" > "$FIXTURE_ROOT/relay-pid"\nexec ${quote(python)} "$@"\n`, { mode: 0o700 });
    // A live pipe holder must outlast work(4s)+cleanup(3s); its signal witness
    // distinguishes actual retirement from merely waiting for natural expiry.
    const holder = `import os,pathlib,signal,sys,time
root=pathlib.Path(os.environ['FIXTURE_ROOT'])
def terminated(number,frame):
 (root/'descendant-term').write_text(str(number));sys.exit(0)
signal.signal(signal.SIGTERM,terminated)
(root/'descendant-ready').write_text(str(os.getpid()))
time.sleep(12)
(root/'descendant-natural-expiry').write_text('unexpected natural expiry')
`;
    await writeFile(join(root, "tools/ssh"), `#!${process.execPath}\nconst child=Bun.spawn([${JSON.stringify(python)},'-c',${JSON.stringify(holder)}],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});await Bun.write(process.env.FIXTURE_ROOT+'/descendant',String(child.pid));const ready=process.env.FIXTURE_ROOT+'/descendant-ready';const end=performance.now()+3000;while(!await Bun.file(ready).exists()){if(performance.now()>=end)throw new Error('Pipe holder failed to install its signal observer');await Bun.sleep(1);}process.exit(137);\n`, { mode: 0o700 });
    const observed = await observe(4000, (child) => { driver = child; });
    expect(observed.exit).toBe(4);
    expect(observed.result).toMatchObject({ transport: { deadlineFired: false, timeoutMs: 4000, exitCode: 137 }, localCleanup: { retired: true }, error: { code: "PREPARATION_SURVIVOR" } });
    expect(observed.result.transport.elapsedMs).toBeLessThan(5000);
    const pid = Number(await readFile(join(root, "descendant"), "utf8"));
    expect(Number(await readFile(join(root, "descendant-ready"), "utf8"))).toBe(pid);
    expect(await readFile(join(root, "descendant-term"), "utf8")).toBe("15");
    expect(await Bun.file(join(root, "descendant-natural-expiry")).exists()).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    // Preserve a primary protocol/assertion failure. Retirement uncertainty is
    // logged separately and leaves the fixture intact, never overwritten by it.
    try {
      if (driver) await driver.exited; // Existing15s child cap still applies.
      const pids: number[] = [];
      let receiptsComplete = true;
      if (driver) for (const name of ["relay-pid", "descendant"]) {
        const file = Bun.file(join(root, name));
        if (!await file.exists()) { receiptsComplete = false; continue; }
        const pid = Number(await file.text());
        if (!Number.isSafeInteger(pid) || pid <= 0) { receiptsComplete = false; continue; }
        pids.push(pid);
      }
      const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } };
      const end = performance.now() + 2000;
      while (pids.some((pid) => !gone(pid)) && performance.now() < end) await Bun.sleep(10);
      const absent = pids.map(gone);
      retirementConfirmed = receiptsComplete && absent.every(Boolean);
      console.info(JSON.stringify({ kind: "preparation-fixture-retirement", root, driverExit: driver?.exitCode, pids, absent, retired: retirementConfirmed }));
      if (retirementConfirmed) await rm(root, { recursive: true, force: true });
    } catch (error) {
      retirementConfirmed = false;
      console.error(JSON.stringify({ kind: "preparation-fixture-retirement-uncertain", preserved: root, error: String(error) }));
    }
  }
  expect(retirementConfirmed, `Fixture retirement remains unconfirmed; preserved ${root}`).toBe(true);
}, 20000);

test("real Bun preparation keeps its default result and emits only opt-in authentication-stage evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-real-preparation-events-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing host Python is required");
    await writeFile(join(root, "bun.zip"), "corrupted archive fixture");
    // The host stages the release floor record beside the archive; the corrupted bytes then fail authentication.
    await copyFile(resolve(import.meta.dir, "../../scripts/bun-floor.json"), join(root, "bun-floor.json"));
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
}, 15000);

for (const malformed of ["only-final-bun-phase", "missing-pair", "duplicate", "reordered", "outside-bun", "regressing-time", "oversized-time", "missing-time", "early-result", "duplicate-result", "after-complete"] as const) {
  test(`a successful transcript requires the real producer's nested phase sequence: ${malformed}`, async () => {
    const { root, observe } = await fixture("success");
    try {
      const outer = (stage: string, state: string) => ({ formatVersion: 1, scope: "guest-artifact-preparation-event", stage, state });
      // Specification oracle: the actual preparer authenticates the archive,
      // validates entries, extracts, authenticates retained output, reauthenticates
      // the archive and checks output custody, in that order.
      const producerPhases = ["archive-authentication", "zip-entry-validation", "executable-extraction", "retained-output-authentication", "archive-reauthentication", "output-custody"];
      const phases: Record<string, unknown>[] = producerPhases.flatMap((stage, index) => ["started", "completed"].map((state, offset) => ({ formatVersion: 1, scope: "guest-bun-preparation-event", stage, state, elapsedMs: 2 * index + offset })));
      const bun = { formatVersion: 1, scope: "guest-bun-preparation", ok: true, archiveSha256, archiveBytes: 50000000, executableBytes: 100000000, executableSha256: "a".repeat(64) };
      if (malformed === "only-final-bun-phase") phases.splice(0, phases.length, { formatVersion: 1, scope: "guest-bun-preparation-event", stage: "output-custody", state: "completed", elapsedMs: 999999 });
      if (malformed === "missing-pair") phases.splice(2, 2);
      if (malformed === "duplicate") phases.splice(2, 0, structuredClone(phases[1]!));
      if (malformed === "reordered") phases.splice(2, 4, ...phases.slice(4, 6), ...phases.slice(2, 4));
      if (malformed === "regressing-time") phases[2]!.elapsedMs = 0;
      if (malformed === "oversized-time") phases.at(-1)!.elapsedMs = 999999;
      if (malformed === "missing-time") delete phases[1]!.elapsedMs;
      const transcript: Record<string, unknown>[] = [outer("bun-preparation", "started"), ...phases, bun, outer("bun-preparation", "completed"), outer("candidate-extraction", "started"), outer("candidate-extraction", "completed"), outer("restriction-extraction", "started"), outer("restriction-extraction", "completed"), outer("complete", "completed")];
      if (malformed === "outside-bun") transcript.unshift(transcript.splice(1, 1)[0]!);
      if (malformed === "early-result") transcript.splice(1, 0, transcript.splice(transcript.indexOf(bun), 1)[0]!);
      if (malformed === "duplicate-result") transcript.splice(transcript.indexOf(bun), 0, structuredClone(bun));
      if (malformed === "after-complete") transcript.push(structuredClone(phases[0]!));
      await writeFile(join(root, "tools/ssh"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(transcript.map((frame) => JSON.stringify(frame)).join("\n") + "\n")});process.exit(0);\n`, { mode: 0o700 });
      const observed = await observe();
      expect(observed.exit).toBe(4);
      expect(observed.result).toMatchObject({ ok: false, error: { code: "PREPARATION_PROTOCOL_INVALID" } });
      expect(observed.result.localCleanup).toMatchObject({ retired: true });
      expect(observed.result.localCleanup.error).toBeUndefined();
      if (malformed === "only-final-bun-phase") {
        expect(observed.result.lastStage).toMatchObject({ stage: "bun-preparation", state: "started" });
        expect(observed.result.bun).toBeUndefined();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20000);
}

test("a valid extraction-failure prefix retains its cleanup evidence without inventing completion", async () => {
  const { root, observe } = await fixture("success");
  try {
    const frames = [
      { formatVersion: 1, scope: "guest-artifact-preparation-event", stage: "bun-preparation", state: "started" },
      ...["archive-authentication:started", "archive-authentication:completed", "zip-entry-validation:started", "zip-entry-validation:completed", "executable-extraction:started", "cleanup:started", "cleanup:completed"].map((key, elapsedMs) => { const [stage, state] = key.split(":"); return { formatVersion: 1, scope: "guest-bun-preparation-event", stage, state, elapsedMs }; }),
      { formatVersion: 1, scope: "guest-bun-preparation", ok: false, ownedPartialRemoved: true },
    ];
    await writeFile(join(root, "tools/ssh"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n")});process.exit(4);\n`, { mode: 0o700 });
    const observed = await observe();
    expect(observed).toMatchObject({ exit: 4, result: { ok: false, lastStage: { stage: "cleanup", state: "completed" }, bun: { ok: false, ownedPartialRemoved: true }, error: { code: "PREPARATION_COMMAND_EXIT" } } });
    expect(observed.result.stages.some((stage: { stage: string }) => stage.stage === "complete")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20000);

test("a completed preparation with a live closed-pipe SSH descendant cannot be accepted", async () => {
  const { root, observe } = await fixture("success");
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing host Python is required");
    const path = join(root, "tools/ssh");
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace("process.exit(await child.exited);", `const code=await child.exited;const survivor=Bun.spawn([${JSON.stringify(python)},'-c','import time;time.sleep(2)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});await Bun.write(root+'/closed-pipe-descendant',String(survivor.pid));process.exit(code);`), { mode: 0o700 });
    const observed = await observe();
    expect(observed.exit).toBe(4);
    expect(observed.result).toMatchObject({ ok: false, transport: { deadlineFired: false }, error: { code: "PREPARATION_SURVIVOR" } });
    const pid = Number(await readFile(join(root, "closed-pipe-descendant"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20000);

test("denied survivor signals enter finite cleanup before the preparation work deadline", async () => {
  const { root, observe } = await fixture("success");
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing host Python is required");
    await writeFile(join(root, "tools/ssh"), `#!${process.execPath}\nawait Bun.write(process.env.FIXTURE_ROOT+'/ssh-pid',String(process.pid));process.stdout.write(JSON.stringify({formatVersion:1,scope:'guest-artifact-preparation-event',stage:'bun-preparation',state:'started'})+'\\n');const survivor=Bun.spawn([${JSON.stringify(python)},'-c','import time;time.sleep(20)'],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});await Bun.write(process.env.FIXTURE_ROOT+'/denied-survivor',String(survivor.pid));process.exit(0);\n`, { mode: 0o700 });
    await writeFile(join(root, "signal-denied.ts"), `import{existsSync,readFileSync,appendFileSync}from'node:fs';const root=process.env.FIXTURE_ROOT;const original=process.kill.bind(process);process.kill=((pid,signal)=>{if((signal==='SIGTERM'||signal==='SIGKILL')&&existsSync(root+'/ssh-pid')&&pid===-Number(readFileSync(root+'/ssh-pid','utf8'))){appendFileSync(root+'/signal-denials',signal+'\\n');throw Object.assign(new Error('Owned fixture EPERM'),{code:'EPERM'});}return original(pid,signal);});\n`);
    const started = performance.now(); const observed = await observe();
    expect(observed.exit).toBe(4);
    expect(observed.result).toMatchObject({ ok: false, transport: { deadlineFired: false, timeoutMs: 10000 }, localCleanup: { retired: false }, error: { code: "PREPARATION_CLEANUP_UNCONFIRMED" } });
    expect(performance.now() - started).toBeLessThan(5000);
    const denied = (await readFile(join(root, "signal-denials"), "utf8")).trim().split("\n");
    expect(denied).toContain("SIGTERM"); expect(denied).toContain("SIGKILL");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

test("malformed evidence followed by a stall remains owned by the original work watchdog", async () => {
  const { root, observe } = await fixture("success");
  try {
    const frames = [
      { formatVersion: 1, scope: "guest-artifact-preparation-event", stage: "bun-preparation", state: "started" },
      { formatVersion: 1, scope: "guest-bun-preparation-event", stage: "output-custody", state: "completed", elapsedMs: 0 },
    ];
    await writeFile(join(root, "tools/ssh"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n")});await Bun.sleep(20000);\n`, { mode: 0o700 });
    const observed = await observe(4000);
    expect(observed.exit).toBe(4);
    expect(observed.result).toMatchObject({ ok: false, transport: { deadlineFired: true, timeoutMs: 4000 }, evidenceError: { code: "PREPARATION_PROTOCOL_INVALID" }, error: { code: "PREPARATION_HOST_DEADLINE" } });
    expect(observed.result.transport.elapsedMs).toBeGreaterThanOrEqual(4000);
    expect(observed.result.transport.elapsedMs).toBeLessThan(6000);
    expect(observed.result.lastStage).toMatchObject({ stage: "bun-preparation", state: "started" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

test("packed candidate preparation establishes private catalog custody despite a group-sharing login umask", async () => {
  const { root, observe } = await fixture("success");
  const guestRoot = await mkdtemp(join(tmpdir(), "fleur-prepared-catalog-guest-"));
  try {
    const output = join(root, "candidate");
    const builder = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/build-native-candidate.ts"), "--out", output, "--fixture", "ubuntu26-amd64"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [built, builderError, builderExit] = await Promise.all([new Response(builder.stdout).text(), new Response(builder.stderr).text(), builder.exited]);
    expect(builderExit, builderError + built).toBe(0);
    await copyFile(join(output, "fleur-internal-native-candidate.tgz"), join(root, "lab/fleur-internal-native-candidate.tgz"));
    const empty = join(root, "empty"); await mkdir(empty);
    const tar = Bun.spawn(["/usr/bin/tar", "-cf", join(root, "lab/runtime-probe.tar"), "-C", empty, "."], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(await tar.exited, await new Response(tar.stderr).text()).toBe(0);
    // The SSH adapter runs the actual source remote command under an ordinary
    // group-sharing login mask; archive extraction is real, never mocked.
    const ssh = join(root, "tools/ssh");
    await writeFile(ssh, (await readFile(ssh, "utf8")).replace("prefix+remote", "'umask 002\\n'+prefix+remote"));
    await writeFile(join(root, "tools/tar"), "#!/bin/sh\nexec /usr/bin/tar \"$@\"\n", { mode: 0o700 });
    const prepared = await observe();
    expect(prepared).toMatchObject({ exit: 0, result: { ok: true, localCleanup: { retired: true } } });
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), guestRoot, "owned26-target-valid", join(root, "lab/package")], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    const report = JSON.parse(stdout);
    expect(report.error.message).toContain("TARGET_BOUNDARY_OBSERVED");
    expect(report.executionArtifact).toEqual({ kind: "internal-candidate", catalogId: "ubuntu-26.04-amd64-docker-2026-10-19", catalogSha256: "e1d4756d2b9d6ce7dfccff783bb64e50bde09be1c36a8c36f1a2d4577937eb3a" });
    const state = await Bun.file(join(guestRoot, "protocol-state.json")).json();
    expect(state.targetBoundaryObserved).toBe(true);
    expect(state.installed).toBe(false);
    expect(state.installPrompts).toEqual([]);
    expect(state.enrollmentPrompts).toEqual([]);
    expect(state.unexpected).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(guestRoot, { recursive: true, force: true });
  }
}, 45000);

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
type SessionFixtureChild = Subprocess<"ignore", "pipe", "pipe">;
const script = resolve(import.meta.dir, "../../scripts/observe-fresh-linux-session.ts");
const nonce = "12345678-1234-1234-1234-123456789abc";

function reapFixtureGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

async function waitForFixturePid(root: string): Promise<number> {
  const stop = performance.now() + 3000;
  while (performance.now() < stop) {
    let receipt = "";
    try { receipt = await readFile(join(root, "ssh-pid"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (performance.now() >= stop) break;
    if (/^[1-9][0-9]*\n$/.test(receipt)) {
      const pid = Number(receipt);
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
      throw new Error("Fixture published an unsafe SSH PID");
    }
    await Bun.sleep(10);
  }
  throw new Error("Fixture did not publish a complete SSH PID within its original startup budget");
}

async function retireSessionFixture(child: SessionFixtureChild | undefined, pid: number | undefined): Promise<void> {
  try {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    }
  } finally { reapFixtureGroup(pid); }
}

test("missing PID publication still cancels and retires the actual session and SSH fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-missing-pid-"));
  let child: SessionFixtureChild | undefined;
  let actualPid: number | undefined;
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';const root=process.env.FIXTURE_ROOT;process.on('SIGTERM',()=>{});writeFileSync(root+'/actual-pid',String(process.pid)+'\\n');writeFileSync(root+'/ssh-pid','');setInterval(()=>{},1000);\n`, { mode: 0o700 });
    child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
    await expect(waitForFixturePid(root)).rejects.toThrow("did not publish a complete SSH PID");
    actualPid = Number(await readFile(join(root, "actual-pid"), "utf8"));
    expect(Number.isSafeInteger(actualPid) && actualPid > 1).toBe(true);
    await retireSessionFixture(child, undefined);
    expect(child.exitCode).not.toBeNull();
    expect(() => process.kill(actualPid!, 0)).toThrow();
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    }
    reapFixtureGroup(actualPid);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

// Production command boundary baseline before adding a second-login transition.
// This fixture only supplies SSH protocol results; it claims no image/native proof.
test("session observation preserves the existing incomplete guest report and closes its sole SSH connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-protocol-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const pending = { formatVersion: 1, ok: false, runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline: { packages: "original pristine fixture" } };
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify("FLEUR_SESSION_READY=" + nonce + "\n")});await Bun.write(process.env.FIXTURE_ROOT+'/ssh-arguments.json',JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(JSON.stringify(pending))});process.exit(4);\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ formatVersion: 1, scope: "fresh-linux-session-observation", ok: false, guest: pending });
    const args = JSON.parse(await readFile(join(root, "ssh-arguments.json"), "utf8")) as string[];
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("IdentityAgent=none");
    expect(args).toContain("fleur@127.0.0.1");
    expect(args.at(-1)).toBe(`printf 'FLEUR_SESSION_READY=${nonce}\\n'; exec python3 lab/fresh-linux-guest.py ${nonce}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

test("a pending handoff closes the old SSH workflow before one fresh pinned connection consumes its anchored checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-transition-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const baseline = { packages: "original pristine fixture" };
    const pending = { formatVersion: 1, ok: false, phase: "new-login-required", runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline, checkpoint: { sha256: "b".repeat(64), bytes: 800 }, accessHandoff: { after: { user: { name: "fleur", uid: 1000 }, group: { name: "docker", gid: 997 }, accountGroups: [27, 997, 1000], sessionGroups: [27, 1000] } } };
    const resumed = { formatVersion: 1, ok: false, runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline, accessResume: { checkpointSha256: "b".repeat(64), sessionGroups: [27, 997, 1000] }, error: { code: "NATIVE_SETUP_INCOMPLETE", message: "Fixture daemon remains denied" } };
    await writeFile(join(tools, "ssh"), `#!${process.execPath}
process.stdout.write(${JSON.stringify("FLEUR_SESSION_READY=" + nonce + "\n")});
const root=process.env.FIXTURE_ROOT; const path=root+'/connections.json'; const calls=await Bun.file(path).exists()?await Bun.file(path).json():[];
const previous=calls.at(-1); let previousAlive=false;if(previous){try{process.kill(previous.pid,0);previousAlive=true;}catch{}}
calls.push({pid:process.pid,args:process.argv.slice(2),previousAlive});await Bun.write(path,JSON.stringify(calls));
process.stdout.write(calls.length===1?${JSON.stringify(JSON.stringify(pending))}:${JSON.stringify(JSON.stringify(resumed))});process.exit(calls.length===1?3:4);
`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const calls = await Bun.file(join(root, "connections.json")).json();
    expect(calls, stderr + stdout).toHaveLength(2);
    expect(calls[1].previousAlive).toBe(false);
    expect(calls[1].pid).not.toBe(calls[0].pid);
    for (const call of calls) {
      expect(call.args).toContain("ControlMaster=no"); expect(call.args).toContain("ControlPath=none");
      expect(call.args).toContain("StrictHostKeyChecking=yes"); expect(call.args).toContain("fleur@127.0.0.1");
    }
    expect(calls[1].args.at(-1)).toBe(`printf 'FLEUR_SESSION_READY=${nonce}\\n'; exec python3 lab/fresh-linux-guest.py ${nonce} --resume ${"b".repeat(64)}`);
    expect(exit).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, initialGuest: pending, guest: resumed });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

test("a successful SSH leader with a surviving owned child cannot authorize a fresh connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-survivor-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const pending = { formatVersion: 1, ok: false, phase: "new-login-required", runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline: { packages: "original" }, checkpoint: { sha256: "b".repeat(64), bytes: 800 }, accessHandoff: { after: { user: { name: "fleur", uid: 1000 }, group: { gid: 997 }, accountGroups: [997, 1000], sessionGroups: [1000] } } };
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify("FLEUR_SESSION_READY=" + nonce + "\n")});const root=process.env.FIXTURE_ROOT;const calls=await Bun.file(root+'/calls').exists()?Number(await Bun.file(root+'/calls').text()):0;await Bun.write(root+'/calls',String(calls+1));if(calls===0){const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});await Bun.write(root+'/survivor',String(child.pid));}process.stdout.write(${JSON.stringify(JSON.stringify(pending))});process.exit(3);\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const pid = Number(await readFile(join(root, "survivor"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(exit, stderr + stdout).toBe(4);
    expect(await readFile(join(root, "calls"), "utf8")).toBe("1");
    expect(JSON.parse(stdout).error.message).toContain("surviving owned SSH process group");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

test("cancelling the session command reaps its owned SSH group and returns incomplete evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-cancel-"));
  let sshPid: number | undefined;
  let child: SessionFixtureChild | undefined;
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nawait Bun.write(process.env.FIXTURE_ROOT+'/ssh-pid',String(process.pid)+'\\n');setInterval(()=>{},1000);\n`, { mode: 0o700 });
    child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
    sshPid = await waitForFixturePid(root);
    expect(sshPid).toBeGreaterThan(0);
    child.kill("SIGTERM");
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "SESSION_FAILED" } });
    expect(() => process.kill(sshPid!, 0)).toThrow();
  } finally {
    await retireSessionFixture(child, sshPid);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

for (const scenario of ["pending-exit", "pending-digest", "pending-baseline", "pending-groups", "resume-baseline", "resume-digest", "resume-groups", "resume-phase", "transport-pin", "resume-group-order"] as const) {
  test(`session orchestration validates transport and checkpoint evidence: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-session-binding-"));
    try {
      const tools = join(root, "tools"); await mkdir(tools);
      const baseline = { packages: "original pristine fixture" };
      const pending = { formatVersion: 1, ok: false, phase: "new-login-required", runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline, checkpoint: { sha256: "b".repeat(64), bytes: 800 }, accessHandoff: { after: { user: { name: "fleur", uid: 1000 }, group: { gid: 997 }, accountGroups: [997, 1000], sessionGroups: [1000] } } };
      const resumed = { formatVersion: 1, ok: false, runtimeSupport: "unverified", humanConsentProof: false, installationEvidence: "pending", baseline, accessResume: { checkpointSha256: "b".repeat(64), sessionGroups: [997, 1000] } };
      await writeFile(join(tools, "ssh"), `#!${process.execPath}
if (${JSON.stringify(scenario)} !== "transport-pin") process.stdout.write(${JSON.stringify("FLEUR_SESSION_READY=" + nonce + "\n")});
const root=process.env.FIXTURE_ROOT;const scenario=${JSON.stringify(scenario)};const file=root+'/calls';const n=await Bun.file(file).exists()?Number(await Bun.file(file).text())+1:1;await Bun.write(file,String(n));
const report=n===1?${JSON.stringify(pending)}:${JSON.stringify(resumed)};let code=n===1?3:4;
if(n===1){if(scenario==='pending-exit')code=0;if(scenario==='pending-digest')report.checkpoint.sha256='wrong';if(scenario==='pending-baseline')delete report.baseline;if(scenario==='pending-groups')report.accessHandoff.after.sessionGroups.push(997);if(scenario==='transport-pin'){process.stderr.write('Host key verification failed.\\n');process.exit(255);}}
else{if(scenario==='resume-baseline')report.baseline={packages:'installed replacement'};if(scenario==='resume-digest')report.accessResume.checkpointSha256='c'.repeat(64);if(scenario==='resume-groups')report.accessResume.sessionGroups=[1000];if(scenario==='resume-phase')report.phase='new-login-required';if(scenario==='resume-group-order')report.accessResume.sessionGroups.reverse();}
await Bun.write(root+'/fault-exercised',scenario);process.stdout.write(JSON.stringify(report));process.exit(code);
`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr + stdout).toBe(4);
      expect(await readFile(join(root, "calls"), "utf8")).toBe(scenario.startsWith("resume-") ? "2" : "1");
      if (scenario !== "transport-pin") expect(await readFile(join(root, "fault-exercised"), "utf8")).toBe(scenario);
      if (scenario === "resume-group-order") {
        expect(JSON.parse(stdout)).toMatchObject({ ok: false, guest: { accessResume: { sessionGroups: [1000, 997] } } });
        expect(JSON.parse(stdout).error).toBeUndefined();
      } else {
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "SESSION_FAILED", message: expect.stringContaining(scenario === "transport-pin" ? "Host key verification failed" : scenario.startsWith("resume-") ? "Resumed ordinary login report differs" : "Intermediate guest handoff is invalid") } });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);
}

test("the second connection receives only the remainder of the original aggregate session budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-budget-"));
  let lastPid: number | undefined;
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(root, "clock"), "0");
    // Declared external runtime-clock boundary: unchanged production code and limits.
    await writeFile(join(root, "clock.ts"), `import {readFileSync} from 'node:fs';Object.defineProperty(performance,'now',{value:()=>Number(readFileSync(process.env.FIXTURE_ROOT+'/clock','utf8'))});\n`);
    const pending = { formatVersion: 1, ok: false, phase: "new-login-required", runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline: { packages: "original" }, checkpoint: { sha256: "b".repeat(64), bytes: 800 }, accessHandoff: { after: { user: { name: "fleur", uid: 1000 }, group: { gid: 997 }, accountGroups: [997, 1000], sessionGroups: [1000] } } };
    // Keep process-startup overhead out of the modeled 900-second clock jump.
    // Both real SSH relay lifetimes and the final two-second assertion remain.
    await writeFile(join(tools, "ssh"), `#!/bin/sh
printf '%s\\n' ${JSON.stringify("FLEUR_SESSION_READY=" + nonce)}
root="$FIXTURE_ROOT"
n=0
if [ -f "$root/calls" ]; then IFS= read -r n < "$root/calls" || :; fi
n=$((n+1))
printf '%s' "$n" > "$root/calls"
printf '%s' "$$" > "$root/last-pid"
if [ "$n" -eq 1 ]; then
  printf '%s' 899500 > "$root/clock"
  printf '%s' '${JSON.stringify(pending)}'
  exit 3
fi
printf '%s' 900001 > "$root/clock"
exec /bin/sleep 10
`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, "--preload", join(root, "clock.ts"), script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
    // Witness the first workflow's clock jump before measuring retirement.
    // Cold interpreter/relay setup cannot consume this assertion's allowance.
    const setupDeadline = performance.now() + 3000;
    while (await Bun.file(join(root, "clock")).text() === "0" && performance.now() < setupDeadline) await Bun.sleep(10);
    expect(await Bun.file(join(root, "clock")).text()).not.toBe("0");
    const started = performance.now();
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    lastPid = Number(await readFile(join(root, "last-pid"), "utf8"));
    expect(await readFile(join(root, "calls"), "utf8")).toBe("2");
    expect(await readFile(join(root, "clock"), "utf8")).toBe("900001");
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining("aggregate deadline expired") }, initialGuest: pending });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(() => process.kill(lastPid!, 0)).toThrow();
  } finally {
    if (!lastPid && await Bun.file(join(root, "last-pid")).exists()) lastPid = Number(await readFile(join(root, "last-pid"), "utf8"));
    reapFixtureGroup(lastPid);
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

for (const missing of ["doctor-release", "doctor-daemon", "smoke-cleanup", "repeat", "sentinel-cleanup", "restriction-bounded", "restriction-cleanup", "exit-envelope", "complete"] as const) {
  test(`a session report requires the original final proof gates: ${missing}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-session-final-gate-"));
    try {
      const tools = join(root, "tools"); await mkdir(tools);
      const doctor = { exitCode: 4, result: { formatVersion: 1, command: "doctor", ok: false, truncated: false, error: { code: "PREREQUISITE_UNAVAILABLE" }, data: { components: { cli: { state: "ready" }, daemon: { state: "ready" }, compose: { state: "ready" }, smoke: { state: "ready", cleanup: true }, release: { state: "unverified" } } } } };
      const final = { formatVersion: 1, ok: true, runtimeSupport: "unverified", installationEvidence: "verified-full-system-guest", humanConsentProof: false, baseline: { packages: "original pristine fixture" }, runs: [structuredClone(doctor), structuredClone(doctor)], sentinelCleanup: true, restrictionProbe: { exitCode: 0, result: { bounded_probe_passed: true, cleanup_complete: true } } };
      if (missing === "doctor-release") final.runs[0]!.result.data.components.release.state = "verified";
      if (missing === "doctor-daemon") final.runs[0]!.result.data.components.daemon.state = "denied";
      if (missing === "smoke-cleanup") final.runs[0]!.result.data.components.smoke.cleanup = false;
      if (missing === "repeat") final.runs.pop();
      if (missing === "sentinel-cleanup") final.sentinelCleanup = false;
      if (missing === "restriction-bounded") final.restrictionProbe.result.bounded_probe_passed = false;
      if (missing === "restriction-cleanup") final.restrictionProbe.result.cleanup_complete = false;
      await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify("FLEUR_SESSION_READY=" + nonce + "\n")});await Bun.write(process.env.FIXTURE_ROOT+'/gate-exercised',${JSON.stringify(missing)});process.stdout.write(${JSON.stringify(JSON.stringify(final))});process.exit(${missing === "exit-envelope" ? 4 : 0});\n`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(await readFile(join(root, "gate-exercised"), "utf8")).toBe(missing);
      expect(exit, stderr + stdout).toBe(missing === "complete" ? 0 : 4);
      expect(JSON.parse(stdout)).toMatchObject(missing === "complete" ? { ok: true, scope: "fresh-linux-session-observation", guest: final } : { ok: false, error: { message: expect.stringContaining("final proof") } });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);
}

test("an SSH session that never starts cannot consume the full guest workflow budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-start-budget-"));
  let sshPid: number | undefined;
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nawait Bun.write(process.env.FIXTURE_ROOT+'/ssh-pid',String(process.pid)+'\\n');setInterval(()=>{},1000);\n`, { mode: 0o700 });
    const started = performance.now();
    const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    sshPid = Number(await readFile(join(root, "ssh-pid"), "utf8"));
    expect(sshPid).toBeGreaterThan(0);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "SESSION_FAILED", message: expect.stringContaining("session start") } });
    expect(performance.now() - started).toBeLessThan(11000);
    expect(() => process.kill(sshPid!, 0)).toThrow();
  } finally {
    if (!sshPid && await Bun.file(join(root, "ssh-pid")).exists()) sshPid = Number(await readFile(join(root, "ssh-pid"), "utf8"));
    reapFixtureGroup(sshPid);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

for (const frame of ["cross-nonce", "duplicate", "malformed", "marker-only"] as const) {
  test(`session-start framing cannot substitute for the exact guest proof: ${frame}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-session-framing-"));
    try {
      const tools = join(root, "tools"); await mkdir(tools);
      const marker = "FLEUR_SESSION_READY=" + nonce + "\n";
      const guest = JSON.stringify({ formatVersion: 1, ok: false, runtimeSupport: "unverified", humanConsentProof: false, installationEvidence: "pending" });
      const stdout = frame === "cross-nonce" ? "FLEUR_SESSION_READY=ffffffff-ffff-ffff-ffff-ffffffffffff\n" + guest : frame === "duplicate" ? marker + marker + guest : frame === "malformed" ? "FLEUR_SESSION_READY?" + nonce + "\n" + guest : marker;
      await writeFile(join(tools, "ssh"), `#!${process.execPath}\nawait Bun.write(process.env.FIXTURE_ROOT+'/framing-exercised',${JSON.stringify(frame)});process.stdout.write(${JSON.stringify(stdout)});process.exit(4);\n`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
      const [output, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(await readFile(join(root, "framing-exercised"), "utf8")).toBe(frame);
      expect(exit, stderr + output).toBe(4);
      expect(JSON.parse(output)).toMatchObject({ scope: "fresh-linux-session-observation", ok: false, error: { code: "SESSION_FAILED" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);
}

test("an owned signal failure stays an incomplete receipt while finally retries and confirms cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-signal-failure-"));
  let sshPid: number | undefined;
  let child: SessionFixtureChild | undefined;
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});await Bun.write(process.env.FIXTURE_ROOT+'/ssh-pid',String(process.pid)+'\\n');setInterval(()=>{},1000);\n`, { mode: 0o700 });
    // External OS signaling boundary; no real ownership/permission is changed.
    await writeFile(join(root, "signal.ts"), `import {existsSync,readFileSync,writeFileSync} from 'node:fs';const root=process.env.FIXTURE_ROOT;const original=process.kill.bind(process);let injected=false;process.kill=((pid,signal)=>{if(!injected&&signal==='SIGKILL'&&existsSync(root+'/ssh-pid')&&pid===-Number(readFileSync(root+'/ssh-pid','utf8'))){injected=true;writeFileSync(root+'/signal-fault',JSON.stringify({pid,signal}));throw Object.assign(new Error('Owned fixture EPERM'),{code:'EPERM'});}return original(pid,signal);});\n`);
    child = Bun.spawn([process.execPath, "--preload", join(root, "signal.ts"), script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
    sshPid = await waitForFixturePid(root);
    child.kill("SIGTERM");
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(await Bun.file(join(root, "signal-fault")).json()).toEqual({ pid: -sshPid, signal: "SIGKILL" });
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "SESSION_FAILED", message: expect.stringContaining("EPERM") } });
    expect(() => process.kill(sshPid!, 0)).toThrow();
  } finally {
    await retireSessionFixture(child, sshPid);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

for (const publication of ["ordinary", "empty-before-pid"] as const) {
test(`session cancellation sends real TERM before escalating to KILL for its ignoring owned SSH group: ${publication}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-term-kill-"));
  let sshPid: number | undefined;
  let child: SessionFixtureChild | undefined;
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';const root=process.env.FIXTURE_ROOT;process.on('SIGTERM',()=>appendFileSync(root+'/term-received','TERM\\n'));${publication === "empty-before-pid" ? "await Bun.write(root+'/ssh-pid','');await Bun.sleep(100);" : ""}await Bun.write(root+'/ssh-pid',String(process.pid)+'\\n');setInterval(()=>{},1000);\n`, { mode: 0o700 });
    // Observe real OS delivery to this exact owned group; never replace its result.
    await writeFile(join(root, "signals.ts"), `import {existsSync,readFileSync,appendFileSync} from 'node:fs';const root=process.env.FIXTURE_ROOT;const original=process.kill.bind(process);process.kill=((pid,signal)=>{const result=original(pid,signal);if((signal==='SIGTERM'||signal==='SIGKILL')&&existsSync(root+'/ssh-pid')&&pid===-Number(readFileSync(root+'/ssh-pid','utf8')))appendFileSync(root+'/signals',JSON.stringify({pid,signal})+'\\n');return result;});\n`);
    child = Bun.spawn([process.execPath, "--preload", join(root, "signals.ts"), script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
    sshPid = await waitForFixturePid(root);
    child.kill("SIGTERM");
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const delivered = (await readFile(join(root, "signals"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { pid: number; signal: string });
    expect(delivered).toEqual([{ pid: -sshPid, signal: "SIGTERM" }, { pid: -sshPid, signal: "SIGKILL" }]);
    expect(await Bun.file(join(root, "term-received")).text()).toBe("TERM\n");
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "SESSION_FAILED" } });
    expect(() => process.kill(sshPid!, 0)).toThrow();
  } finally { await retireSessionFixture(child, sshPid); await rm(root, { recursive: true, force: true }); }
}, 15000);
}

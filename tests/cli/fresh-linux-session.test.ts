import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const script = resolve(import.meta.dir, "../../scripts/observe-fresh-linux-session.ts");
const nonce = "12345678-1234-1234-1234-123456789abc";

// Production command boundary baseline before adding a second-login transition.
// This fixture only supplies SSH protocol results; it claims no image/native proof.
test("session observation preserves the existing incomplete guest report and closes its sole SSH connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-protocol-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const pending = { formatVersion: 1, ok: false, runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline: { packages: "original pristine fixture" } };
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nawait Bun.write(process.env.FIXTURE_ROOT+'/ssh-arguments.json',JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(JSON.stringify(pending))});process.exit(4);\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ formatVersion: 1, scope: "fresh-linux-session-observation", ok: false, guest: pending });
    const args = JSON.parse(await readFile(join(root, "ssh-arguments.json"), "utf8")) as string[];
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("IdentityAgent=none");
    expect(args).toContain("fleur@127.0.0.1");
    expect(args.at(-1)).toBe(`python3 lab/fresh-linux-guest.py ${nonce}`);
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
    expect(calls[1].args.at(-1)).toBe(`python3 lab/fresh-linux-guest.py ${nonce} --resume ${"b".repeat(64)}`);
    expect(exit).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, initialGuest: pending, guest: resumed });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);

test("a successful SSH leader with a surviving owned child cannot authorize a fresh connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-session-survivor-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const pending = { formatVersion: 1, ok: false, phase: "new-login-required", runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline: { packages: "original" }, checkpoint: { sha256: "b".repeat(64), bytes: 800 }, accessHandoff: { after: { user: { name: "fleur", uid: 1000 }, group: { gid: 997 }, accountGroups: [997, 1000], sessionGroups: [1000] } } };
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT;const calls=await Bun.file(root+'/calls').exists()?Number(await Bun.file(root+'/calls').text()):0;await Bun.write(root+'/calls',String(calls+1));if(calls===0){const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});await Bun.write(root+'/survivor',String(child.pid));}process.stdout.write(${JSON.stringify(JSON.stringify(pending))});process.exit(3);\n`, { mode: 0o700 });
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
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nawait Bun.write(process.env.FIXTURE_ROOT+'/ssh-pid',String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
    const stop = performance.now() + 3000;
    while (!await Bun.file(join(root, "ssh-pid")).exists() && performance.now() < stop) await Bun.sleep(10);
    sshPid = Number(await readFile(join(root, "ssh-pid"), "utf8"));
    expect(sshPid).toBeGreaterThan(0);
    child.kill("SIGTERM");
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "SESSION_FAILED" } });
    expect(() => process.kill(sshPid!, 0)).toThrow();
  } finally {
    if (sshPid) { try { process.kill(-sshPid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

for (const scenario of ["pending-exit", "pending-digest", "pending-baseline", "pending-groups", "resume-baseline", "resume-digest", "resume-groups", "resume-phase", "transport-pin"] as const) {
  test(`session orchestration refuses mismatched transport or checkpoint evidence: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-session-binding-"));
    try {
      const tools = join(root, "tools"); await mkdir(tools);
      const baseline = { packages: "original pristine fixture" };
      const pending = { formatVersion: 1, ok: false, phase: "new-login-required", runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline, checkpoint: { sha256: "b".repeat(64), bytes: 800 }, accessHandoff: { after: { user: { name: "fleur", uid: 1000 }, group: { gid: 997 }, accountGroups: [997, 1000], sessionGroups: [1000] } } };
      const resumed = { formatVersion: 1, ok: false, runtimeSupport: "unverified", humanConsentProof: false, installationEvidence: "pending", baseline, accessResume: { checkpointSha256: "b".repeat(64), sessionGroups: [997, 1000] } };
      await writeFile(join(tools, "ssh"), `#!${process.execPath}
const root=process.env.FIXTURE_ROOT;const scenario=${JSON.stringify(scenario)};const file=root+'/calls';const n=await Bun.file(file).exists()?Number(await Bun.file(file).text())+1:1;await Bun.write(file,String(n));
const report=n===1?${JSON.stringify(pending)}:${JSON.stringify(resumed)};let code=n===1?3:4;
if(n===1){if(scenario==='pending-exit')code=0;if(scenario==='pending-digest')report.checkpoint.sha256='wrong';if(scenario==='pending-baseline')delete report.baseline;if(scenario==='pending-groups')report.accessHandoff.after.sessionGroups.push(997);if(scenario==='transport-pin'){process.stderr.write('Host key verification failed.\\n');process.exit(255);}}
else{if(scenario==='resume-baseline')report.baseline={packages:'installed replacement'};if(scenario==='resume-digest')report.accessResume.checkpointSha256='c'.repeat(64);if(scenario==='resume-groups')report.accessResume.sessionGroups=[1000];if(scenario==='resume-phase')report.phase='new-login-required';}
await Bun.write(root+'/fault-exercised',scenario);process.stdout.write(JSON.stringify(report));process.exit(code);
`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr + stdout).toBe(4);
      expect(await readFile(join(root, "calls"), "utf8")).toBe(scenario.startsWith("resume-") ? "2" : "1");
      if (scenario !== "transport-pin") expect(await readFile(join(root, "fault-exercised"), "utf8")).toBe(scenario);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "SESSION_FAILED", message: expect.stringContaining(scenario === "transport-pin" ? "Host key verification failed" : scenario.startsWith("resume-") ? "Resumed ordinary login report differs" : "Intermediate guest handoff is invalid") } });
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
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT;const f=root+'/calls';const n=await Bun.file(f).exists()?Number(await Bun.file(f).text())+1:1;await Bun.write(f,String(n));await Bun.write(root+'/last-pid',String(process.pid));if(n===1){await Bun.write(root+'/clock','899900');process.stdout.write(${JSON.stringify(JSON.stringify(pending))});process.exit(3);}await Bun.write(root+'/clock','900001');setInterval(()=>{},1000);\n`, { mode: 0o700 });
    const started = performance.now();
    const child = Bun.spawn([process.execPath, "--preload", join(root, "clock.ts"), script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
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
    if (lastPid) { try { process.kill(-lastPid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

for (const missing of ["doctor-release", "doctor-daemon", "smoke-cleanup", "repeat", "sentinel-cleanup", "restriction-bounded", "restriction-cleanup", "exit-envelope"] as const) {
  test(`a session report cannot complete without the original final proof gate: ${missing}`, async () => {
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
      await writeFile(join(tools, "ssh"), `#!${process.execPath}\nawait Bun.write(process.env.FIXTURE_ROOT+'/gate-exercised',${JSON.stringify(missing)});process.stdout.write(${JSON.stringify(JSON.stringify(final))});process.exit(${missing === "exit-envelope" ? 4 : 0});\n`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root } });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(await readFile(join(root, "gate-exercised"), "utf8")).toBe(missing);
      expect(exit, stderr + stdout).toBe(4);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining("final proof") } });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);
}

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Protocol fixtures exercise the actual retained-SSH orchestrator, not a native VM.
async function observe(scenario = "valid26") {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary26-session-"));
  try {
    const nonce = "12345678-1234-4234-8234-123456789abc";
    const binding = { nonce, bootId: "87654321-4321-4321-8321-cba987654321", uid: 1000, manifestSha256: "b".repeat(64) };
    const debian = scenario === "debian-ordinary" || scenario.startsWith("valid13");
    const os = { id: debian ? "debian" : "ubuntu", versionId: debian ? "13" : scenario === "valid24" ? "24.04" : "26.04", sha256: "a".repeat(64) };
    const target: Record<string, unknown> = { port: 2222, identity: "key", knownHosts: "pins", nonce, ownedGuestBinding: binding, ownedGuestOsRelease: structuredClone(os) };
    const custody = { ...binding, osRelease: structuredClone(os), formatVersion: 1, scope: "owned-guest-custody-validation", ok: true, fixtureCustodyValidated: true, runtimeSupport: "unverified", runtimeAdmission: false, humanConsentProof: false, nativeCpuPerformanceProof: false };
    const baseline = { packages: "original baseline" };
    const pending = { formatVersion: 1, ok: false, phase: "new-login-required", installationEvidence: "pending", runtimeSupport: "unverified", humanConsentProof: false, baseline, ownedGuestCustody: structuredClone(custody), checkpoint: { sha256: "c".repeat(64), bytes: 800 }, accessHandoff: { after: { user: { name: "fleur", uid: 1000 }, group: { gid: 997 }, accountGroups: [997, 1000], sessionGroups: [1000] } } };
    const qualifiedDebian = scenario.startsWith("valid13");
    const evidence = qualifiedDebian ? "6b4066ed5c199006695d769d07ec5d813fa8cddff1d396a089e1749d6c27231e" : os.versionId === "24.04" ? "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2" : "5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07";
    const release = { state: "verified", profile: `${qualifiedDebian ? "debian" : "ubuntu"}-${os.versionId}-x64-docker-29.9.1`, evidence: { readinessSha256: evidence, isolationSha256: evidence } };
    const envelope = (command: string) => ({ formatVersion: 1, command, ok: true, error: null, truncated: false, data: { components: { cli: { state: "ready" }, daemon: { state: "ready" }, compose: { state: "ready" }, smoke: { state: "ready", cleanup: true }, release: structuredClone(release) } } });
    const final = { formatVersion: 1, ok: true, installationEvidence: "verified-full-system-guest", runtimeSupport: "unverified", humanConsentProof: false, executionArtifact: { kind: "ordinary", packageName: "fleur" }, ownedGuestCustody: structuredClone(custody), baseline, accessResume: { checkpointSha256: "c".repeat(64), sessionGroups: [997, 1000] }, runs: [0, 1].map(() => ({ exitCode: 0, result: envelope("doctor") })), readySetupReprobes: [0, 1].map(() => ({ exitCode: 0, result: envelope("setup"), snapshotPreserved: true, grantsPreserved: true })), sentinelCleanup: true, restrictionProbe: { exitCode: 0, result: { bounded_probe_passed: true, cleanup_complete: true } } };
    if (scenario === "missing-binding") delete target.ownedGuestBinding;
    if (scenario.startsWith("legacy")) delete target.ownedGuestOsRelease;
    if (scenario === "extra-os-field") Object.assign(target.ownedGuestOsRelease as object, { extra: true });
    if (scenario === "unknown-os") target.ownedGuestOsRelease = { ...os, versionId: "27.04" };
    if (scenario === "malformed-os") target.ownedGuestOsRelease = [];
    if (scenario === "invalid-os-hash") target.ownedGuestOsRelease = { ...os, sha256: "not-a-hash" };
    if (scenario === "initial-os-release") pending.ownedGuestCustody.osRelease.versionId = "24.04";
    if (scenario === "initial-os-hash") pending.ownedGuestCustody.osRelease.sha256 = "d".repeat(64);
    if (scenario === "initial-boot") pending.ownedGuestCustody.bootId = "97654321-4321-4321-8321-cba987654321";
    if (scenario === "resumed-os-release") final.ownedGuestCustody.osRelease.versionId = "24.04";
    if (scenario === "resumed-os-hash") final.ownedGuestCustody.osRelease.sha256 = "d".repeat(64);
    if (scenario === "resumed-boot") final.ownedGuestCustody.bootId = "97654321-4321-4321-8321-cba987654321";
    if (scenario === "old-profile" || scenario === "legacy-old-profile") {
      for (const round of final.runs) round.result.data.components.release = { state: "verified", profile: "ubuntu-24.04-x64-docker-29.9.1", evidence: { readinessSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2", isolationSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2" } };
    }
    if (scenario === "crossed-evidence") final.runs[1]!.result.data.components.release.evidence.readinessSha256 = "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2";
    if (scenario === "valid13-crossed-evidence") final.runs[1]!.result.data.components.release.evidence.readinessSha256 = "5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07";
    if (scenario === "valid13-crossed-profile") final.runs[1]!.result.data.components.release.profile = "ubuntu-26.04-x64-docker-29.9.1";
    if (scenario === "valid13-legacy") delete target.ownedGuestOsRelease;
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}
const path=process.env.FIXTURE_ROOT+'/calls.json';const calls=await Bun.file(path).exists()?await Bun.file(path).json():[];
let previousAlive=false;if(calls.length){try{process.kill(calls.at(-1).pid,0);previousAlive=true;}catch{}}
calls.push({pid:process.pid,previousAlive,args:process.argv.slice(2)});await Bun.write(path,JSON.stringify(calls));
process.stdout.write(${JSON.stringify("FLEUR_SESSION_READY=" + nonce + "\n")});process.stdout.write(JSON.stringify(calls.length===1?${JSON.stringify(pending)}:${JSON.stringify(final)}));process.exit(calls.length===1?3:0);
`, { mode: 0o700 });
    const mutate = scenario === "mutate-caller" ? "target.ownedGuestOsRelease.versionId='24.04';target.ownedGuestOsRelease.sha256='f'.repeat(64);target.ownedGuestBinding.bootId='97654321-4321-4321-8321-cba987654321';" : "";
    const entry = `const {observeGuestSessions}=await import(${JSON.stringify(resolve(import.meta.dir, "../../scripts/observe-fresh-linux-session.ts"))});const target=${JSON.stringify(target)};const operation=observeGuestSessions(target);${mutate}const result=await operation;console.log(JSON.stringify(result));process.exit(result.ok?0:4);`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { ...process.env, PATH: tools + ":" + process.env.PATH, FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    return { exit, result: JSON.parse(stdout), calls: await Bun.file(join(root, "calls.json")).exists() ? await Bun.file(join(root, "calls.json")).json() : [] };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test.each(["valid26", "valid24", "valid13", "mutate-caller"])("ordinary host session preserves original OS binding through fresh-login resume: %s", async (scenario) => {
  const observed = await observe(scenario);
  expect(observed.exit, JSON.stringify(observed.result)).toBe(0);
  expect(observed.result.ok).toBe(true);
  expect(observed.calls).toHaveLength(2);
  expect(observed.calls[1].previousAlive).toBe(false);
  expect(observed.calls[1].args.at(-1)).toContain("--resume " + "c".repeat(64));
  expect(observed.result.guest.executionArtifact).toEqual({ kind: "ordinary", packageName: "fleur" });
  expect(observed.result.guest.runs).toHaveLength(2);
  expect(observed.result.guest.readySetupReprobes).toHaveLength(2);
  for (const reprobe of observed.result.guest.readySetupReprobes) expect(reprobe).toMatchObject({ exitCode: 0, result: { ok: true, command: "setup" }, snapshotPreserved: true, grantsPreserved: true });
  expect(observed.result.guest.restrictionProbe).toMatchObject({ exitCode: 0, result: { bounded_probe_passed: true, cleanup_complete: true } });
}, 15000);

for (const [scenario, connections] of [["missing-binding", 0], ["extra-os-field", 0], ["unknown-os", 0], ["malformed-os", 0], ["invalid-os-hash", 0], ["initial-os-release", 1], ["initial-os-hash", 1], ["initial-boot", 1], ["resumed-os-release", 2], ["resumed-os-hash", 2], ["resumed-boot", 2], ["old-profile", 2], ["crossed-evidence", 2], ["legacy26", 1], ["legacy-old-profile", 1]] as const) {
  test(`ordinary host session refuses changed or unbound OS qualification: ${scenario}`, async () => {
    const observed = await observe(scenario);
    expect(observed.exit).toBe(4);
    expect(observed.result.ok).toBe(false);
    expect(observed.calls).toHaveLength(connections);
  }, 15000);
}

test("Debian custody cannot select an Ubuntu ordinary qualification", async () => {
  const observed = await observe("debian-ordinary");
  expect(observed.exit).toBe(4);
  expect(observed.result.ok).toBe(false);
  expect(observed.result.error.message).toContain("Guest final proof lacks exact admitted ordinary doctor rounds");
  expect(observed.calls).toHaveLength(2);
});

test.each(["valid13-crossed-profile", "valid13-crossed-evidence", "valid13-legacy"])("ordinary Debian host session refuses crossed or unbound qualification: %s", async (scenario) => {
  const observed = await observe(scenario);
  expect(observed.exit).toBe(4);
  expect(observed.result.ok).toBe(false);
});

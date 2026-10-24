import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// External SSH protocol only; this does not establish a native Debian result.
async function observe(changed = false) {
  const root = await mkdtemp(join(tmpdir(), "fleur-debian13-session-"));
  try {
    const nonce = "12345678-1234-4234-8234-123456789abc";
    const binding = { nonce, bootId: "87654321-4321-4321-8321-cba987654321", uid: 1000, manifestSha256: "b".repeat(64) };
    const os = { id: "debian", versionId: "13", sha256: "d".repeat(64) };
    const custody = { ...binding, osRelease: os, formatVersion: 1, scope: "owned-guest-custody-validation", ok: true, fixtureCustodyValidated: true, runtimeSupport: "unverified", runtimeAdmission: false, humanConsentProof: false, nativeCpuPerformanceProof: false };
    const baseline = { packages: "original fixture" };
    const pending = { formatVersion: 1, ok: false, phase: "new-login-required", installationEvidence: "pending", runtimeSupport: "unverified", humanConsentProof: false, baseline, ownedGuestCustody: custody, checkpoint: { sha256: "c".repeat(64), bytes: 800 }, accessHandoff: { after: { user: { name: "fleur", uid: 1000 }, group: { gid: 997 }, accountGroups: [997, 1000], sessionGroups: [1000] } } };
    const round = { exitCode: 4, result: { formatVersion: 1, command: "doctor", ok: false, truncated: false, error: { code: "PREREQUISITE_UNAVAILABLE" }, data: { components: { cli: { state: "ready" }, daemon: { state: "ready" }, compose: { state: "ready" }, smoke: { state: "ready", cleanup: true }, release: { state: "unverified" } } } } };
    const final = { formatVersion: 1, ok: true, installationEvidence: "verified-full-system-guest", runtimeSupport: "unverified", humanConsentProof: false, executionArtifact: { kind: "internal-candidate", catalogId: "debian-13-amd64-docker-2026-10-19", catalogSha256: "032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d" }, ownedGuestCustody: structuredClone(custody), baseline, accessResume: { checkpointSha256: "c".repeat(64), sessionGroups: [997, 1000] }, runs: [round, structuredClone(round)], sentinelCleanup: true, restrictionProbe: { exitCode: 0, result: { bounded_probe_passed: true, cleanup_complete: true } } };
    if (changed) final.ownedGuestCustody.osRelease = { id: "ubuntu", versionId: "24.04", sha256: "e".repeat(64) };
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}
const path=process.env.FIXTURE_ROOT+'/calls.json';const calls=await Bun.file(path).exists()?await Bun.file(path).json():[];let previousAlive=false;if(calls.length){try{process.kill(calls.at(-1).pid,0);previousAlive=true;}catch{}}
calls.push({pid:process.pid,previousAlive,args:process.argv.slice(2)});await Bun.write(path,JSON.stringify(calls));process.stdout.write(${JSON.stringify("FLEUR_SESSION_READY=" + nonce + "\n")});process.stdout.write(JSON.stringify(calls.length===1?${JSON.stringify(pending)}:${JSON.stringify(final)}));process.exit(calls.length===1?3:0);
`, { mode: 0o700 });
    const target = { port: 2222, identity: "key", knownHosts: "pins", nonce, ownedGuestBinding: binding, ownedGuestOsRelease: os };
    const entry = `const {observeGuestSessions}=await import(${JSON.stringify(resolve(import.meta.dir, "../../scripts/observe-fresh-linux-session.ts"))});const result=await observeGuestSessions(${JSON.stringify(target)});console.log(JSON.stringify(result));process.exit(result.ok?0:4);`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { ...process.env, PATH: tools + ":" + process.env.PATH, FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    return { exit, result: JSON.parse(stdout), calls: await Bun.file(join(root, "calls.json")).json() };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("internal Debian fresh-login observation preserves two unverified Doctor rounds", async () => {
  const observed = await observe();
  expect(observed.exit, JSON.stringify(observed.result)).toBe(0);
  expect(observed.result.ok).toBe(true);
  expect(observed.calls).toHaveLength(2);
  expect(observed.calls[1].previousAlive).toBe(false);
  expect(observed.calls[1].args.at(-1)).toContain("--resume " + "c".repeat(64));
  expect(observed.result.guest.executionArtifact.catalogId).toBe("debian-13-amd64-docker-2026-10-19");
  expect(observed.result.guest.runs).toHaveLength(2);
  for (const round of observed.result.guest.runs) expect(round).toMatchObject({ exitCode: 4, result: { ok: false, data: { components: { release: { state: "unverified" } } } } });
}, 15000);

test("a fresh login cannot rebind the original Debian OS to Ubuntu", async () => {
  const observed = await observe(true);
  expect(observed.exit).toBe(4);
  expect(observed.result.ok).toBe(false);
  expect(observed.result.error.message).toContain("original owned binding");
  expect(observed.calls).toHaveLength(2);
}, 15000);

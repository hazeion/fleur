import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface DoctorRound {
  exitCode: number;
  result: { formatVersion: number | boolean; command: string; ok: boolean; error: unknown; truncated: boolean; data: { components: Record<string, Record<string, unknown>> } };
}
async function ordinarySession(change?: (round: DoctorRound) => void) {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-session-"));
  try {
    const nonce = "12345678-1234-4234-8234-123456789abc";
    const evidence = "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2";
    const round: DoctorRound = { exitCode: 0, result: { formatVersion: 1, command: "doctor", ok: true, data: { components: { cli: { state: "ready" }, daemon: { state: "ready" }, compose: { state: "ready" }, smoke: { state: "ready", cleanup: true }, release: { state: "verified", profile: "ubuntu-24.04-x64-docker-29.9.1", evidence: { readinessSha256: evidence, isolationSha256: evidence } } } }, error: null, truncated: false } };
    const firstRound = structuredClone(round);
    change?.(round);
    const guest = { formatVersion: 1, ok: true, installationEvidence: "verified-full-system-guest", runtimeSupport: "unverified", humanConsentProof: false, executionArtifact: { kind: "ordinary", packageName: "fleur" }, baseline: { packages: "fixture" }, runs: [firstRound, round], sentinelCleanup: true, restrictionProbe: { exitCode: 0, result: { bounded_probe_passed: true, cleanup_complete: true } } };
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify("FLEUR_SESSION_READY=" + nonce + "\n" + JSON.stringify(guest))});\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-fresh-linux-session.ts"), "--port", "2222", "--identity", "key", "--known-hosts", "pins", "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { ...process.env, PATH: tools + ":" + process.env.PATH } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    return { exit, result: JSON.parse(stdout) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("session proof accepts only the exact admitted ordinary Doctor-zero contract", async () => {
  const observed = await ordinarySession();
  expect(observed.exit).toBe(0);
  expect(observed.result).toMatchObject({ ok: true, guest: { executionArtifact: { kind: "ordinary", packageName: "fleur" } } });
}, 15000);

const evidenceHash = "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2";
const invalidRounds: [string, (round: DoctorRound) => void][] = [
  ["nonzero exit", (round) => { round.exitCode = 4; }],
  ["wrong command", (round) => { round.result.command = "setup"; }],
  ["wrong version", (round) => { round.result.formatVersion = true; }],
  ["false success", (round) => { round.result.ok = false; }],
  ["non-null error", (round) => { round.result.error = { code: "PREREQUISITE_UNAVAILABLE" }; }],
  ["omitted error", (round) => { round.result.error = undefined; }],
  ["truncation", (round) => { round.result.truncated = true; }],
  ["extra envelope field", (round) => { Object.assign(round.result, { profileOverride: "caller" }); }],
  ["missing Compose", (round) => { round.result.data.components.compose!.state = "missing"; }],
  ["missing cleanup", (round) => { round.result.data.components.smoke!.cleanup = false; }],
  ["foreign profile", (round) => { round.result.data.components.release!.profile = "foreign-profile"; }],
  ["crossed readiness proof", (round) => { round.result.data.components.release!.evidence = { readinessSha256: "0".repeat(64), isolationSha256: evidenceHash }; }],
  ["crossed isolation proof", (round) => { round.result.data.components.release!.evidence = { readinessSha256: evidenceHash, isolationSha256: "0".repeat(64) }; }],
];
for (const [name, change] of invalidRounds) {
  test(`one valid ordinary round cannot hide a second ${name}`, async () => {
    const observed = await ordinarySession(change);
    expect(observed.exit).toBe(4);
    expect(observed.result).toMatchObject({ ok: false, error: { code: "SESSION_FAILED" } });
  }, 15000);
}

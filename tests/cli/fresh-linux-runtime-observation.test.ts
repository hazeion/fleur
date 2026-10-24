import { expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

test("Debian candidate tuple observation requires stable identity and coherent sanitized daemon fields", async () => {
  const python = Bun.which("python3");
  expect(python).not.toBeNull();
  const child = Bun.spawn([python!, "-I", resolve(import.meta.dir, "../../scripts/test_debian_daemon_observation.py")], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ stdout, exit }, stderr).toEqual({ stdout: "", exit: 0 });
  expect(stderr).toContain("Ran 4 tests");
});

for (const changed of [false, true]) {
  test(`Debian candidate capture surrounds the full runtime gate and ${changed ? "refuses change" : "preserves repeats"}`, async () => {
    const python = Bun.which("python3");
    expect(python).not.toBeNull();
    const child = Bun.spawn([python!, resolve(import.meta.dir, "fixtures/fresh-linux-repeat.py"), changed ? "debian-observation-changed" : "debian-observation"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    const proof = JSON.parse(stdout);
    expect(proof.doctorCalls).toBe(2);
    expect(proof.restrictionCalls).toBe(1);
    expect(proof.report.candidateDaemonObservation).toMatchObject({ before: { tuple: "same", runtimeAdmission: false }, after: { tuple: changed ? "changed" : "same", runtimeAdmission: false }, stable: !changed });
    expect(proof.report.sentinelCleanup).toBe(true);
    if (changed) expect(proof.report.error).toContain("tuple changed during verification");
    else expect(proof.report.ok).toBe(true);
  });
}

test("unavailable candidate identity observation cannot replace restriction or repeat proof", async () => {
  const python = Bun.which("python3");
  expect(python).not.toBeNull();
  const home = await mkdtemp(join(tmpdir(), "fleur-runtime-observation-"));
  try {
    const child = Bun.spawn([python!, resolve(import.meta.dir, "fixtures/fresh-linux-repeat.py"), "ready"], { env: { ...process.env, HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    const proof = JSON.parse(stdout);
    expect(proof.report.runtimeCandidateObservation).toMatchObject({ scope: "runtime-profile-candidate-observation", accepted: false, custodyVerified: false, runtimeSupport: "unverified", outcome: "unavailable" });
    expect(proof.doctorCalls).toBe(2);
    expect(proof.restrictionCalls).toBe(1);
    expect(proof.report).toMatchObject({ ok: true, runtimeSupport: "unverified", sentinelCleanup: true, restrictionProbe: { exitCode: 0, result: { bounded_probe_passed: true, cleanup_complete: true } } });
  } finally { await rm(home, { recursive: true, force: true }); }
});

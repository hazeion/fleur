import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const script = resolve(import.meta.dir, "../../scripts/verify-fresh-linux.ts");
async function invoke(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, script, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}
test("fresh Linux verifier refuses boot without explicit owned-host authority and invokes no tools", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-fresh-linux-"));
  try {
    const tools = join(scratch, "tools"); await mkdir(tools);
    const touched = join(scratch, "touched");
    for (const tool of ["qemu-img", "qemu-system-x86_64", "ssh", "cloud-localds", "ssh-keygen"]) {
      await writeFile(join(tools, tool), `#!/bin/sh\nprintf called >> '${touched}'\nexit 1\n`, { mode: 0o700 });
    }
    const result = await invoke(["--run", "--image", join(scratch, "image"), "--candidate", join(scratch, "candidate"), "--bun-archive", join(scratch, "bun.zip")], { PATH: tools, HOME: scratch });
    expect(result.exit).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ formatVersion: 1, ok: false, scope: "fresh-full-system-guest", runtimeSupport: "unverified", error: { code: "OWNED_HOST_REQUIRED" }, executed: false });
    expect(await Bun.file(touched).exists()).toBe(false);
    expect(result.stderr).toBe("");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
test("fresh guest verifier rejects altered cloud-image bytes before any VM or image tool opens them", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-fresh-integrity-"));
  try {
    const image = join(scratch, "cloud.img"); await writeFile(image, Buffer.from("QFI\u00fbuntrusted qcow2"));
    const result = await invoke(["--run", "--image", image, "--candidate", join(scratch, "candidate"), "--bun-archive", join(scratch, "bun.zip")], { PATH: scratch, HOME: scratch, FLEUR_OWNED_DISPOSABLE_HOST: "yes" });
    expect(result.exit).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, executed: false, error: { code: "ARTIFACT_MISMATCH" } });
    expect(await readFile(image)).toEqual(Buffer.from("QFI\u00fbuntrusted qcow2"));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
test("capability observation reports missing tools as unavailable and never boots a guest", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-fresh-observe-"));
  try {
    const result = await invoke(["--observe"], { PATH: scratch, HOME: scratch });
    expect(result.exit).toBe(4);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ ok: false, executed: false, error: { code: "INFRASTRUCTURE_UNAVAILABLE" } });
    expect(report.capabilities.tools).toMatchObject({ "qemu-img": false, "qemu-system-x86_64": false, "cloud-localds": false, ssh: false, "ssh-keygen": false, unzip: false });
    expect(report.capabilities.kvmUsable).toBe("unproven-until-boot");
    expect(report.runtimeSupport).toBe("unverified");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
test("guest verifier refuses an unowned host before package, service, or Docker operations", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-unowned-guest-"));
  try {
    const python = Bun.which("python3");
    expect(python).not.toBeNull();
    const child = Bun.spawn([python!, resolve(import.meta.dir, "../../scripts/fresh-linux-guest.py"), "not-an-owned-guest"], { env: { PATH: scratch, HOME: scratch }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, humanConsentProof: false, runtimeSupport: "unverified", error: { code: "GUEST_VERIFICATION_FAILED", message: "Owned guest identity is absent" } });
    expect(stderr).toBe("");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

for (const scenario of ["failed-smoke", "missing-compose", "denied-daemon", "missing-cli", "wrong-command", "wrong-exit", "wrong-error", "wrong-envelope", "truncated", "wrong-ok", "wrong-release", "ready"]) {
  test(`guest repeat proof requires complete doctor readiness and pending-release semantics: ${scenario}`, async () => {
    const python = Bun.which("python3");
    expect(python).not.toBeNull();
    const child = Bun.spawn([python!, resolve(import.meta.dir, "fixtures/fresh-linux-repeat.py"), scenario], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    const proof = JSON.parse(stdout);
    expect(proof.doctorCalls).toBe(2);
    expect(proof.report.sentinelCleanup).toBe(true);
    if (scenario === "ready") {
      expect(proof.report.ok).toBe(true);
      expect(proof.report.installationEvidence).toBe("verified-full-system-guest");
      expect(proof.restrictionCalls).toBe(1);
      expect(proof.report.runs).toHaveLength(2);
    } else {
      expect(proof.report.ok).toBe(false);
      expect(proof.report.installationEvidence).toBe("pending");
      expect(proof.restrictionCalls).toBe(0);
    }
  });
}


test("a nonzero restriction process cannot be promoted by successful proof fields", async () => {
  const python = Bun.which("python3"); expect(python).not.toBeNull();
  const child = Bun.spawn([python!, resolve(import.meta.dir, "fixtures/fresh-linux-repeat.py"), "restriction-exit"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  const proof = JSON.parse(stdout);
  expect(proof.report).toMatchObject({ ok: false, installationEvidence: "pending", sentinelCleanup: true, error: { code: "RESTRICTION_EVIDENCE_REQUIRED" }, restrictionProbe: { exitCode: 1 } });
  expect(proof.restrictionCalls).toBe(1);
  expect(proof.doctorCalls).toBe(2);
});


for (const scenario of ["restriction-false", "restriction-missing", "restriction-malformed", "restriction-cleanup"]) {
  test(`restriction proof must contain true bounded and cleanup results: ${scenario}`, async () => {
    const python = Bun.which("python3"); expect(python).not.toBeNull();
    const child = Bun.spawn([python!, resolve(import.meta.dir, "fixtures/fresh-linux-repeat.py"), scenario], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    const proof = JSON.parse(stdout);
    expect(proof.report).toMatchObject({ ok: false, installationEvidence: "pending", sentinelCleanup: true });
    expect(proof.report.error).toBeDefined();
    expect(proof.restrictionCalls).toBe(1);
    expect(proof.doctorCalls).toBe(2);
    expect(proof.report.runs).toHaveLength(2);
  });
}
test("source-owned compiler input is accepted only as a directory of pinned payloads, and image integrity still precedes boot", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-compiler-host-"));
  try {
    const image = join(scratch, "image"); await writeFile(image, "altered image");
    const result = await invoke(["--run", "--image", image, "--candidate", "source-owned", "--bun-archive", join(scratch, "bun.zip"), "--compiler-debs", join(scratch, "debs")], { PATH: scratch, HOME: scratch, FLEUR_OWNED_DISPOSABLE_HOST: "yes" });
    expect(result.exit).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ executed: false, error: { code: "ARTIFACT_MISMATCH" } });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

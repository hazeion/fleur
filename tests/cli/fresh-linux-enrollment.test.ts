import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the actual guest command separately authorizes Docker enrollment and returns an incomplete stale-login handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-enrollment-protocol-"));
  try {
    const python = Bun.which("python3"); expect(python).not.toBeNull();
    const child = Bun.spawn([python!, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "handoff"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const report = JSON.parse(stdout);
    expect(exit, stderr + "\n" + stdout).toBe(3);
    expect(report).toMatchObject({ formatVersion: 1, ok: false, phase: "new-login-required", installationEvidence: "pending", runtimeSupport: "unverified", humanConsentProof: false });
    expect(report.baseline.packages).toBe("base-files\tfixture\tii \n");
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(state.enrollmentPrompts).toEqual([{ action: "docker-access", target: "Add fleur to Docker group 997: root-equivalent daemon access; plan " + "b".repeat(64), checksum: "b".repeat(64), reply: "once" }]);
    expect(state.installPrompts.some((prompt: { action: string; checksum: string }) => prompt.action === "docker-access" && prompt.checksum === "a".repeat(64))).toBe(true);
    expect(state.staleReprobes).toBe(2);
    expect(state.unexpected).toEqual([]);
    expect(report.checkpoint.sha256).toMatch(/^[a-f0-9]{64}$/);
    const bytes = await Bun.file(join(root, "lab/fresh-linux-state.json")).arrayBuffer();
    expect(Bun.CryptoHasher.hash("sha256", bytes, "hex")).toBe(report.checkpoint.sha256);
    const checkpoint = JSON.parse(Buffer.from(bytes).toString("utf8"));
    expect(checkpoint).toMatchObject({ formatVersion: 1, phase: "new-login-required", nonce: "12345678-1234-1234-1234-123456789abc", bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", uid: state.uid });
    expect(checkpoint.report.baseline).toEqual(report.baseline);
    expect(checkpoint.guestDeadlineMonotonic).toBeGreaterThan(0);
    expect(checkpoint.artifacts.bunArchive.sha256).toBe(Bun.CryptoHasher.hash("sha256", "owned fixture bun.zip", "hex"));
    expect(report.accessHandoff.after.accountGroups).toContain(997);
    expect(report.accessHandoff.after.sessionGroups).not.toContain(997);
    expect(report.runs).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

test("an existing checkpoint blocks the initial guest workflow before installation or enrollment authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-enrollment-state-"));
  try {
    const python = Bun.which("python3"); expect(python).not.toBeNull();
    const child = Bun.spawn([python!, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "existing-checkpoint"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + "\n" + stdout).toBe(4);
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(state.installed).toBe(false);
    expect(state.installPrompts).toEqual([]);
    expect(state.enrollmentPrompts).toEqual([]);
    expect(await Bun.file(join(root, "lab/fresh-linux-state.json")).text()).toBe("foreign checkpoint must survive");
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, installationEvidence: "pending" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

for (const scenario of ["plan-method", "reused-package-plan", "prompt-checksum", "denied-enrollment-outcome", "stale-replayed-plan"] as const) {
  test(`the actual guest command rejects separate enrollment authority failures without replay: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-enrollment-authority-"));
    try {
      const python = Bun.which("python3"); expect(python).not.toBeNull();
      const child = Bun.spawn([python!, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, scenario], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const report = JSON.parse(stdout);
      expect(exit, stderr + "\n" + stdout).toBe(4);
      expect(report).toMatchObject({ ok: false, installationEvidence: "pending", runtimeSupport: "unverified", humanConsentProof: false });
      expect(report.phase).toBeUndefined(); expect(report.checkpoint).toBeUndefined(); expect(report.runs).toHaveLength(0);
      const state = await Bun.file(join(root, "protocol-state.json")).json();
      expect(state.installed, stdout).toBe(true);
      expect(report.reprobe.result.data.plan.action).toBe("docker-access");
      expect(state.unexpected).toEqual([]);
      expect(state.enrollmentOffers ?? []).toHaveLength(["plan-method", "reused-package-plan"].includes(scenario) ? 0 : 1);
      expect(state.enrollmentPrompts).toHaveLength(["denied-enrollment-outcome", "stale-replayed-plan"].includes(scenario) ? 1 : 0);
      expect(state.enrolled).toBe(scenario === "stale-replayed-plan");
      expect(await Bun.file(join(root, "lab/fresh-linux-state.json")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 25000);
}

for (const scenario of ["checkpoint-byte-mutation", "candidate-source-symlink", "candidate-source-mutation", "root-replacement"] as const) {
  test(`the actual guest handoff refuses changed checkpoint or source custody: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-enrollment-custody-"));
    try {
      const python = Bun.which("python3"); expect(python).not.toBeNull();
      const child = Bun.spawn([python!, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, scenario], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const report = JSON.parse(stdout);
      const state = await Bun.file(join(root, "protocol-state.json")).json();
      expect(state.custodyFaultInjected, stderr + "\n" + stdout).toBe(scenario === "checkpoint-byte-mutation" ? "checkpoint" : scenario === "root-replacement" ? "root" : "candidate");
      expect(state.enrollmentPrompts).toHaveLength(1);
      expect(exit, stderr + "\n" + stdout).toBe(4);
      expect(report).toMatchObject({ ok: false, installationEvidence: "pending", runtimeSupport: "unverified" });
      expect(report.phase).toBeUndefined(); expect(report.checkpoint).toBeUndefined();
      if (scenario === "candidate-source-symlink") expect(await Bun.file(join(root, "foreign-source")).text()).toBe("foreign source must survive".padEnd("// Owned protocol fixture, never the real runtime\n".length, "!"));
      if (scenario === "candidate-source-mutation") expect(await Bun.file(join(root, "lab/package/bin/fleur.ts")).text()).toBe("X".repeat("// Owned protocol fixture, never the real runtime\n".length));
      if (scenario === "root-replacement") expect(await Bun.file(join(root, "lab/foreign-marker")).text()).toBe("foreign root must survive");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 25000);
}

test("the actual handoff bounds every candidate entry during enumeration before publishing state", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-enrollment-directory-bound-"));
  try {
    const python = Bun.which("python3"); expect(python).not.toBeNull();
    const child = Bun.spawn([python!, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "directory-bound"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const report = JSON.parse(stdout);
    const witness = await Bun.file(join(root, "enumeration-witness.json")).json();
    expect(witness.distinctValidDirectories).toBe(5001);
    expect(witness.yielded, JSON.stringify({ report, witness })).toBeGreaterThan(0);
    expect(exit, stderr + "\n" + stdout).toBe(4);
    expect(report.error).toMatchObject({ code: "GUEST_VERIFICATION_FAILED", message: "Candidate source entry bound exceeded" });
    expect(witness.yielded).toBeLessThanOrEqual(5000);
    expect(witness.firstDirectoryMetadataAfterYielded).toBeGreaterThan(0);
    expect(witness.firstDirectoryMetadataAfterYielded).toBeLessThanOrEqual(5000);
    expect(witness.enumerationCompleted).toBe(false);
    expect(report).toMatchObject({ ok: false, installationEvidence: "pending" });
    expect(report.phase).toBeUndefined(); expect(report.checkpoint).toBeUndefined();
    expect(await Bun.file(join(root, "lab/fresh-linux-state.json")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

// The second process context is an owned ordinary-session OS protocol fixture;
// it cannot establish the separate host SSH authentication proof.
test("an explicit fresh-session resume preserves the original baseline and reaches doctor without replaying enrollment", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-enrollment-resume-"));
  try {
    const python = Bun.which("python3"); expect(python).not.toBeNull();
    const child = Bun.spawn([python!, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "fresh-resume"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const first = await Bun.file(join(root, "first-session-report.json")).json();
    const report = JSON.parse(stdout);
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(first.phase, stderr + "\n" + stdout).toBe("new-login-required");
    expect(state.freshSession).toBe(true);
    expect(state.enrollmentPrompts).toHaveLength(1);
    expect(state.installPrompts).toHaveLength(7);
    expect(report.baseline).toEqual(first.baseline);
    expect(report.accessResume).toMatchObject({ checkpointSha256: first.checkpoint.sha256, sessionGroups: expect.arrayContaining([state.uid, 27, 997]) });
    expect(report.ordinaryUserDoctorAfterResume.result.command).toBe("doctor");
    // The fixture daemon remains denied: accepting a fresh login alone never
    // manufactures native readiness or skips the existing final proof.
    expect(exit).toBe(4);
    expect(report).toMatchObject({ ok: false, installationEvidence: "pending", runtimeSupport: "unverified", humanConsentProof: false });
    expect(report.runs).toHaveLength(0);
    expect(state.unexpected).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

for (const [scenario, message] of [["resume-stale-session", "Fresh ordinary login identity, groups or installed state differs"], ["resume-wrong-digest", "Resume checkpoint bytes or identity changed"], ["resume-replay", "fresh-linux-resume-started.json"]] as const) {
  test(`the actual guest resume refuses stale, altered or replayed state without reenrollment: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-resume-refusal-"));
    try {
      const python = Bun.which("python3"); expect(python).not.toBeNull();
      const child = Bun.spawn([python!, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, scenario], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const state = await Bun.file(join(root, "protocol-state.json")).json();
      const first = await Bun.file(join(root, "first-session-report.json")).json();
      expect(first.phase).toBe("new-login-required");
      expect(state.freshSession).toBe(scenario !== "resume-stale-session");
      expect(state.enrollmentPrompts).toHaveLength(1);
      expect(state.installPrompts).toHaveLength(7);
      expect(exit, stderr + "\n" + stdout).toBe(4);
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ ok: false, installationEvidence: "pending", runtimeSupport: "unverified", humanConsentProof: false });
      expect(report.error.message).toContain(message);
      expect(report.runs).toHaveLength(0);
      expect(state.unexpected).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 25000);
}

test("the actual resume refuses checkpoint bytes changed during artifact revalidation before claiming or running doctor", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-resume-late-custody-"));
  try {
    const python = Bun.which("python3"); expect(python).not.toBeNull();
    const child = Bun.spawn([python!, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "resume-checkpoint-change"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(state.custodyFaultInjected).toBe("resume-checkpoint");
    expect(state.freshSession).toBe(true);
    expect(state.enrollmentPrompts).toHaveLength(1);
    const report = JSON.parse(stdout);
    expect(exit, stderr + stdout).toBe(4);
    expect(report.accessResume).toBeUndefined();
    expect(report.ordinaryUserDoctorAfterResume).toBeUndefined();
    expect(await Bun.file(join(root, "lab/fresh-linux-resume-started.json")).exists()).toBe(false);
    expect(report.error.message).toContain("Resume checkpoint bytes or identity changed");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

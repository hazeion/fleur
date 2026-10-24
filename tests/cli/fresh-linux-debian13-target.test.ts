import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Actual guest consumer and protected-file policy fixture; no native guest runs.
test("the guest consumes the complete original Debian13 binding before package authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-bound-debian13-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    const child = Bun.spawn([python, "-B", "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "owned13-target-valid"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    const report = JSON.parse(stdout);
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(report.error.message).toContain("TARGET_BOUNDARY_OBSERVED");
    expect(state.targetBoundaryObserved).toBe(true);
    expect(report.ownedGuestCustody).toEqual(state.rootPolicyFrame);
    expect(report.guest.osRelease).toBeNull();
    expect(report.guest.osReleaseEvidence).toEqual({ source: "validated-owned-manifest", ...state.rootPolicyFrame.osRelease });
    expect(state.rootPolicyFrame.osRelease.id).toBe("debian");
    expect(state.rootPolicyFrame.osRelease.versionId).toBe("13");
    expect(report.executionArtifact).toEqual({ kind: "internal-candidate", catalogId: "debian-13-amd64-docker-2026-10-19", catalogSha256: "032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d" });
    expect(report.installationEvidence).toBe("pending");
    expect(report.runtimeSupport).toBe("unverified");
    expect(state.installed).toBe(false);
    expect(state.installPrompts).toEqual([]);
    expect(state.enrollmentPrompts).toEqual([]);
    expect(state.unexpected).toEqual([]);
    expect(await Bun.file(join(root, "lab/fresh-linux-state.json")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

for (const scenario of ["owned13-noble-cross", "owned13-resolute-cross", "owned24-trixie-cross", "owned26-trixie-cross", "owned13-resume-noble", "owned13-resume-resolute", "owned24-resume-trixie", "owned26-resume-trixie"]) {
  test(`guest refuses crossed Debian/Ubuntu candidate authority: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-debian-target-refusal-"));
    try {
      const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
      const child = Bun.spawn([python, "-B", "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, scenario], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: scenario.includes("resume") ? 60000 : 20000 });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr + stdout).toBe(4);
      const report = JSON.parse(stdout);
      const state = await Bun.file(join(root, "protocol-state.json")).json();
      expect(report.ok).toBe(false);
      expect(report.installationEvidence).toBe("pending");
      expect(report.runtimeSupport).toBe("unverified");
      expect(report.error.message).toContain("candidate target");
      expect(report.ownedGuestCustody).toEqual(state.rootPolicyFrame);
      expect(state.unexpected).toEqual([]);
      if (scenario.includes("resume")) {
        expect(state.installed).toBe(true);
        expect(state.enrollmentPrompts).toHaveLength(1);
        expect(state.staleReprobes).toBe(2);
        const first = await Bun.file(join(root, "first-session-report.json")).json();
        expect(first).toMatchObject({ phase: "new-login-required", ok: false, installationEvidence: "pending", runtimeSupport: "unverified" });
        expect(first.ownedGuestCustody).toEqual(state.rootPolicyFrame);
        expect(await Bun.file(join(root, "lab/fresh-linux-resume-started.json")).exists()).toBe(false);
      } else {
        expect(state.installed).toBe(false);
        expect(state.installPrompts).toEqual([]);
        expect(state.enrollmentPrompts).toEqual([]);
        expect(await Bun.file(join(root, "lab/fresh-linux-state.json")).exists()).toBe(false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, scenario.includes("resume") ? 65000 : 25000);
}

test("unchanged Debian13 internal authority survives the actual guest fresh-login resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-debian-resume-positive-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    const child = Bun.spawn([python, "-B", "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "owned13-fresh-resume"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const report = JSON.parse(stdout);
    expect(exit, stderr + stdout).toBe(0);
    const first = await Bun.file(join(root, "first-session-report.json")).json();
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(first).toMatchObject({ phase: "new-login-required", ok: false, installationEvidence: "pending", runtimeSupport: "unverified" });
    expect(report.executionArtifact).toEqual(first.executionArtifact);
    expect(report.executionArtifact.catalogId).toBe("debian-13-amd64-docker-2026-10-19");
    expect(report.ownedGuestCustody).toEqual(first.ownedGuestCustody);
    expect(report.ownedGuestCustody).toEqual(state.rootPolicyFrame);
    expect(report.baseline).toEqual(first.baseline);
    expect(report.accessResume).toMatchObject({ checkpointSha256: first.checkpoint.sha256, sessionGroups: expect.arrayContaining([state.uid, 27, 997]) });
    expect(state.freshSession).toBe(true);
    expect(state.enrollmentPrompts).toHaveLength(1);
    expect(state.installPrompts).toHaveLength(7);
    expect(Object.keys(first.debianDependencyPreservation.observations)).toEqual(["before", "afterInstall"]);
    expect(Object.keys(report.debianDependencyPreservation.observations)).toEqual(["before", "afterInstall", "freshLogin", "afterRuntime"]);
    expect(report.debianDependencyPreservation).toMatchObject({ backend: "nf_tables", cleanup: true, scope: "owned-disconnected-canary-and-nftables-service-only" });
    expect(state.staleReprobes).toBe(2);
    // This is the guest protocol result under simulated external commands, not native installation evidence.
    expect(report).toMatchObject({ ok: true, installationEvidence: "verified-full-system-guest", runtimeSupport: "unverified", humanConsentProof: false, sentinelCleanup: true, restrictionProbe: { exitCode: 0, result: { bounded_probe_passed: true, cleanup_complete: true, v1_gate_passed: false } } });
    expect(report.runs).toHaveLength(2);
    for (const round of [report.ordinaryUserDoctorAfterResume, ...report.runs]) expect(round).toMatchObject({ exitCode: 4, result: { command: "doctor", ok: false, data: { components: { daemon: { state: "ready" }, smoke: { state: "ready", cleanup: true }, release: { state: "unverified" } } } } });
    expect(state.restrictionCalls).toBe(1);
    const observation = report.candidateDaemonObservation;
    expect(observation.stable).toBe(true);
    expect(observation.after).toEqual(observation.before);
    expect(observation.before).toMatchObject({ runtimeAdmission: false, restartContinuityProof: false,
      daemonIdSha256: Bun.CryptoHasher.hash("sha256", "fixture-daemon-id", "hex"),
      info: { KernelVersion: "6.12.113+deb13-cloud-amd64", CgroupDriver: "systemd", CgroupVersion: "2" } });
    expect(JSON.stringify(observation)).not.toContain("private-fixture");
    const capture = [["info", "--format", "{{.ID}}"], ["info", "--format", "{{json .}}"], ["version", "--format", "{{json .Server}}"], ["info", "--format", "{{.ID}}"]];
    expect(state.ordinaryDaemonQueries).toEqual([...capture, ...capture]);
    expect(state.sentinel).toBeUndefined();
    expect(state.unexpected).toEqual([]);
    expect(await Bun.file(join(root, "lab/fresh-linux-resume-started.json")).exists()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 65000);

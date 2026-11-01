import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("ordinary packed guest workflow reads only compiled profile packages before enrollment handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-protocol-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required for actual guest command protocol fixture");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "ordinary-handoff"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(3);
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({ ok: false, phase: "new-login-required", executionArtifact: { kind: "ordinary", packageName: "fleur" } });
    expect(await Bun.file(join(root, "lab/package/internal-native-candidate.json")).exists()).toBe(false);
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(state.simulationArguments).toEqual(["--simulate", "--no-install-recommends", "--no-remove", "--no-upgrade", "install", "docker-ce=5:29.9.1-1~ubuntu.24.04~noble", "docker-ce-cli=5:29.9.1-1~ubuntu.24.04~noble", "containerd.io=2.4.2-2~ubuntu.24.04~noble", "docker-buildx-plugin=0.38.0-1~ubuntu.24.04~noble", "docker-compose-plugin=5.6.0-1~ubuntu.24.04~noble"]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

test("ordinary admission metadata mismatch is refused before any setup authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-invalid-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "ordinary-invalid-evidence"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout).error.message).toContain("ordinary profile evidence differs");
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(state.installed).toBe(false);
    expect(state.installPrompts).toEqual([]);
    expect(state.enrollmentPrompts).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

test("ordinary admitted Doctor zero preserves both smoke rounds and the original restriction gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-admitted-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "ordinary-admitted"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({ ok: true, runtimeSupport: "unverified", humanConsentProof: false, sentinelCleanup: true, restrictionProbe: { exitCode: 0, result: { bounded_probe_passed: true, cleanup_complete: true, v1_gate_passed: false } } });
    expect(report.runs).toHaveLength(2);
    for (const run of report.runs) expect(run).toMatchObject({ exitCode: 0, result: { command: "doctor", ok: true, error: null, truncated: false, data: { components: { release: { state: "verified", floor: "ubuntu-x64-engine", admission: "measured", measuredRows: ["ubuntu-24.04-x64-docker-29.9.1", "ubuntu-26.04-x64-docker-29.9.1"], evidence: { readinessSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2", isolationSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2" } } } } } });
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(state.restrictionCalls).toBe(1);
    expect(state.unexpected).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

test("ordinary ready setup reprobes perform no new authority or package work", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-reprobe-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "ordinary-admitted"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(0);
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(state.ordinaryReadySetupCalls).toBe(3);
    expect(state.installPrompts).toHaveLength(7);
    expect(state.enrollmentPrompts).toEqual([]);
    const report = JSON.parse(stdout);
    expect(report.readySetupReprobes).toHaveLength(2);
    for (const proof of report.readySetupReprobes) expect(proof).toMatchObject({ exitCode: 0, snapshotPreserved: true, grantsPreserved: true, result: { command: "setup", ok: true, error: null } });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

test("ready setup grant mutation invalidates proof and preserves the changed file", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-grant-change-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "ordinary-admitted-grant-change"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    const report = JSON.parse(stdout);
    expect(report.error.message).toContain("ready setup reprobe changed state");
    expect(report.readySetupReprobes[0]).toMatchObject({ exitCode: 0, snapshotPreserved: true, grantsPreserved: false });
    expect(report.sentinelCleanup).toBe(true);
    expect(await Bun.file(join(root, ".local/state/fleur/setup/grants.json")).text()).toBe('{"fixtureForeignGrant":true}');
    expect((await Bun.file(join(root, "protocol-state.json")).json()).restrictionCalls).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

test("ordinary proof records bounded daemon capability version and driver fields without raw metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-daemon-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "ordinary-admitted"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(0);
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(state.ordinaryDaemonQueries).toEqual([["info", "--format", "{{json .}}"], ["version", "--format", "{{json .Server}}"]]);
    const observation = JSON.parse(stdout).ordinaryDaemonObservation;
    expect(observation).toMatchObject({ scope: "ordinary-daemon-readiness-observation", runtimeAdmission: false, info: { ServerVersion: "29.9.1", Driver: "overlayfs", SecurityOptions: ["name=apparmor,profile=default", "name=seccomp,profile=builtin", "name=cgroupns"], MemoryLimit: true, SwapLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true, PidsLimit: true }, server: { Version: "29.9.1", GitCommit: "b26fb77", Platform: { Name: "Docker Engine - Community" } } });
    expect(JSON.stringify(observation)).not.toContain("private-fixture");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

for (const category of ["duplicate", "mixed", "malformed", "unknown", "apparmor-custom", "apparmor-unconfined", "apparmor-docker-default"]) {
  test(`ordinary daemon ${category} security options remain unavailable and redacted`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-security-"));
    try {
      const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
      const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "ordinary-admitted-security-" + category], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr + stdout).toBe(4);
      const report = JSON.parse(stdout);
      expect(report.error.message).toContain("security option observation is unavailable");
      expect(report.ordinaryDaemonObservation).toMatchObject({ runtimeAdmission: false, info: { Driver: "overlayfs" }, server: { Version: "29.9.1" }, securityOptionsEvidence: { state: "unavailable", category: category === "mixed" ? "duplicate" : category.startsWith("apparmor-") ? "unknown" : category } });
      expect(report.ordinaryDaemonObservation.info.SecurityOptions).toBeUndefined();
      expect(JSON.stringify(report.ordinaryDaemonObservation)).not.toContain("private-fixture");
      expect((await Bun.file(join(root, "protocol-state.json")).json()).restrictionCalls).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 25000);
}

test("known daemon security observations survive a later Doctor release refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-refused-release-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "ordinary-admitted-release-refused"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    const report = JSON.parse(stdout);
    expect(report.ordinaryDaemonObservation).toMatchObject({ info: { SecurityOptions: ["name=apparmor,profile=default", "name=seccomp,profile=builtin", "name=cgroupns"] }, securityOptionsEvidence: { state: "recorded", operatingMode: "rootful" } });
    expect(report.error.message).toContain("Repeat ordinary-user smoke");
    expect(report.sentinelCleanup).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

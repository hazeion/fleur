import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// External command/OS adapters exercise the real verifier; these are not native proofs.
async function observe(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary13-protocol-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python is required");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, scenario], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: scenario === "ordinary-admitted13" ? 60000 : 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit, state: await Bun.file(join(root, "protocol-state.json")).json() };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("ordinary Debian proof retains eight packages, fresh login, canary, two admitted rounds and full restrictions", async () => {
  const { stdout, stderr, exit, state } = await observe("ordinary-admitted13");
  expect(exit, stderr + stdout).toBe(0);
  const report = JSON.parse(stdout);
  expect(report).toMatchObject({ ok: true, executionArtifact: { kind: "ordinary", packageName: "fleur", artifactCatalogSha256: "032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d" }, sentinelCleanup: true, restrictionProbe: { exitCode: 0, result: { bounded_probe_passed: true, cleanup_complete: true } }, debianDependencyPreservation: { backend: "nf_tables", cleanup: true } });
  expect(report.runs).toHaveLength(2);
  for (const round of report.runs) expect(round).toMatchObject({ exitCode: 0, result: { command: "doctor", ok: true, error: null, data: { components: { release: { state: "verified", floor: "debian-x64-engine", admission: "measured", measuredRows: ["debian-13-x64-docker-29.9.1"] }, smoke: { cleanup: true } } } } });
  expect(report.readySetupReprobes).toHaveLength(2);
  for (const round of report.readySetupReprobes) expect(round).toMatchObject({ exitCode: 0, snapshotPreserved: true, grantsPreserved: true });
  expect(state.simulationArguments.slice(5)).toEqual(["docker-ce=5:29.9.1-1~debian.13~trixie", "docker-ce-cli=5:29.9.1-1~debian.13~trixie", "containerd.io=2.4.2-2~debian.13~trixie", "docker-buildx-plugin=0.38.0-1~debian.13~trixie", "docker-compose-plugin=5.6.0-1~debian.13~trixie", "libjansson4=2.14-2+b3", "libnftables1=1.1.3-1", "nftables=1.1.3-1"]);
  expect(state.freshSession).toBe(true);
  expect(state.canaryPhases).toEqual(["before", "afterInstall", "freshLogin", "afterRuntime", "cleanup"]);
  expect(state.restrictionCalls).toBe(1);
  expect(state.unexpected).toEqual([]);
}, 65000);

test.each(["missing-dependency", "artifact-hash", "dependency-version"])("ordinary Debian %s metadata refuses before setup authority", async (kind) => {
  const { stdout, stderr, exit, state } = await observe("ordinary-admitted13-" + kind);
  expect(exit, stderr + stdout).toBe(4);
  expect(JSON.parse(stdout).error.message).toBe("Compiled ordinary Debian dependency closure differs");
  expect(state.installed).toBe(false);
  expect(state.installPrompts).toEqual([]);
  expect(state.restrictionCalls).toBeUndefined();
}, 25000);

test("duplicate ordinary metadata cannot be normalized into a matching profile", async () => {
  const { stdout, stderr, exit, state } = await observe("ordinary-admitted13-duplicate-field");
  expect(exit, stderr + stdout).toBe(4);
  expect(JSON.parse(stdout).error.message).toBe("Compiled ordinary profile contains duplicate fields");
  expect(state.installed).toBe(false);
  expect(state.installPrompts).toEqual([]);
}, 25000);

test.each([["canary", "Owned detached canary differs"], ["service", "nftables service execution or state differs"]])("ordinary Debian %s preservation failure remains a semantic failure", async (kind, message) => {
  const { stdout, stderr, exit, state } = await observe("ordinary-admitted13-" + kind);
  expect(exit, stderr + stdout).toBe(4);
  expect(JSON.parse(stdout).error.message).toBe(message);
  expect(state.restrictionCalls).toBeUndefined();
}, 25000);

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
async function observe(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary26-protocol-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python is required");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, scenario], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (stderr) throw new Error(stderr);
    return { exit, report: JSON.parse(stdout), state: await Bun.file(join(root, "protocol-state.json")).json() };
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("ordinary Ubuntu 26 guest verification keeps exact Resolute packages, two admitted smoke rounds and full restrictions", async () => {
  const { exit, report, state } = await observe("ordinary-admitted26");
    expect(exit).toBe(0);
    expect(report).toMatchObject({ ok: true, executionArtifact: { kind: "ordinary", artifactCatalogSha256: "e1d4756d2b9d6ce7dfccff783bb64e50bde09be1c36a8c36f1a2d4577937eb3a" }, sentinelCleanup: true, restrictionProbe: { exitCode: 0, result: { bounded_probe_passed: true, cleanup_complete: true } } });
    expect(report.runs).toHaveLength(2);
    for (const round of report.runs) expect(round).toMatchObject({ exitCode: 0, result: { command: "doctor", ok: true, data: { components: { release: { state: "verified", profile: "ubuntu-26.04-x64-docker-29.9.1" } } } } });
    expect(state.simulationArguments).toContain("docker-ce=5:29.9.1-1~ubuntu.26.04~resolute");
    expect(state.simulationArguments.join(" ")).not.toContain("noble");
    expect(state.restrictionCalls).toBe(1);
    expect(state.unexpected).toEqual([]);
}, 25000);
test.each(["os-cross", "invalid-evidence", "duplicate", "foreign-row", "unknown-target"])("ordinary Ubuntu 26 %s metadata refuses before setup authority", async (kind) => {
  const { exit, report, state } = await observe("ordinary-admitted26-" + kind);
    expect(exit).toBe(4);
    expect(report.ok).toBe(false);
    expect(state.installed).toBe(false);
    expect(state.installPrompts).toEqual([]);
    expect(state.enrollmentPrompts).toEqual([]);
    expect(state.restrictionCalls).toBeUndefined();
}, 25000);

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";

for (const architecture of ["x64", "arm64"] as const) {
  test(`ordinary default catalog ${architecture === "x64" ? "offers separately scoped Intel Desktop placement" : "retains the unverified ARM boundary"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-desktop-"));
    const applications = join(root, "Applications");
    await mkdir(applications);
    const calls: string[][] = [];
    try {
      const result = await runCli(["setup", "--json"], { cwd: root, handlers: setupCommands({
        stateDirectory: join(root, "state"), desktopApplicationsDirectory: applications,
        host: async () => ({ system: "darwin", architecture, translated: false, release: "15.7.7", machineId: "a".repeat(64) }),
        run: async (args) => { calls.push([...args]); return { status: "missing", stdout: "", stderr: "" }; },
      }) });
      expect(result.exitCode).toBe(3);
      expect(result.result.error?.code).toBe(architecture === "x64" ? "AUTHORITY_REQUIRED" : "HUMAN_ACTION_REQUIRED");
      if (architecture === "x64") expect(result.result.data).toMatchObject({ plan: { method: "docker-desktop-official-dmg", artifactAuthentication: "authenticated", nativeEvidence: "verified", requiredAuthorities: ["image-acquire", "install"] } });
      expect(calls).toEqual([["docker", "--version"]]);
      expect(await readdir(applications)).toEqual([]);
      expect(await Bun.file(join(root, "state", "grants.json")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("Desktop source authority is immutable and binds placement evidence to the exact artifact and host", async () => {
  const { admitDesktopCatalog } = await import("../../src/setup/verified-desktop-profiles.ts");
  const original = (await import("../../src/setup/verified-desktop-profiles.json")).default;
  const records = admitDesktopCatalog(structuredClone(original));
  expect(records).toHaveLength(1);
  const record = records[0]!;
  expect(record.profile).toMatchObject({ release: "15.7.7", architecture: "x64", version: "4.96.1", build: "244132", bytes: 659125733, nativeEvidence: "verified" });
  expect(record.evidence.runtimeReadinessAdmission).toBe(false);
  expect([records, record, record.profile, record.evidence, record.evidence.host, record.evidence.artifact, record.evidence.placementReportSha256s].every(Object.isFrozen)).toBe(true);
  const cases: ((value: typeof original) => void)[] = [
    (value) => { value.formatVersion = 2; },
    (value) => { value.entries.push(structuredClone(value.entries[0]!)); },
    (value) => { value.entries[0]!.profile.nativeEvidence = "pending"; },
    (value) => { value.entries[0]!.profile.architecture = "arm64"; },
    (value) => { value.entries[0]!.profile.url = "https://example.com/Docker.dmg"; },
    (value) => { value.entries[0]!.profile.release = "12.0"; },
    (value) => { value.entries[0]!.profile.bytes += 1; },
    (value) => { value.entries[0]!.profile.version = "4.96.2"; },
    (value) => { value.entries[0]!.profile.teamId = "OTHER"; },
    (value) => { value.entries[0]!.evidence.sourceCommit = "unproven"; },
    (value) => { value.entries[0]!.evidence.planSha256 = "unproven"; },
    (value) => { value.entries[0]!.evidence.artifactReportSha256 = "unproven"; },
    (value) => { value.entries[0]!.evidence.runtimeReadinessAdmission = true; },
    (value) => { value.entries[0]!.evidence.host.architecture = "arm64"; },
    (value) => { value.entries[0]!.evidence.placementReportSha256s.pop(); },
    (value) => { value.entries[0]!.evidence.placementReportSha256s[1] = value.entries[0]!.evidence.placementReportSha256s[0]!; },
    (value) => { Object.assign(value.entries[0]!.profile, { extraAuthority: true }); },
    (value) => { Object.assign(value.entries[0]!.evidence, { extraAuthority: true }); },
  ];
  for (const alter of cases) {
    const changed = structuredClone(original);
    alter(changed);
    expect(admitDesktopCatalog(changed)).toEqual([]);
  }
  expect(admitDesktopCatalog(original)[0]!.profile).toEqual(record.profile);
});

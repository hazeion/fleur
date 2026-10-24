import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileApt } from "../../src/setup/apt-recovery.ts";
import { AptInspectionRequired } from "../../src/setup/apt-auxiliary.ts";
import { aptCacheArchiveFilename, aptPackageArtifacts, aptPackageVersions, aptPlanTarget } from "../../src/setup/apt-dependencies.ts";
import type { HostIdentity, SetupHost } from "../../src/setup/commands.ts";
import { aptFixtureBytes } from "./fixtures/apt-artifacts.ts";
import { debianDependencyProfile } from "./fixtures/apt-debian-dependencies.ts";

// Real retained files and the actual reconciler. Host protocol data is synthetic;
// the injected auxiliary boundary represents unreadable Linux _apt-owned dirs.
async function scenario(locks: "clear" | "busy" | "unknown" = "clear", badControlMode = false) {
  const root = await mkdtemp(join(tmpdir(), "fleur-debian-reconcile-contract-"));
  const uid = process.getuid!();
  try {
    const directory = join(root, "state"); await mkdir(directory, { mode: 0o700 });
    const stageName = "apt-payloads-Native13";
    const stage = join(directory, stageName);
    const entries: Record<string, unknown>[] = [];
    const directories = new Map([[".", 0o700], ["archives", 0o700], ["archives/partial", 0o700], ["local-lists", 0o755], ["local-lists/auxfiles", 0o755], ["local-only.parts", 0o700]]);
    for (const name of Object.keys(aptPackageArtifacts(debianDependencyProfile))) directories.set(name, 0o700);
    for (const [path, mode] of directories) {
      await mkdir(join(stage, path), { recursive: true, mode }); await chmod(join(stage, path), mode);
      const info = await lstat(join(stage, path), { bigint: true });
      entries.push({ path, dev: String(info.dev), ino: String(info.ino), directory: true, uid, mode, auxiliary: ["archives/partial", "local-lists/auxfiles"].includes(path) });
    }
    const files = new Map<string, { body: Uint8Array; mode: number }>([
      ["archives/lock", { body: Buffer.from(""), mode: 0o600 }], ["local-only.list", { body: Buffer.from(""), mode: 0o600 }],
      ["local-only.conf", { body: Buffer.from("#clear APT::Sources::With;\n"), mode: badControlMode ? 0o644 : 0o600 }],
      ["apt-plan.json", { body: Buffer.from('{"fixture":"retained authenticated plan"}'), mode: 0o600 }],
    ]);
    for (const [name, artifact] of Object.entries(aptPackageArtifacts(debianDependencyProfile))) {
      const body = aptFixtureBytes(name, artifact.version);
      const cacheName = aptCacheArchiveFilename(artifact);
      files.set(name + "/" + cacheName, { body, mode: Object.hasOwn(debianDependencyProfile.packages, name) ? 0o644 : 0o600 });
      files.set("archives/" + cacheName, { body, mode: 0o600 });
    }
    for (const [path, { body, mode }] of files) {
      await writeFile(join(stage, path), body, { mode }); await chmod(join(stage, path), mode);
      const info = await lstat(join(stage, path), { bigint: true });
      entries.push({ path, dev: String(info.dev), ino: String(info.ino), directory: false, uid, mode, auxiliary: false, size: body.byteLength, sha256: Bun.CryptoHasher.hash("sha256", body, "hex") });
    }
    const identity: HostIdentity = { system: "linux", architecture: "x64", translated: false, distribution: "debian", release: "13", machineId: "a".repeat(64), bootId: "22222222-2222-4222-8222-222222222222" };
    const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify(debianDependencyProfile), "hex");
    const target = aptPlanTarget(debianDependencyProfile, checksum);
    const authority = ["install", "configuration", "docker-access", "service-start", "service-enable"].map((action) => ({ id: crypto.randomUUID(), action, method: "docker-official-apt", target, planChecksum: checksum, machine: identity.machineId, user: uid, mode: "once", revoked: true }));
    const pending = { formatVersion: 2, operationId: crypto.randomUUID(), action: "install", method: "docker-official-apt", machine: identity.machineId, user: uid, bootId: "11111111-1111-4111-8111-111111111111", checksum, target, authority, artifacts: { root: stageName, entries } };
    const pendingBytes = JSON.stringify(pending), grantsBytes = JSON.stringify({ formatVersion: 1, grants: authority });
    await writeFile(join(directory, "apt-transaction-pending.json"), pendingBytes, { mode: 0o600 });
    await writeFile(join(directory, "grants.json"), grantsBytes, { mode: 0o600 });
    const inventory = Object.entries(aptPackageVersions(debianDependencyProfile)).map(([name, version]) => `${["libjansson4", "libnftables1"].includes(name) ? name + ":amd64" : name}\t${version}\tinstalled\tok\n`).join("");
    const calls: string[][] = []; let auxiliaryRetentions = 0; let privilegedReads = 0;
    const host: SetupHost = {
      stateDirectory: directory, host: async () => identity, aptPackageLocks: async () => locks,
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "dpkg-query") return { status: "completed", exitCode: 0, stdout: inventory, stderr: "" };
        if (args[0] === "apt-config" && args[1] === "dump") return { status: "completed", exitCode: 0, stdout: 'APT::Architecture "amd64";\n', stderr: "" };
        throw new Error("Unexpected recovery command: " + args[0]);
      },
      aptAuxiliaries: async (_directory, manifest) => {
        auxiliaryRetentions++;
        return { request: { formatVersion: 1, scope: "fixed-two-apt-auxiliaries", aptUid: 42, directories: manifest.entries.filter((entry) => entry.auxiliary).map((entry) => ({ ...entry, uid: 42 })) }, inspectorSha256: "b".repeat(64), unchanged: async () => {}, close: async () => {}, inspect: async () => { privilegedReads++; throw new Error("No inspection authority"); } };
      },
    };
    let failure: unknown;
    try { await reconcileApt(host, identity, debianDependencyProfile, () => 10000, { args: [], project: root, timeoutSeconds: 10, json: true }); }
    catch (error) { failure = error; }
    const artifactBytesPreserved = await Promise.all([...files].map(async ([path, original]) => Buffer.compare(await readFile(join(stage, path)), original.body) === 0));
    return { failure, calls, auxiliaryRetentions, privilegedReads, pendingBefore: pendingBytes, pendingAfter: await readFile(join(directory, "apt-transaction-pending.json"), "utf8"), grantsBefore: grantsBytes, grantsAfter: await readFile(join(directory, "grants.json"), "utf8"), artifactBytesPreserved, stateEntries: await readdir(directory), artifactCount: Object.keys(aptPackageArtifacts(debianDependencyProfile)).length };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("actual Debian reconciliation reaches separate inspection authority for eight native-shaped retained packages", async () => {
  const result = await scenario();
  expect(result.artifactCount).toBe(8);
  expect(result.failure).toBeInstanceOf(AptInspectionRequired);
  const failure = result.failure as AptInspectionRequired;
  expect(failure.outcome).toMatchObject({ exitCode: 3, result: { error: { code: "AUTHORITY_REQUIRED" }, data: { resumable: true, grantsCreated: false, plan: { action: "recovery-inspect" } } } });
  expect(result.auxiliaryRetentions).toBe(1);
  expect(result.privilegedReads).toBe(0);
  expect(result.pendingAfter).toBe(result.pendingBefore);
  expect(result.grantsAfter).toBe(result.grantsBefore);
  expect(result.artifactBytesPreserved.every(Boolean)).toBe(true);
  expect(result.calls.every((args) => ["dpkg-query", "apt-config"].includes(args[0]!))).toBe(true);
});

test("Debian recovery still refuses a public control file even when source downloads are public", async () => {
  const result = await scenario("clear", true);
  expect(result.failure).not.toBeInstanceOf(AptInspectionRequired);
  expect(result.failure).toBeInstanceOf(Error);
  expect(result.calls).toEqual([]);
  expect(result.auxiliaryRetentions).toBe(0);
  expect(result.pendingAfter).toBe(result.pendingBefore);
  expect(result.grantsAfter).toBe(result.grantsBefore);
});

for (const locks of ["busy", "unknown"] as const) {
  test(`Debian recovery preserves all retained evidence when package locks are ${locks}`, async () => {
    const result = await scenario(locks);
    expect(result.failure).not.toBeInstanceOf(AptInspectionRequired);
    expect(result.failure).toBeInstanceOf(Error);
    expect(result.calls).toEqual([]);
    expect(result.auxiliaryRetentions).toBe(0);
    expect(result.pendingAfter).toBe(result.pendingBefore);
    expect(result.grantsAfter).toBe(result.grantsBefore);
  });
}

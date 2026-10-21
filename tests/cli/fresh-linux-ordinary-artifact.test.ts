import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectVerificationArtifact } from "../../scripts/verify-fresh-linux.ts";

test("ordinary source selection executes authenticated ordinary bytes under the legacy transport name", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-artifact-"));
  try {
    const directory = join(root, "build"); await mkdir(directory, { mode: 0o700 });
    const staging = join(root, "stage"); await mkdir(staging, { mode: 0o700 });
    const ordinary = Buffer.from("ordinary packed source bytes");
    const candidate = Buffer.from("different internal candidate bytes");
    await writeFile(join(directory, "fleur-ordinary.tgz"), ordinary);
    await writeFile(join(directory, "fleur-internal-native-candidate.tgz"), candidate);
    const built = { ordinary: { filename: "fleur-ordinary.tgz", sha256: Bun.CryptoHasher.hash("sha256", ordinary, "hex") }, candidate: { filename: "fleur-internal-native-candidate.tgz", sha256: Bun.CryptoHasher.hash("sha256", candidate, "hex") } };
    const selected = await selectVerificationArtifact(directory, built, "ordinary-source-owned", staging);
    expect(selected.kind).toBe("ordinary");
    expect(selected.path).toEndWith("/fleur-internal-native-candidate.tgz");
    expect(selected.path).not.toBe(join(directory, "fleur-internal-native-candidate.tgz"));
    expect(selected.sha256).toBe(built.ordinary.sha256);
    expect(await readFile(selected.path)).toEqual(ordinary);
    expect(await readFile(join(directory, "fleur-internal-native-candidate.tgz"))).toEqual(candidate);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function artifactFixture(action: (input: { directory: string; staging: string; root: string; ordinary: Buffer<ArrayBuffer>; candidate: Buffer<ArrayBuffer>; built: { ordinary: { filename: string; sha256: string }; candidate: { filename: string; sha256: string } } }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "fleur-ordinary-refusal-"));
  try {
    const directory = join(root, "build"); await mkdir(directory, { mode: 0o700 });
    const staging = join(root, "stage"); await mkdir(staging, { mode: 0o700 });
    const ordinary = Buffer.from("ordinary source archive"); const candidate = Buffer.from("internal source archive");
    await writeFile(join(directory, "fleur-ordinary.tgz"), ordinary); await writeFile(join(directory, "fleur-internal-native-candidate.tgz"), candidate);
    const built = { ordinary: { filename: "fleur-ordinary.tgz", sha256: Bun.CryptoHasher.hash("sha256", ordinary, "hex") }, candidate: { filename: "fleur-internal-native-candidate.tgz", sha256: Bun.CryptoHasher.hash("sha256", candidate, "hex") } };
    await action({ directory, staging, root, ordinary, candidate, built });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("legacy internal selection retains its exact archive and creates no ordinary staging", async () => {
  await artifactFixture(async ({ directory, staging, candidate, built }) => {
    const selected = await selectVerificationArtifact(directory, built, "source-owned", staging);
    expect(selected).toEqual({ kind: "internal-candidate", path: join(directory, "fleur-internal-native-candidate.tgz"), sha256: built.candidate.sha256 });
    expect(await readFile(selected.path)).toEqual(candidate);
    expect(await Bun.file(join(staging, "ordinary-execution/fleur-internal-native-candidate.tgz")).exists()).toBe(false);
  });
});

test("ordinary hash drift removes only the newly created failed staging output", async () => {
  await artifactFixture(async ({ directory, staging, built }) => {
    await writeFile(join(directory, "fleur-ordinary.tgz"), "changed bytes");
    await expect(selectVerificationArtifact(directory, built, "ordinary-source-owned", staging)).rejects.toMatchObject({ code: "ARTIFACT_MISMATCH", artifactCleanupConfirmed: true });
    expect(await Bun.file(join(staging, "ordinary-execution/fleur-internal-native-candidate.tgz")).exists()).toBe(false);
    expect(await readFile(join(directory, "fleur-ordinary.tgz"), "utf8")).toBe("changed bytes");
  });
});

test("ordinary source symlink is refused even when its target has the expected hash", async () => {
  const { unlink, symlink } = await import("node:fs/promises");
  await artifactFixture(async ({ directory, staging, root, ordinary, built }) => {
    const target = join(root, "foreign.tgz"); await writeFile(target, ordinary);
    await unlink(join(directory, "fleur-ordinary.tgz")); await symlink(target, join(directory, "fleur-ordinary.tgz"));
    await expect(selectVerificationArtifact(directory, built, "ordinary-source-owned", staging)).rejects.toMatchObject({ artifactCleanupConfirmed: true });
    expect(await readFile(target)).toEqual(ordinary);
    expect(await Bun.file(join(staging, "ordinary-execution/fleur-internal-native-candidate.tgz")).exists()).toBe(false);
  });
});

test("ordinary staging refuses occupied names and preserves the foreign archive", async () => {
  await artifactFixture(async ({ directory, staging, built }) => {
    const occupied = join(staging, "ordinary-execution"); await mkdir(occupied, { mode: 0o700 });
    const archive = join(occupied, "fleur-internal-native-candidate.tgz"); await writeFile(archive, "foreign archive");
    await expect(selectVerificationArtifact(directory, built, "ordinary-source-owned", staging)).rejects.toThrow();
    expect(await readFile(archive, "utf8")).toBe("foreign archive");
  });
});

test("ordinary staging rejects a symlink parent without modifying its target", async () => {
  const { symlink, readdir } = await import("node:fs/promises");
  await artifactFixture(async ({ directory, root, built }) => {
    const foreign = join(root, "foreign"); await mkdir(foreign, { mode: 0o700 });
    const alias = join(root, "staging-alias"); await symlink(foreign, alias);
    await expect(selectVerificationArtifact(directory, built, "ordinary-source-owned", alias)).rejects.toThrow();
    expect(await readdir(foreign)).toEqual([]);
  });
});

test("artifact selection rejects unknown modes or builder filename substitution", async () => {
  await artifactFixture(async ({ directory, staging, built }) => {
    await expect(selectVerificationArtifact(directory, built, "caller-archive", staging)).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });
    await expect(selectVerificationArtifact(directory, { ...built, ordinary: { ...built.ordinary, filename: "../foreign.tgz" } }, "ordinary-source-owned", staging)).rejects.toMatchObject({ code: "ARTIFACT_MISMATCH" });
  });
});

for (const mode of ["directory-swap", "copied-byte-change"]) {
  test(`ordinary staging refuses real ${mode} at the filesystem observation boundary`, async () => {
    const { resolve } = await import("node:path");
    await artifactFixture(async ({ root }) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/ordinary-artifact-faults.ts"), mode, root], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr + stdout).toBe(0);
      const proof = JSON.parse(stdout);
      expect(proof.fired).toBe(true);
      expect(proof.failed).toBe(true);
      expect(proof.cleanupConfirmed).toBe(false);
      expect(proof.foreignEntries).toEqual([]);
    });
  });
}

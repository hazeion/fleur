/** Real temporary filesystem races at the OS observation boundary. No owned helper is replaced. */
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
const actual = { ...fs };
const [mode, root] = process.argv.slice(2);
if (!root || !["directory-swap", "copied-byte-change"].includes(mode ?? "")) throw new Error("Exact fixture mode required");
const directory = join(root, "build"); const staging = join(root, "stage"); const output = join(staging, "ordinary-execution");
const archive = join(output, "fleur-internal-native-candidate.tgz"); const foreign = join(root, "foreign");
await actual.mkdir(foreign, { mode: 0o700 });
let fired = false;
mock.module("node:fs/promises", () => ({ ...actual, lstat: async (...args: Parameters<typeof fs.lstat>) => {
  const observed = await actual.lstat(...args);
  if (!fired && mode === "directory-swap" && args[0] === output) {
    fired = true; await actual.rename(output, output + ".owned"); await actual.symlink(foreign, output);
  } else if (!fired && mode === "copied-byte-change" && args[0] === archive) {
    fired = true; const body = await actual.readFile(archive); body[0] = body[0]! ^ 1; await actual.writeFile(archive, body);
  }
  return observed;
} }));
const { selectVerificationArtifact } = await import(resolve(import.meta.dir, "../../../scripts/verify-fresh-linux.ts"));
const built = { ordinary: { filename: "fleur-ordinary.tgz", sha256: Bun.CryptoHasher.hash("sha256", await actual.readFile(join(directory, "fleur-ordinary.tgz")), "hex") }, candidate: { filename: "fleur-internal-native-candidate.tgz", sha256: Bun.CryptoHasher.hash("sha256", await actual.readFile(join(directory, "fleur-internal-native-candidate.tgz")), "hex") } };
let failed = false; let cleanupConfirmed: unknown;
try { await selectVerificationArtifact(directory, built, "ordinary-source-owned", staging); }
catch (error) { failed = true; cleanupConfirmed = (error as { artifactCleanupConfirmed?: unknown }).artifactCleanupConfirmed; }
process.stdout.write(JSON.stringify({ fired, failed, cleanupConfirmed, foreignEntries: await actual.readdir(foreign) }));

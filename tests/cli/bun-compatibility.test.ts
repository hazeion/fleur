import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The release floor under test. Bun and npm ignore `engines.bun`; the CLI gate reads it.
const floor = ">=1.4.3";
// Official Bun release asset digests, independently recorded from each release's SHASUMS256.txt.
// 1.4.2 authenticates a runtime below the floor; 1.4.4 authenticates a stable runtime above it.
// The digests authenticate test fixtures only; admission is decided by the gate under test.
type Asset = { name: string; sha256: string };
const fixtures: Readonly<Record<"1.4.2" | "1.4.4", Readonly<Record<string, Asset>>>> = {
  "1.4.2": {
    "darwin-x64": { name: "bun-darwin-x64-baseline", sha256: "bad5bbd6cf14d0980d115f5954c9ff904df619d5e994d2da1ffccd3f316300b0" },
    "darwin-arm64": { name: "bun-darwin-aarch64", sha256: "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f" },
    "linux-x64": { name: "bun-linux-x64-baseline", sha256: "c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f" },
    "linux-arm64": { name: "bun-linux-aarch64", sha256: "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7" },
  },
  "1.4.4": {
    "darwin-x64": { name: "bun-darwin-x64-baseline", sha256: "d4a155adfbfd09155eb3ba05c9e3a544f39297d7a68616d3c7759f67ab5c47dc" },
    "darwin-arm64": { name: "bun-darwin-aarch64", sha256: "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510" },
    "linux-x64": { name: "bun-linux-x64-baseline", sha256: "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76" },
    "linux-arm64": { name: "bun-linux-aarch64", sha256: "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e" },
  },
};
let scratch: string;
let olderBun: string;
let newerBun: string;
let executable: string;
let poisoned: string;
let sentinel: string;
async function child(executablePath: string, args: readonly string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const running = Bun.spawn([executablePath, ...args], { ...options, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => running.kill("SIGKILL"), 10_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(running.stdout).text(), new Response(running.stderr).text(), running.exited]);
    return { stdout, stderr, exit };
  } finally { clearTimeout(timer); if (running.exitCode === null && running.signalCode === null) { running.kill("SIGKILL"); await running.exited; } }
}
async function fetchBun(version: keyof typeof fixtures): Promise<string> {
  const asset = fixtures[version][`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`No authenticated Bun ${version} fixture for this platform`);
  const response = await fetch(`https://github.com/oven-sh/bun/releases/download/bun-v${version}/${asset.name}.zip`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`Official Bun ${version} fixture download failed`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 128 * 1024 * 1024) { await reader.cancel(); throw new Error(`Bun ${version} fixture exceeded its size bound`); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  if (Bun.CryptoHasher.hash("sha256", bytes, "hex") !== asset.sha256) throw new Error(`Bun ${version} fixture digest mismatch`);
  const zip = join(scratch, `bun-${version}.zip`);
  await writeFile(zip, bytes, { flag: "wx", mode: 0o600 });
  const bun = join(scratch, `bun-${version}`);
  await writeFile(bun, "", { flag: "wx", mode: 0o700 });
  const extraction = Bun.spawn(["/usr/bin/unzip", "-p", zip, `${asset.name}/bun`], { stdout: Bun.file(bun), stderr: "pipe" });
  const extractionTimer = setTimeout(() => extraction.kill("SIGKILL"), 10_000);
  try { if (await extraction.exited !== 0) throw new Error(await new Response(extraction.stderr).text()); }
  finally { clearTimeout(extractionTimer); if (extraction.exitCode === null && extraction.signalCode === null) { extraction.kill("SIGKILL"); await extraction.exited; } }
  const extracted = await lstat(bun);
  if (!extracted.isFile() || extracted.isSymbolicLink() || extracted.size < 1 || extracted.size > 256 * 1024 * 1024) throw new Error(`Bun ${version} executable size or file type is invalid`);
  await chmod(bun, 0o700);
  if ((await child(bun, ["--version"])).stdout.trim() !== version) throw new Error(`Authenticated Bun ${version} executable identity mismatch`);
  return bun;
}
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fleur-bun-compat-"));
  [olderBun, newerBun] = await Promise.all([fetchBun("1.4.2"), fetchBun("1.4.4")]);
  const archive = join(scratch, "fleur.tgz");
  const packed = await child(process.execPath, ["pm", "pack", "--filename", archive], { cwd: import.meta.dir + "/../.." });
  if (packed.exit !== 0) throw new Error(packed.stderr);
  const unpacked = await child("/usr/bin/tar", ["-xzf", archive, "-C", scratch]);
  if (unpacked.exit !== 0) throw new Error(unpacked.stderr);
  executable = join(scratch, "package", "bin", "fleur.ts");
  const metadata = JSON.parse(await readFile(join(scratch, "package", "package.json"), "utf8")) as { engines: { bun: string } };
  if (metadata.engines.bun !== floor) throw new Error(`The packed release declares ${metadata.engines.bun}; this suite proves the ${floor} floor`);
  poisoned = join(scratch, "poisoned-path"); sentinel = join(scratch, "unexpected-host-action");
  await mkdir(poisoned);
  for (const tool of ["docker", "bun", "node", "npm", "curl"]) await writeFile(join(poisoned, tool), '#!/bin/sh\nprintf reached > "$FLEUR_HOST_SENTINEL"\nexit 99\n', { mode: 0o700 });
}, 120_000);
afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });
function environment() { return { HOME: scratch, PATH: poisoned, FLEUR_HOST_SENTINEL: sentinel }; }
async function invoke(...args: string[]) {
  return child(olderBun, [executable, ...args], { cwd: scratch, env: environment() });
}
/** A copy of the packed release whose only difference is the stored `engines.bun` value. */
async function releaseWithFloor(stored: string, name: string): Promise<string> {
  const copy = join(scratch, name);
  await cp(join(scratch, "package"), copy, { recursive: true });
  const manifest = JSON.parse(await readFile(join(copy, "package.json"), "utf8")) as { engines: { bun: string } };
  manifest.engines.bun = stored;
  await writeFile(join(copy, "package.json"), JSON.stringify(manifest));
  return join(copy, "bin", "fleur.ts");
}
test("the packed release refuses a real Bun below its floor before project creation writes", async () => {
  const result = await invoke("new", "untouched", "--no-git", "--json");
  expect(result.exit).toBe(4);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ formatVersion: 1, command: "new", ok: false, data: null, truncated: false, error: { code: "BUN_VERSION_MISMATCH", expected: floor, actual: "1.4.2" } });
  await expect(lstat(join(scratch, "untouched"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await Bun.file(sentinel).exists()).toBe(false);
});

test("a Bun below the floor stops setup before host tools and reports the floor with manual guidance", async () => {
  const result = await invoke("setup", "--json");
  expect(result.exit).toBe(4);
  expect(JSON.parse(result.stdout)).toMatchObject({ formatVersion: 1, command: "setup", ok: false, error: { code: "BUN_VERSION_MISMATCH", expected: floor, actual: "1.4.2" } });
  expect(JSON.parse(result.stdout).error.actions[0]).toMatchObject({ command: "bun --version" });
  expect(await Bun.file(sentinel).exists()).toBe(false);
  const human = await invoke("setup");
  expect(human.exit).toBe(4);
  expect(human.stdout).toContain(`requires Bun ${floor}; invoking Bun is 1.4.2.`);
  expect(human.stdout).toContain("Install a Bun release at or above the floor manually and retry.");
  expect(human.stderr).toBe("");
  await expect(lstat(join(scratch, ".local"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a real stable Bun above the floor is admitted and runs project creation", async () => {
  const result = await child(newerBun, [executable, "new", "admitted", "--no-git", "--json"], { cwd: scratch, env: environment() });
  expect(result.stderr).toBe("");
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ formatVersion: 1, command: "new", ok: true, error: null });
  const metadata = JSON.parse(await readFile(join(scratch, "package", "package.json"), "utf8")) as { version: string };
  expect(JSON.parse(await readFile(join(scratch, "admitted", "fleur.json"), "utf8"))).toMatchObject({ fleurVersion: metadata.version });
  expect(await Bun.file(sentinel).exists()).toBe(false);
});

test("an invalid stored floor refuses with exit 4 instead of admitting every Bun", async () => {
  for (const [index, stored] of ["1.4.3", ">=abc"].entries()) {
    const invalidRelease = await releaseWithFloor(stored, `invalid-floor-${index}`);
    const result = await child(process.execPath, [invalidRelease, "new", `unwritten-${index}`, "--no-git", "--json"], { cwd: scratch, env: environment() });
    expect(result.stderr, stored).toBe("");
    expect(result.exit, stored).toBe(4);
    const parsed = JSON.parse(result.stdout);
    expect(parsed, stored).toMatchObject({ formatVersion: 1, command: "new", ok: false, data: null, error: { code: "BUN_VERSION_MISMATCH", expected: ">=X.Y.Z", actual: stored } });
    expect(parsed.error.message, stored).toContain(`invalid Bun floor ${JSON.stringify(stored)}`);
    await expect(lstat(join(scratch, `unwritten-${index}`)), stored).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await Bun.file(sentinel).exists()).toBe(false);
});

test("help remains available and invalid syntax retains category2 under a Bun below the floor", async () => {
  const help = await invoke("--help", "--json");
  expect(help.exit).toBe(0);
  expect(JSON.parse(help.stdout)).toMatchObject({ formatVersion: 1, command: "help", ok: true });
  const invalid = await invoke("setup", "--unknown", "--json");
  expect(invalid.exit).toBe(2);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ error: { code: "ARGUMENT_INVALID" } });
  expect(await Bun.file(sentinel).exists()).toBe(false);
});

// The delegated release applies its own floor; the launcher's floor never decides for it.
const delegatedBin = `import release from "../package.json" with { type: "json" };
const floor = /^>=(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(release.engines.bun);
const actual = /^(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(Bun.version);
let ok = floor !== null && actual !== null;
for (const index of [1, 2, 3]) { if (!ok || !floor || !actual || Number(actual[index]) === Number(floor[index])) continue; ok = Number(actual[index]) > Number(floor[index]); break; }
console.log(JSON.stringify({ formatVersion: 1, command: "init", ok, data: { selectedRelease: release.version, expectedBun: release.engines.bun, actualBun: Bun.version }, error: null, truncated: false }));
process.exitCode = ok ? 0 : 4;
`;
async function delegatedProject(name: string, delegatedFloor: string): Promise<string> {
  const project = join(scratch, name);
  const local = join(project, "node_modules", "fleur");
  await mkdir(join(local, "bin"), { recursive: true });
  await writeFile(join(project, "fleur.json"), JSON.stringify({ fleurVersion: "0.0.9" }));
  await writeFile(join(local, "package.json"), JSON.stringify({ name: "fleur", version: "0.0.9", bin: { fleur: "./bin/fleur.ts" }, engines: { bun: delegatedFloor } }));
  await writeFile(join(local, "bin", "fleur.ts"), delegatedBin);
  return project;
}
test("project-local release delegation precedes the launcher's floor and the delegated release applies its own floor", async () => {
  // The launcher refuses 1.4.2, but the selected 0.0.9 release admits it under its own lower floor.
  const admitted = await child(olderBun, [executable, "init", "--json"], { cwd: await delegatedProject("delegated-lower-floor", ">=1.4.2"), env: environment() });
  expect(admitted.exit).toBe(0);
  expect(JSON.parse(admitted.stdout)).toMatchObject({ formatVersion: 1, command: "init", ok: true, data: { selectedRelease: "0.0.9", expectedBun: ">=1.4.2", actualBun: "1.4.2" } });
  expect(admitted.stderr).toBe("");
  // The launcher admits 1.4.4, but the selected release refuses it under its own higher floor.
  const refused = await child(newerBun, [executable, "init", "--json"], { cwd: await delegatedProject("delegated-higher-floor", ">=1.4.5"), env: environment() });
  expect(refused.exit).toBe(4);
  expect(JSON.parse(refused.stdout)).toMatchObject({ formatVersion: 1, command: "init", ok: false, data: { selectedRelease: "0.0.9", expectedBun: ">=1.4.5", actualBun: "1.4.4" } });
  expect(refused.stderr).toBe("");
  expect(await Bun.file(sentinel).exists()).toBe(false);
});

test("invalid project positionals and compiler values retain argument errors before Bun compatibility", async () => {
  for (const args of [["new"], ["init", "extra"], ["new", "abc", "--compiler", "invalid"]]) {
    const result = await invoke(...args, "--json");
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ formatVersion: 1, ok: false, error: { code: "ARGUMENT_INVALID" } });
    expect(result.stderr).toBe("");
  }
  await expect(lstat(join(scratch, "abc"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await Bun.file(sentinel).exists()).toBe(false);
});

test("invalid prerequisite and grant arguments stop before Bun compatibility or host access", async () => {
  for (const args of [["doctor", "extra"], ["setup", "extra"], ["setup", "grants", "list", "extra"], ["setup", "grants", "revoke"], ["setup", "grants", "revoke", "invalid"]]) {
    const result = await invoke(...args, "--json");
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ formatVersion: 1, ok: false, error: { code: "ARGUMENT_INVALID" } });
    expect(result.stderr).toBe("");
  }
  const experimental = await invoke("new", "rust-target", "--compiler", "rust-experimental", "--json");
  expect(experimental.exit).toBe(4);
  expect(JSON.parse(experimental.stdout).error.code).not.toBe("ARGUMENT_INVALID");
  await expect(lstat(join(scratch, "rust-target"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(scratch, ".local"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await Bun.file(sentinel).exists()).toBe(false);
});

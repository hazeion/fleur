import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Official Bun1.4.2 release asset digests, independently recorded from GitHub's release metadata.
// These authenticate a negative-test runtime; they do not admit it as a supported Fleur runtime.
const assets: Readonly<Record<string, { name: string; sha256: string }>> = {
  "darwin-x64": { name: "bun-darwin-x64-baseline", sha256: "bad5bbd6cf14d0980d115f5954c9ff904df619d5e994d2da1ffccd3f316300b0" },
  "darwin-arm64": { name: "bun-darwin-aarch64", sha256: "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f" },
  "linux-x64": { name: "bun-linux-x64-baseline", sha256: "c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f" },
  "linux-arm64": { name: "bun-linux-aarch64", sha256: "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7" },
};
let scratch: string;
let olderBun: string;
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
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fleur-bun-compat-"));
  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error("No authenticated negative Bun fixture for this platform");
  const response = await fetch(`https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/${asset.name}.zip`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error("Official negative Bun fixture download failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 128 * 1024 * 1024) { await reader.cancel(); throw new Error("Negative Bun fixture exceeded its size bound"); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  if (Bun.CryptoHasher.hash("sha256", bytes, "hex") !== asset.sha256) throw new Error("Negative Bun fixture digest mismatch");
  const zip = join(scratch, "older-bun.zip");
  await writeFile(zip, bytes, { flag: "wx", mode: 0o600 });
  olderBun = join(scratch, "older-bun");
  await writeFile(olderBun, "", { flag: "wx", mode: 0o700 });
  const extraction = Bun.spawn(["/usr/bin/unzip", "-p", zip, `${asset.name}/bun`], { stdout: Bun.file(olderBun), stderr: "pipe" });
  const extractionTimer = setTimeout(() => extraction.kill("SIGKILL"), 10_000);
  try { if (await extraction.exited !== 0) throw new Error(await new Response(extraction.stderr).text()); }
  finally { clearTimeout(extractionTimer); if (extraction.exitCode === null && extraction.signalCode === null) { extraction.kill("SIGKILL"); await extraction.exited; } }
  const extracted = await lstat(olderBun);
  if (!extracted.isFile() || extracted.isSymbolicLink() || extracted.size < 1 || extracted.size > 256 * 1024 * 1024) throw new Error("Negative Bun executable size or file type is invalid");
  await chmod(olderBun, 0o700);
  if ((await child(olderBun, ["--version"])).stdout.trim() !== "1.4.2") throw new Error("Authenticated negative Bun executable identity mismatch");
  const archive = join(scratch, "fleur.tgz");
  const packed = await child(process.execPath, ["pm", "pack", "--filename", archive], { cwd: import.meta.dir + "/../.." });
  if (packed.exit !== 0) throw new Error(packed.stderr);
  const unpacked = await child("/usr/bin/tar", ["-xzf", archive, "-C", scratch]);
  if (unpacked.exit !== 0) throw new Error(unpacked.stderr);
  executable = join(scratch, "package", "bin", "fleur.ts");
  poisoned = join(scratch, "poisoned-path"); sentinel = join(scratch, "unexpected-host-action");
  await mkdir(poisoned);
  for (const tool of ["docker", "bun", "node", "npm", "curl"]) await writeFile(join(poisoned, tool), '#!/bin/sh\nprintf reached > "$FLEUR_HOST_SENTINEL"\nexit 99\n', { mode: 0o700 });
}, 90_000);
afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });
async function invoke(...args: string[]) {
  return child(olderBun, [executable, ...args], { cwd: scratch, env: { HOME: scratch, PATH: poisoned, FLEUR_HOST_SENTINEL: sentinel } });
}
test("the packed release rejects a real incompatible Bun before project creation writes", async () => {
  const result = await invoke("new", "untouched", "--no-git", "--json");
  expect(result.exit).toBe(4);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ formatVersion: 1, command: "new", ok: false, data: null, truncated: false, error: { code: "BUN_VERSION_MISMATCH", expected: "1.4.3", actual: "1.4.2" } });
  await expect(lstat(join(scratch, "untouched"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await Bun.file(sentinel).exists()).toBe(false);
});

test("incompatible Bun stops setup before host tools and provides manual expected/actual guidance", async () => {
  const result = await invoke("setup", "--json");
  expect(result.exit).toBe(4);
  expect(JSON.parse(result.stdout)).toMatchObject({ formatVersion: 1, command: "setup", ok: false, error: { code: "BUN_VERSION_MISMATCH", expected: "1.4.3", actual: "1.4.2" } });
  expect(JSON.parse(result.stdout).error.actions[0]).toMatchObject({ command: "bun --version" });
  expect(await Bun.file(sentinel).exists()).toBe(false);
  const human = await invoke("setup");
  expect(human.exit).toBe(4);
  expect(human.stdout).toContain("requires Bun 1.4.3");
  expect(human.stdout).toContain("invoking Bun is 1.4.2");
  expect(human.stdout).toContain("manually");
  expect(human.stderr).toBe("");
  await expect(lstat(join(scratch, ".local"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("help remains available and invalid syntax retains category2 under incompatible Bun", async () => {
  const help = await invoke("--help", "--json");
  expect(help.exit).toBe(0);
  expect(JSON.parse(help.stdout)).toMatchObject({ formatVersion: 1, command: "help", ok: true });
  const invalid = await invoke("setup", "--unknown", "--json");
  expect(invalid.exit).toBe(2);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ error: { code: "ARGUMENT_INVALID" } });
  expect(await Bun.file(sentinel).exists()).toBe(false);
});

test("project-local release delegation precedes the launcher's different Bun requirement", async () => {
  const project = join(scratch, "delegated");
  const local = join(project, "node_modules", "fleur");
  await mkdir(join(local, "bin"), { recursive: true });
  await writeFile(join(project, "fleur.json"), JSON.stringify({ fleurVersion: "0.0.9" }));
  await writeFile(join(local, "package.json"), JSON.stringify({ name: "fleur", version: "0.0.9", bin: { fleur: "./bin/fleur.ts" }, engines: { bun: "1.4.2" } }));
  await writeFile(join(local, "bin", "fleur.ts"), `import release from "../package.json" with { type: "json" };\nconst ok = Bun.version === release.engines.bun;\nconsole.log(JSON.stringify({ formatVersion: 1, command: "init", ok, data: { selectedRelease: release.version, expectedBun: release.engines.bun, actualBun: Bun.version }, error: null, truncated: false }));\nprocess.exitCode = ok ? 0 : 4;\n`);
  const result = await child(olderBun, [executable, "init", "--json"], { cwd: project, env: { HOME: scratch, PATH: poisoned, FLEUR_HOST_SENTINEL: sentinel } });
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ formatVersion: 1, command: "init", ok: true, data: { selectedRelease: "0.0.9", expectedBun: "1.4.2", actualBun: "1.4.2" } });
  expect(result.stderr).toBe("");
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

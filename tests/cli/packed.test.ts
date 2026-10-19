import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratch: string;
let executable: string;
let path: string;
let archive: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fleur-packed-"));
  archive = join(scratch, "fleur.tgz");
  const packed = Bun.spawn([process.execPath, "pm", "pack", "--filename", archive], { cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe" });
  if (await packed.exited !== 0) throw new Error(await new Response(packed.stderr).text());
  const extraction = Bun.spawn(["/usr/bin/tar", "-xzf", archive, "-C", scratch], { stdout: "pipe", stderr: "pipe" });
  if (await extraction.exited !== 0) throw new Error(await new Response(extraction.stderr).text());
  executable = join(scratch, "package", "bin", "fleur.ts");
  path = join(scratch, "poisoned-path");
  await mkdir(path);
  await writeFile(join(path, "node"), "#!/bin/sh\necho unexpected-node >&2\nexit 99\n", { mode: 0o755 });
});
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });
async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, executable, ...args], { cwd: scratch, env: { PATH: path, HOME: scratch }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}
test("packed help works offline through Bun with Node poisoned and no checkout working directory", async () => {
  const response = await cli("--json", "--help");
  expect(response.exit).toBe(0);
  expect(response.stderr).toBe("");
  const value = JSON.parse(response.stdout);
  expect(value).toMatchObject({ formatVersion: 1, command: "help", ok: true, error: null, truncated: false });
  expect(value.data.commands).toEqual([{ name: "help", summary: "Show available commands and global options." }, { name: "new", summary: "Create an exactly pinned Fleur project." }, { name: "init", summary: "Initialize a Fleur project without overwriting user files." }]);
  expect(response.stdout.trim().split("\n")).toHaveLength(1);
});
test("invalid invocations return category 2 JSON without interpreting shell arguments", async () => {
  for (const args of [["--unknown"], ["unknown"], ["help", "sh", "-c", "touch sentinel"], ["--project"], ["--timeout", "0"], ["--timeout", "NaN"], ["--timeout", "Infinity"], ["--json=false"], ["--project", "--help"], ["--json", "--json"]]) {
    const response = await cli("--json", ...args);
    expect(response.exit).toBe(2);
    expect(response.stderr).toBe("");
    expect(JSON.parse(response.stdout)).toMatchObject({ formatVersion: 1, ok: false, data: null, error: { code: "ARGUMENT_INVALID", actions: [{ command: "fleur --help" }] }, truncated: false });
  }
  expect(await Bun.file(join(scratch, "sentinel")).exists()).toBe(false);
});
test("human help is readable, catalog-driven, and lists only implemented operations", async () => {
  const response = await cli("--project", "./selected", "--timeout", "0.5", "--help");
  expect(response.exit).toBe(0);
  expect(response.stdout).toContain("Usage: fleur <command> [options]");
  expect(response.stdout).toContain("help  Show available commands and global options.");
  expect(response.stdout).toContain("--timeout <seconds>");
  expect(response.stdout).not.toContain("setup");
  expect(response.stderr).toBe("");
});

test("bunx launches the installed packed release without Node or registry fallback", async () => {
  const project = join(scratch, "bunx-project");
  await mkdir(project);
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "packed-cli-consumer", private: true, dependencies: { fleur: `file:${archive}` } }));
  const install = Bun.spawn([process.execPath, "install", "--ignore-scripts", "--production"], { cwd: project, env: { PATH: path, HOME: scratch }, stdout: "pipe", stderr: "pipe" });
  const installationError = await new Response(install.stderr).text();
  expect(await install.exited, installationError).toBe(0);
  await symlink(process.execPath, join(path, "bunx"));
  await symlink(process.execPath, join(path, "bun"));
  const child = Bun.spawn([join(path, "bunx"), "--no-install", "fleur", "--json", "--help"], { cwd: project, env: { PATH: path, HOME: scratch }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({ formatVersion: 1, command: "help", ok: true });
});
test("packed release exposes project creation through its real executable", async () => {
  const response = await cli("--json", "new", "packed-project", "--no-git");
  expect(response.exit).toBe(0);
  expect(JSON.parse(response.stdout)).toMatchObject({ command: "new", ok: true });
  expect(await Bun.file(join(scratch, "packed-project", "fleur.json")).json()).toMatchObject({ fleurVersion: "0.1.0" });
});

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
  expect(value.data.commands).toEqual([
    { name: "help", summary: "Show available commands and global options." },
    { name: "new", usage: "new <dir> [--compiler microsoft|rust-experimental] [--no-git]", summary: "Create an exactly pinned Fleur project.", options: [{ name: "--no-git", value: false }, { name: "--compiler", value: true }] },
    { name: "init", usage: "init [--compiler microsoft|rust-experimental] [--no-git]", summary: "Initialize a Fleur project without overwriting user files.", options: [{ name: "--no-git", value: false }, { name: "--compiler", value: true }] },
    { name: "setup grants revoke", usage: "setup grants revoke <id>", summary: "Revoke a setup grant without changing installed software." },
    { name: "setup grants list", usage: "setup grants list", summary: "Inspect this OS user's setup grants." },
    { name: "setup", usage: "setup [--grant <id>]", summary: "Inspect authorized resumable prerequisite setup actions.", options: [{ name: "--grant", value: true }] },
    { name: "doctor", usage: "doctor", summary: "Inspect local prerequisites without installing software." },
  ]);
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
  expect(response.stdout).toContain("setup grants revoke <id>");
  expect(response.stdout).toContain("setup [--grant <id>]");
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
test("command help exposes admitted creation flags in human and JSON catalogs without creating a project", async () => {
  const human = await cli("new", "help-must-not-create", "--help");
  expect(human.exit).toBe(0);
  expect(human.stdout).toContain("--compiler");
  expect(human.stdout).toContain("--no-git");
  const machine = await cli("--json", "new", "--help");
  expect(machine.exit).toBe(0);
  expect(JSON.parse(machine.stdout).data.commands.find((command: { name: string }) => command.name === "new").options).toEqual([{ name: "--no-git", value: false }, { name: "--compiler", value: true }]);
  expect(await Bun.file(join(scratch, "help-must-not-create/fleur.json")).exists()).toBe(false);
});
test("packed prerequisite commands use the real executable and isolated user state without installing software", async () => {
  const listed = await cli("--json", "setup", "grants", "list");
  expect(listed.exit).toBe(0);
  expect(JSON.parse(listed.stdout)).toMatchObject({ command: "setup grants list", ok: true, data: { grants: [] } });
  const diagnosed = await cli("--json", "doctor");
  expect(diagnosed.exit).toBe(4);
  expect(JSON.parse(diagnosed.stdout)).toMatchObject({ command: "doctor", ok: false, error: { code: "PREREQUISITE_UNAVAILABLE" }, data: { components: { cli: { state: "missing" } } } });
  const setup = await cli("--json", "setup");
  expect(setup.exit).toBe(3);
  expect(JSON.parse(setup.stdout)).toMatchObject({ command: "setup", ok: false, error: { code: "HUMAN_ACTION_REQUIRED" }, data: { grantsCreated: false, resumable: true } });
  await writeFile(join(scratch, "fleur.json"), "broken project metadata");
  try {
    const revoked = await cli("--json", "setup", "grants", "revoke", "00000000-0000-0000-0000-000000000000");
    expect(revoked.exit).toBe(1);
    expect(JSON.parse(revoked.stdout)).toMatchObject({ command: "setup grants revoke", error: { code: "ARGUMENT_INVALID" } });
    const after = await cli("--json", "setup", "grants", "list");
    expect(after.exit).toBe(0);
    expect(JSON.parse(after.stdout).data.grants).toEqual([]);
  } finally { await rm(join(scratch, "fleur.json")); }
  for (const response of [listed, diagnosed, setup]) expect(response.stderr).toBe("");
});
test("packed release carries its offline creation and prerequisite documentation", async () => {
  expect(await Bun.file(join(scratch, "package/docs/project-creation.md")).exists()).toBe(true);
  expect(await Bun.file(join(scratch, "package/docs/setup.md")).exists()).toBe(true);
  expect(await Bun.file(join(scratch, "package/docs/setup.md")).text()).toContain("Assisted package installation remains blocked.");
});

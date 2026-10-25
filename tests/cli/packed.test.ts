import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionHost } from "../../src/setup/host.ts";

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
  expect(response.exit, response.stderr).toBe(0);
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
    { name: "db inspect", usage: "db inspect [--table <name>] [--limit 100] [--cursor <token>] [--export <file>]", summary: "Inspect bounded application data or export it to a file.", options: [{ name: "--table", value: true }, { name: "--limit", value: true }, { name: "--cursor", value: true }, { name: "--export", value: true }] },
    { name: "db backup", usage: "db backup --out <file>", summary: "Create and restore-verify a retained database backup.", options: [{ name: "--out", value: true }] },
    { name: "db recover", usage: "db recover --inspect", summary: "Inspect durable maintenance state without clearing it.", options: [{ name: "--inspect", value: false }] },
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
  // Collect facts before invoking setup. Never derive expectations from its response.
  const host = await productionHost().host();
  const apt = await Bun.file(join(scratch, "package/src/setup/verified-apt-profiles.json")).json();
  const desktop = await Bun.file(join(scratch, "package/src/setup/verified-desktop-profiles.json")).json();
  for (const [name, packed] of [["verified-apt-profiles.json", apt], ["verified-desktop-profiles.json", desktop]] as const) {
    expect(packed).toEqual(await Bun.file(join(import.meta.dir, "../../src/setup", name)).json());
  }
  const aptProfile = apt.entries.find(({ profile }: { profile: { distribution: string; release: string; architecture: string } }) => host.system === "linux" && profile.distribution === host.distribution && profile.release === host.release && profile.architecture === host.architecture);
  const desktopProfile = desktop.entries.find(({ profile }: { profile: { release: string; architecture: string } }) => host.system === "darwin" && profile.release === host.release && profile.architecture === host.architecture);
  const existingApp = host.system === "darwin" ? await lstat("/Applications/Docker.app").catch((error: unknown) => { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }) : null;
  const setup = await cli("--json", "setup");
  const result = JSON.parse(setup.stdout);
  const supported = ["x64", "arm64"].includes(host.architecture) && (host.system === "darwin" && /^\d+\./.test(host.release) && Number(host.release.split(".")[0]) >= 13
    || host.system === "linux" && (host.distribution === "ubuntu" && ["24.04", "26.04"].includes(host.release) || host.distribution === "debian" && host.release === "13" || host.distribution === "arch" && host.architecture === "x64"));
  if (host.translated !== false || !supported) {
    expect(setup.exit).toBe(4);
    expect(result).toMatchObject({ command: "setup", ok: false, error: { code: "PREREQUISITE_UNAVAILABLE", message: "Assisted setup requires a supported native platform." } });
  } else if (aptProfile && host.machineId && /^[a-f0-9]{64}$/.test(host.machineId) && host.bootId && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(host.bootId)) {
    // With dpkg-query deliberately absent, every admitted APT tuple must refuse unknown package state.
    expect(setup.exit).toBe(4);
    expect(result).toMatchObject({ command: "setup", ok: false, error: { code: "PREREQUISITE_UNAVAILABLE" }, data: { packageState: { state: "unavailable", present: [], missing: [] } } });
  } else if (desktopProfile) {
    if (!host.machineId || !/^[a-f0-9]{64}$/.test(host.machineId)) {
      expect(setup.exit).toBe(4);
      expect(result).toMatchObject({ error: { code: "PREREQUISITE_UNAVAILABLE", message: "Desktop requires an authenticated exact source-owned artifact profile." } });
    } else if (existingApp) {
      expect(setup.exit).toBe(4);
      expect(result).toMatchObject({ command: "setup", ok: false, error: { code: "PREREQUISITE_UNAVAILABLE", message: "An existing Docker application was preserved. Setup never replaces or repairs it automatically." } });
      const after = await lstat("/Applications/Docker.app");
      for (const key of ["dev", "ino", "mode", "uid", "gid", "size", "mtimeMs", "ctimeMs"] as const) expect(after[key]).toBe(existingApp[key]);
    } else {
      expect(setup.exit).toBe(3);
      expect(result).toMatchObject({ command: "setup", ok: false, error: { code: "AUTHORITY_REQUIRED" }, data: { plan: { method: "docker-desktop-official-dmg", artifactAuthentication: "authenticated", nativeEvidence: "verified", requiredAuthorities: ["image-acquire", "install"] }, resumable: true } });
    }
  } else {
    expect(setup.exit).toBe(3);
    expect(result).toMatchObject({ command: "setup", ok: false, error: { code: "HUMAN_ACTION_REQUIRED" } });
    if (aptProfile) expect(result.data).toMatchObject({ grantsCreated: false, resumable: true });
    else expect(result.data).toMatchObject({ plan: { verified: false }, grantsCreated: false, resumable: true });
  }
  const finalGrants = await cli("--json", "setup", "grants", "list");
  expect(finalGrants.exit).toBe(0);
  expect(JSON.parse(finalGrants.stdout)).toMatchObject({ data: { grants: [] } });
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
  const setupDocumentation = await Bun.file(join(scratch, "package/docs/setup.md")).text();
  expect(setupDocumentation).toContain("The source-owned catalog includes exact Ubuntu 24.04, Ubuntu 26.04 and Debian 13 x64 prerequisite tuples.");
  expect(setupDocumentation).toContain("Platforms without an admitted installer row require manual setup.");
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratch: string;
let executable: string;
let path: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fleur-packed-"));
  const archive = join(scratch, "fleur.tgz");
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
  expect(value.data.commands).toEqual([{ name: "help", summary: "Show available commands and global options." }]);
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

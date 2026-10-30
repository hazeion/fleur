import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";

let taskHome: string;
beforeAll(async () => {
  const { mkdtemp, realpath } = await import("node:fs/promises");
  taskHome = await mkdtemp(resolve(await realpath((await import("node:os")).tmpdir()), "fleur-lifecycle-home-"));
});
afterAll(async () => { await (await import("node:fs/promises")).rm(taskHome, { recursive: true, force: true }); });
const executable = resolve(import.meta.dir, "../../bin/fleur.ts");
async function cli(...args: string[]) { return cliWithEnvironment({}, ...args); }
async function cliWithEnvironment(environment: Record<string, string | undefined>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, executable, ...args], { env: { ...process.env, HOME: taskHome, ...environment }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}
test("development lifecycle commands expose the approved grammar in JSON help", async () => {
  const response = await cli("--help", "--json");
  expect(response.exit).toBe(0);
  const commands = JSON.parse(response.stdout).data.commands;
  expect(commands).toContainEqual({ name: "dev", summary: "Run the owned development environment.", usage: "dev [--background] [--host <address>] [--port <number>]", options: [{ name: "--background", value: false }, { name: "--host", value: true }, { name: "--port", value: true }] });
  expect(commands).toContainEqual({ name: "stop", summary: "Stop owned development resources, preserving data and backups.", usage: "stop" });
  expect(commands).toContainEqual({ name: "logs", summary: "Read bounded development logs.", usage: "logs [--limit 200] [--cursor <token>] [--follow]", options: [{ name: "--limit", value: true }, { name: "--cursor", value: true }, { name: "--follow", value: false }] });
});

test("stopping an unused project is idempotent and never requires a database", async () => {
  const { mkdtemp, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "fleur-lifecycle-cli-"));
  try {
    expect((await cli("new", resolve(root, "app"), "--no-git", "--json")).exit).toBe(0);
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await cli("stop", "--project", resolve(root, "app"), "--json");
      expect(response.exit).toBe(0);
      expect(JSON.parse(response.stdout)).toMatchObject({ formatVersion: 1, command: "stop", ok: true, data: { state: "stopped", ready: false }, error: null, truncated: false });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lifecycle rejects out-of-range ports, hostnames, log limits and malformed cursors before probing", async () => {
  for (const args of [["dev", "--port", "0"], ["dev", "--port", "65536"], ["dev", "--port", "1.5"], ["dev", "--host", "example.com"], ["logs", "--limit", "201"], ["logs", "--limit", "0"], ["logs", "--cursor", "not-a-cursor"], ["stop", "unexpected"]]) {
    const response = await cli(...args, "--json");
    expect(response.exit, response.stdout).toBe(2);
    expect(JSON.parse(response.stdout)).toMatchObject({ formatVersion: 1, ok: false, error: { code: "ARGUMENT_INVALID" } });
  }
});


test("development uses the shared prerequisite gate before creating application resources", async () => {
  const { mkdtemp, realpath, readdir, rm } = await import("node:fs/promises");
  const root = await mkdtemp(resolve(await realpath((await import("node:os")).tmpdir()), "fleur-prerequisite-cli-"));
  const project = resolve(root, "app");
  try {
    expect((await cli("new", project, "--no-git", "--json")).exit).toBe(0);
    const unavailable = await cliWithEnvironment({ PATH: resolve(root, "missing-tools") }, "dev", "--background", "--project", project, "--json");
    expect(unavailable.exit, unavailable.stdout).toBe(4);
    expect(JSON.parse(unavailable.stdout)).toMatchObject({ formatVersion: 1, command: "dev", ok: false, error: { code: "PREREQUISITE_UNAVAILABLE" }, data: { state: "failed", ready: false, prerequisites: { command: "doctor", ok: false } } });
    expect(JSON.parse(unavailable.stdout).data.reasons.some((reason: { code: string; action: { command: string } }) => reason.code === "PREREQUISITE_UNAVAILABLE" && reason.action.command === "fleur doctor")).toBe(true);
    expect((await cli("stop", "--project", project, "--json")).exit).toBe(0);
    const records = await readdir(resolve(taskHome, ".local/state/fleur/development"), { recursive: true });
    expect(records.some(record => String(record).endsWith("postgres.json"))).toBe(false);
  } finally { await cli("stop", "--project", project, "--json"); await rm(root, { recursive: true, force: true }); }
});

test("unsafe private checkout state blocks database authority instead of falling back to ambient configuration", async () => {
  const { chmod, mkdtemp, readdir, realpath, rm } = await import("node:fs/promises");
  const root = await mkdtemp(resolve(await realpath((await import("node:os")).tmpdir()), "fleur-private-state-cli-"));
  const project = resolve(root, "app");
  let changed: string | undefined;
  try {
    expect((await cli("new", project, "--no-git", "--json")).exit).toBe(0);
    const before = new Set(await readdir(resolve(taskHome, ".local/state/fleur/development")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; }));
    expect((await cli("stop", "--project", project, "--json")).exit).toBe(0);
    const after = await readdir(resolve(taskHome, ".local/state/fleur/development"));
    const created = after.filter(value => !before.has(value)); expect(created).toHaveLength(1);
    changed = resolve(taskHome, ".local/state/fleur/development", created[0]!);
    await chmod(changed, 0o755);
    const status = await cli("status", "--project", project, "--json");
    expect(status.exit, status.stdout).toBe(0);
    expect(JSON.parse(status.stdout).data).toMatchObject({ state: "failed", ready: false, error: "RECOVERY_REQUIRED" });
    const inspection = await cli("db", "inspect", "--project", project, "--json");
    expect(inspection.exit, inspection.stdout).toBe(5);
    expect(JSON.parse(inspection.stdout).error.code).toBe("RECOVERY_REQUIRED");
  } finally {
    if (changed) await chmod(changed, 0o700);
    await cli("stop", "--project", project, "--json");
    await rm(root, { recursive: true, force: true });
  }
});

test("development redacts prerequisite tool output from JSON, diagnostics and recovery actions", async () => {
  const { mkdir, mkdtemp, realpath, rm, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(resolve(await realpath((await import("node:os")).tmpdir()), "fleur-redaction-cli-"));
  const project = resolve(root, "app"), tools = resolve(root, "tools"), canary = "fleur-error-redaction-canary";
  try {
    await mkdir(tools);
    await writeFile(resolve(tools, "docker"), `#!/bin/sh\nprintf '%s\\n' '${canary}'\n`, { mode: 0o700 });
    expect((await cli("new", project, "--no-git", "--json")).exit).toBe(0);
    const response = await cliWithEnvironment({ PATH: tools, DOCKER_HOST: "unix:///nonexistent/fleur-redaction.sock", DOCKER_CONTEXT: undefined }, "dev", "--background", "--project", project, "--json");
    expect(response.exit).toBe(4);
    expect(response.stdout).not.toContain(canary);
    expect(response.stderr).not.toContain(canary);
    const logs = await cli("logs", "--project", project, "--json");
    expect(logs.stdout).not.toContain(canary);
  } finally { await cli("stop", "--project", project, "--json"); await rm(root, { recursive: true, force: true }); }
});

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
      const status = await cliWithEnvironment({ FLEUR_PRIVATE_DATABASE_URL: undefined, FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL: undefined, FLEUR_PRIVATE_CONTROL_DATABASE_URL: undefined }, "status", "--project", resolve(root, "app"), "--json");
      expect(status.exit, status.stdout).toBe(0);
      expect(JSON.parse(status.stdout).data).toMatchObject({ state: "stopped", ready: false, database: null });
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

test("failed foreground startup and finite failed-instance logs complete with monotonic JSON v1 events", async () => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const root = await mkdtemp(resolve(await realpath((await import("node:os")).tmpdir()), "fleur-stream-cli-"));
  const project = resolve(root, "app");
  try {
    expect((await cli("new", project, "--no-git", "--json")).exit).toBe(0);
    const response = await cliWithEnvironment({ PATH: resolve(root, "missing-tools") }, "dev", "--project", project, "--json");
    expect(response.exit, response.stdout).toBe(4);
    const events = response.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index));
    expect(events[0]).toMatchObject({ formatVersion: 1, command: "dev", sequence: 0, event: "starting" });
    expect(events.at(-1)).toMatchObject({ formatVersion: 1, command: "dev", event: "completed", data: { exitCode: 4, result: { formatVersion: 1, ok: false, error: { code: "PREREQUISITE_UNAVAILABLE" } } } });
    const status = await cli("status", "--project", project, "--json");
    expect(status.exit, status.stdout).toBe(0);
    const snapshot = await cli("logs", "--project", project, "--limit", "1", "--json");
    expect(snapshot.exit, snapshot.stdout).toBe(0);
    expect(JSON.parse(snapshot.stdout).data.logs.length).toBeLessThanOrEqual(1);
  } finally { await cli("stop", "--project", project, "--json"); await rm(root, { recursive: true, force: true }); }
});

test("missing or stale publication evidence never reports a live ownership lock as a stopped instance", async () => {
  const { mkdtemp, realpath, rm, readdir, readFile, unlink, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(resolve(await realpath((await import("node:os")).tmpdir()), "fleur-missing-instance-cli-")), project = resolve(root, "app");
  let file: string | undefined, original: string | undefined;
  try {
    expect((await cli("new", project, "--no-git", "--json")).exit).toBe(0);
    const directory = resolve(taskHome, ".local/state/fleur/development"), before = new Set(await readdir(directory).catch(() => []));
    expect((await cliWithEnvironment({ PATH: resolve(root, "missing-tools") }, "dev", "--background", "--project", project, "--json")).exit).toBe(4);
    const created = (await readdir(directory)).filter(name => !before.has(name)); expect(created).toHaveLength(1);
    file = resolve(directory, created[0]!, "instance.json"); original = await readFile(file, "utf8");
    await unlink(file);
    const status = await cli("status", "--project", project, "--json");
    expect(status.exit, status.stdout).toBe(0);
    expect(JSON.parse(status.stdout).data).toMatchObject({ state: "failed", ready: false, error: "RECOVERY_REQUIRED" });
    // A previous stopped receipt can remain visible before the next lock owner
    // publishes. The kernel lock, not that stale receipt, proves ownership.
    await writeFile(file, JSON.stringify({ ...JSON.parse(original), state: "stopped" }), { mode: 0o600 });
    const stale = await cli("status", "--project", project, "--json");
    expect(stale.exit).toBe(0);
    expect(JSON.parse(stale.stdout).data).toMatchObject({ state: "failed", ready: false, error: "RECOVERY_REQUIRED" });
  } finally {
    if (file && original) await writeFile(file, original, { mode: 0o600 });
    await cli("stop", "--project", project, "--json"); await rm(root, { recursive: true, force: true });
  }
});

test("missing instance records cannot hide uncertain resource evidence from status or stop", async () => {
  const { mkdir, mkdtemp, readdir, realpath, rm, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(resolve(await realpath((await import("node:os")).tmpdir()), "fleur-unpublished-resource-cli-")), project = resolve(root, "app");
  let directory: string | undefined;
  try {
    expect((await cli("new", project, "--no-git", "--json")).exit).toBe(0);
    const stateRoot = resolve(taskHome, ".local/state/fleur/development"), before = new Set(await readdir(stateRoot).catch(() => []));
    expect((await cli("stop", "--project", project, "--json")).exit).toBe(0);
    const created = (await readdir(stateRoot)).filter(name => !before.has(name)); expect(created).toHaveLength(1);
    directory = resolve(stateRoot, created[0]!);
    await mkdir(resolve(directory, "native"), { mode: 0o700 });
    // No real resource is created. An uninterpretable private creation record
    // cannot authorize cleanup, and must remain available for explicit recovery.
    const evidence = resolve(directory, "native", "unconfirmed-creation");
    await writeFile(evidence, "uncertain creation evidence", { mode: 0o600 });
    const status = await cliWithEnvironment({ PATH: resolve(root, "missing-tools") }, "status", "--project", project, "--json");
    expect(status.exit).toBe(0);
    expect(JSON.parse(status.stdout).data).toMatchObject({ state: "failed", ready: false, error: "RECOVERY_REQUIRED" });
    const stopped = await cliWithEnvironment({ PATH: resolve(root, "missing-tools") }, "stop", "--project", project, "--json");
    expect(stopped.exit).toBe(5);
    expect(JSON.parse(stopped.stdout).error.code).toBe("RECOVERY_REQUIRED");
    expect(await Bun.file(evidence).text()).toBe("uncertain creation evidence");
    const restarted = await cliWithEnvironment({ PATH: resolve(root, "missing-tools") }, "dev", "--background", "--project", project, "--json");
    expect(restarted.exit).toBe(5);
    expect(JSON.parse(restarted.stdout).error.code).toBe("RECOVERY_REQUIRED");
    // The fixture owns this inert record. Explicitly resolve the uncertainty,
    // then require a verified stop receipt before a new owner can be created.
    await rm(evidence);
    expect((await cli("stop", "--project", project, "--json")).exit).toBe(0);
    const recovered = await cli("status", "--project", project, "--json");
    expect(JSON.parse(recovered.stdout).data).toMatchObject({ state: "stopped", ready: false });
    const permitted = await cliWithEnvironment({ PATH: resolve(root, "missing-tools") }, "dev", "--background", "--project", project, "--json");
    expect(permitted.exit).toBe(4);
    expect(JSON.parse(permitted.stdout).error.code).toBe("PREREQUISITE_UNAVAILABLE");
  } finally {
    if (directory) await rm(resolve(directory, "native", "unconfirmed-creation"), { force: true });
    await cli("stop", "--project", project, "--json");
    if (directory) await rm(directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("stop refuses a redirected native resource directory without changing its foreign target", async () => {
  const { mkdir, mkdtemp, readdir, realpath, rm, symlink } = await import("node:fs/promises");
  const root = await mkdtemp(resolve(await realpath((await import("node:os")).tmpdir()), "fleur-redirected-resources-cli-")), project = resolve(root, "app"), foreign = resolve(root, "foreign");
  let directory: string | undefined;
  try {
    expect((await cli("new", project, "--no-git", "--json")).exit).toBe(0);
    const stateRoot = resolve(taskHome, ".local/state/fleur/development"), before = new Set(await readdir(stateRoot).catch(() => []));
    expect((await cli("stop", "--project", project, "--json")).exit).toBe(0);
    const created = (await readdir(stateRoot)).filter(name => !before.has(name)); expect(created).toHaveLength(1);
    directory = resolve(stateRoot, created[0]!);
    await mkdir(foreign, { mode: 0o700 }); await symlink(foreign, resolve(directory, "native"));
    const stopped = await cliWithEnvironment({ PATH: resolve(root, "missing-tools") }, "stop", "--project", project, "--json");
    expect(stopped.exit).toBe(5);
    expect(JSON.parse(stopped.stdout).error.code).toBe("RECOVERY_REQUIRED");
    expect(await readdir(foreign)).toEqual([]);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded log pages have authenticated cursors and failed-instance follow ends with finite JSON v1 completion", async () => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const root = await mkdtemp(resolve(await realpath((await import("node:os")).tmpdir()), "fleur-log-pages-cli-")), project = resolve(root, "app");
  try {
    expect((await cli("new", project, "--no-git", "--json")).exit).toBe(0);
    expect((await cliWithEnvironment({ PATH: resolve(root, "missing-tools") }, "dev", "--background", "--project", project, "--json")).exit).toBe(4);
    const first = await cli("logs", "--limit", "1", "--project", project, "--json"), firstPage = JSON.parse(first.stdout);
    expect(first.exit).toBe(0); expect(firstPage).toMatchObject({ formatVersion: 1, command: "logs", ok: true, truncated: true });
    expect(firstPage.data.logs).toHaveLength(1);
    expect(firstPage.data.cursor).toMatch(/^[0-9]+\.[a-f0-9]{64}$/);
    const next = await cli("logs", "--cursor", firstPage.data.cursor, "--project", project, "--json"), nextPage = JSON.parse(next.stdout);
    expect(next.exit).toBe(0);
    expect(nextPage.data.logs.length).toBeGreaterThan(0);
    expect(nextPage.data.logs.every((entry: {sequence:number}) => entry.sequence > firstPage.data.logs[0].sequence)).toBe(true);
    const cursor: string = firstPage.data.cursor, altered = cursor.slice(0,-1)+(cursor.endsWith("0") ? "1" : "0");
    const refused = await cli("logs", "--cursor", altered, "--project", project, "--json");
    expect(refused.exit).toBe(2); expect(JSON.parse(refused.stdout).error.code).toBe("ARGUMENT_INVALID");
    expect(refused.stdout).not.toContain(altered);
    const followed = await cli("logs", "--follow", "--limit", "1", "--project", project, "--json");
    expect(followed.exit).toBe(0);
    const events = followed.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index));
    expect(events.every(event => event.formatVersion === 1 && event.command === "logs")).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: "completed", data: { exitCode: 0, result: { formatVersion: 1, ok: true } } });
    for (const output of [first.stdout, next.stdout, refused.stdout, followed.stdout]) expect(output).not.toContain(root);
  } finally { await cli("stop", "--project", project, "--json"); await rm(root, { recursive: true, force: true }); }
});

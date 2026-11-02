import { expect, test } from "bun:test";
import { ownedPostgres } from "./owned-postgres";
import { sweepDevelopmentRootAfterRun } from "./run-sweep";
import { MaintenanceLease } from "../../src/runtime/database/maintenance";
import { startIdentity } from "../../src/runtime/development/state";
import { chromium, expect as browserExpect } from "@playwright/test";
import { mkdtemp, realpath, rm, writeFile, readdir, readFile, cp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = resolve(import.meta.dir, "../../bin/fleur.ts");
async function fixture(reactive = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "fleur-lifecycle-"));
  sweepDevelopmentRootAfterRun(root);
  const project = join(root, "app");
  const cliFor = (selectedProject: string, override: Record<string, string | undefined> = {}) => async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, executable, ...args, "--project", selectedProject, "--json"], { env: { ...process.env, HOME: root, DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"), FLEUR_PRIVATE_DATABASE_URL: undefined, FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL: undefined, FLEUR_PRIVATE_CONTROL_DATABASE_URL: undefined, FLEUR_PRIVATE_STATE_ROOT: undefined, ...override }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit, result: JSON.parse(stdout) };
  };
  const cli = cliFor(project);
  expect((await cli("new", project, "--no-git")).exit).toBe(0);
  await writeFile(join(project, "shared/pages.ts"), 'import { definePage } from "fleur/routing"; import { schema } from "fleur/schema"; export const home = definePage({ path: "/", params: schema.object({}) });\n');
  await writeFile(join(project, "server/home.tsx"), 'import { registerPage } from "fleur/server"; import { home } from "../shared/pages"; registerPage(home, { component: () => <main><h1>Local catalog</h1></main> });\n');
  if (reactive) {
    await rm(join(project, "server/home.tsx"));
    for (const directory of ["client", "server", "shared"]) await cp(join(import.meta.dir, "fixtures/reactive", directory), join(project, directory), { recursive: true });
    await writeFile(join(project, "seeds/items.ts"), 'import { defineSeed } from "fleur/database"; import { items } from "../server/items"; export const initial = defineSeed({ key: "initial", table: items, rows: [{ ownerKey: "one", values: { id: 1, name: "Alpha" } }] });\n');
    const generated = await cli("db", "migration", "generate");
    expect(generated.exit, generated.stdout).toBe(0);
  }
  return { root, project, cli, cliFor };
}

test("public background dev verifies readiness, reuses its owner and stops its persistent PostgreSQL", async () => {
  const { root, cli } = await fixture();
  try {
    const started = await cli("dev", "--background");
    expect(started.exit, started.stdout + started.stderr).toBe(0);
    expect(started.result.data).toMatchObject({ state: "ready", ready: true });
    expect((await fetch(started.result.data.url)).status).toBe(200);
    const repeated = await cli("dev", "--background");
    expect(repeated.exit).toBe(0);
    expect(repeated.result.data.instance).toBe(started.result.data.instance);
    expect(repeated.result.data.url).toBe(started.result.data.url);
    expect((await cli("status")).result.data).toMatchObject({ state: "ready", ready: true });
    expect((await cli("status")).result.data.database).toMatchObject({ connectivity: "connected", target: { kind: "development", database: "application" }, migrations: { compatible: true } });
    expect((await cli("stop")).result.data).toMatchObject({ state: "stopped", ready: false });
    expect((await cli("status")).exit).toBe(0);
    expect((await cli("status")).result.data).toMatchObject({ state: "stopped", ready: false });
  } finally {
    await cleanup(root, cli);
  }
}, 180_000);

async function cleanup(root: string, cli: Awaited<ReturnType<typeof fixture>>["cli"]) {
    const stopped = await cli("stop");
    expect(stopped.exit, stopped.stdout).toBe(0);
    const directory = join(root, ".local/state/fleur/development");
    for (const binding of await readdir(directory)) {
      let record;
      try { record = JSON.parse(await readFile(join(directory, binding, "postgres.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      expect(record.binding).toBe(binding);
      const inspect = Bun.spawn(["docker", "inspect", record.container, "--format", "{{json .}}"], { stdout: "pipe", stderr: "pipe" });
      const metadata = JSON.parse(await new Response(inspect.stdout).text());
      expect(await inspect.exited).toBe(0);
      expect(metadata.Config.Labels["dev.fleur.development-binding"]).toBe(binding);
      expect(metadata.State.Running).toBe(false);
      expect(metadata.Mounts[0].Name).toBe(record.volume);
      for (const args of [["rm", record.container], ["volume", "rm", record.volume]]) {
        const remove = Bun.spawn(["docker", ...args], { stdout: "ignore", stderr: "pipe" });
        expect(await remove.exited, await new Response(remove.stderr).text()).toBe(0);
      }
    }
    await rm(root, { recursive: true, force: true });
}

test("separate public dev-stop-dev processes preserve mutations, migration history and retained backups", async () => {
  const { root, cli } = await fixture(true);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const first = await cli("dev", "--background");
    expect(first.exit, first.stdout).toBe(0);
    expect(first.result.data.initialization.status).toBe("initialized");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(new URL("/reactive", first.result.data.url).href);
    await page.getByRole("textbox", { name: "Draft 1", exact: true }).fill("Retained edit");
    await page.getByRole("button", { name: "Save 1", exact: true }).click();
    await browserExpect(page.getByLabel("Save status 1", { exact: true })).toHaveText("success");
    await browserExpect(page.getByLabel("Live names", { exact: true })).toHaveText("Retained edit", { timeout: 10000 });
    let submitted = 0;
    await page.route("**/__fleur/mutation", async route => {
      submitted++;
      const acknowledged = await route.fetch();
      expect(acknowledged.status()).toBe(200);
      await route.abort("failed"); // The server committed; the caller loses only its acknowledgement.
    });
    await page.getByRole("textbox", { name: "Draft 1", exact: true }).fill("Unknown commit");
    await page.getByRole("button", { name: "Save 1", exact: true }).click();
    await browserExpect(page.getByLabel("Save status 1", { exact: true })).toHaveText("outcome-unknown");
    await browserExpect(page.getByLabel("Live names", { exact: true })).toHaveText("Unknown commit", { timeout: 10000 });
    const rows = await cli("db", "inspect", "--table", "reactive_items");
    expect(rows.exit, rows.stdout).toBe(0);
    expect(rows.result.data.rows).toEqual([{ id: "1", name: "Unknown commit", version: "3" }]);
    expect(submitted).toBe(1);
    await page.unroute("**/__fleur/mutation");
    const history = await cli("db", "migration", "status");
    expect(history.exit, history.stdout).toBe(0);
    expect(history.result.data.migrations).toMatchObject({ applied: ["0001"], pending: [], drift: false });
    const backup = join(root, "retained.dump");
    const saved = await cli("db", "backup", "--out", backup);
    expect(saved.exit, saved.stdout).toBe(0);
    const bytes = await readFile(backup), manifest = await readFile(backup+".manifest.json");
    expect((await cli("stop")).exit).toBe(0);
    expect(await readFile(backup)).toEqual(bytes);
    expect(await readFile(backup+".manifest.json")).toEqual(manifest);
    const second = await cli("dev", "--background");
    expect(second.exit, second.stdout).toBe(0);
    expect(second.result.data.instance).not.toBe(first.result.data.instance);
    expect(second.result.data.initialization.status).toBe("existing");
    await page.goto(new URL("/reactive", second.result.data.url).href);
    await browserExpect(page.getByLabel("Live names", { exact: true })).toHaveText("Unknown commit", { timeout: 10000 });
    expect((await cli("db", "migration", "status")).result.data.migrations).toEqual(history.result.data.migrations);
    expect(await readFile(backup)).toEqual(bytes);
    expect(await readFile(backup+".manifest.json")).toEqual(manifest);
  } finally { await browser?.close(); await cleanup(root, cli); }
}, 240_000);

test("an abruptly killed real foreground PTY session stops only its owned instance", async () => {
  const { root, project, cli } = await fixture();
  try {
    const terminal = Bun.spawn(["python3", join(import.meta.dir, "lifecycle-terminal.py"), process.execPath, executable, project], { env: { ...process.env, HOME: root, DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(homedir(), ".docker") }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(terminal.stdout).text(), new Response(terminal.stderr).text(), terminal.exited]);
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ ready: true, sessionKilled: true });
    expect(result.events[0]).toMatchObject({ formatVersion: 1, command: "dev", sequence: 0, event: "starting" });
    expect(result.events.map((event: { sequence: number }) => event.sequence)).toEqual(result.events.map((_: unknown, index: number) => index));
    await browserExpect.poll(async () => { const observed = await cli("status"); expect(observed.exit, observed.stdout).toBe(0); return observed.result.data.state; }, { timeout: 15000 }).toBe("stopped");
  } finally { await cleanup(root, cli); }
}, 180_000);

test("invalid source preserves the usable app; corrected source retains the open browser's draft and loads on explicit navigation", async () => {
  const { root, project, cli } = await fixture(true);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const started = await cli("dev", "--background");
    expect(started.exit, started.stdout).toBe(0);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(new URL("/reactive", started.result.data.url).href);
    await browserExpect(page.getByRole("heading", { name: "Reactive items" })).toBeVisible();
    const draft = page.getByRole("textbox", { name: "Draft 1", exact: true });
    await draft.fill("Unsaved across source replacement");
    await page.getByRole("button", { name: "Clicks 0", exact: true }).click();
    await draft.focus();
    await page.evaluate(() => { (globalThis as unknown as { originalDraft: Element | null }).originalDraft = document.activeElement; });
    const originalEntry = await page.locator("script[type=module][src]").getAttribute("src");
    expect(originalEntry).toBeString();
    const server = join(project, "server/items.tsx"), client = join(project, "client/Views.tsx");
    const valid = await readFile(server, "utf8");
    await writeFile(server, valid+'\nimport { readFile } from "node:fs";\n');
    await browserExpect.poll(async () => (await cli("logs")).result.data.logs.some((entry: { code: string }) => entry.code === "SOURCE_REJECTED"), { timeout: 10000 }).toBe(true);
    expect((await cli("status")).result.data).toMatchObject({ state: "ready", ready: true, generation: 1, error: "SOURCE_REJECTED" });
    await browserExpect(page.getByRole("heading", { name: "Reactive items" })).toBeVisible();
    expect((await fetch(new URL("/reactive", started.result.data.url))).status).toBe(200);
    await writeFile(client, (await readFile(client, "utf8")).replace("Clicks {clicks}", "Taps {clicks}"));
    await writeFile(server, valid.replace("<h1>Reactive items</h1>", "<h1>Corrected catalog</h1>"));
    await browserExpect.poll(async () => (await cli("status")).result.data, { timeout: 90000 }).toMatchObject({ state: "ready", ready: true, generation: 2, error: null });
    // The fixture island awaits a mutation result inside its save handler, which
    // is outside the bounded automatic-replacement proof. The open browser keeps
    // the last valid generation, draft and focus, and says to navigate explicitly.
    await browserExpect(page.getByText("Navigate or reload explicitly")).toBeVisible({ timeout: 30000 });
    await browserExpect(page.getByRole("heading", { name: "Reactive items" })).toBeVisible();
    await browserExpect(page.getByRole("button", { name: "Clicks 1", exact: true })).toBeVisible();
    await browserExpect(draft).toHaveValue("Unsaved across source replacement");
    await browserExpect(draft).toBeFocused();
    expect(await page.evaluate(() => (globalThis as unknown as { originalDraft: Element }).originalDraft === document.activeElement)).toBe(true);
    await browserExpect(page.getByRole("region", { name: "Draft 1", exact: true })).toContainText("Mounts 1");
    expect((await cli("logs")).result.data.logs.some((entry: { code: string }) => entry.code === "CLIENT_NAVIGATION_REQUIRED")).toBe(true);
    // Retained browser assets stay available to the old view until stop.
    expect((await fetch(new URL(originalEntry!, started.result.data.url))).status).toBe(200);
    // Explicit navigation loads the corrected server and island source.
    await page.reload();
    await browserExpect(page.getByRole("heading", { name: "Corrected catalog" })).toBeVisible({ timeout: 30000 });
    await browserExpect(page.getByRole("button", { name: "Taps 0", exact: true })).toBeVisible();
    expect(await page.locator("script[type=module][src]").getAttribute("src")).not.toBe(originalEntry);
    const first = await cli("logs", "--limit", "2");
    expect(first.result.truncated).toBe(true);
    expect(first.result.data.logs).toHaveLength(2);
    const next = await cli("logs", "--limit", "2", "--cursor", first.result.data.cursor);
    expect(next.result.data.logs).toHaveLength(2);
    expect(next.result.data.logs[0].sequence).toBeGreaterThan(first.result.data.logs[1].sequence);
  } finally { await browser?.close(); await cleanup(root, cli); }
}, 240_000);

test("racing public starts share one owner while a full checkout copy has independent storage and shutdown", async () => {
  const { root, project, cli, cliFor } = await fixture();
  const copied = join(root, "copy"), second = cliFor(copied);
  try {
    const [left, right] = await Promise.all([cli("dev", "--background"), cli("dev", "--background")]);
    expect(left.exit, left.stdout).toBe(0); expect(right.exit, right.stdout).toBe(0);
    expect(left.result.data.instance).toBe(right.result.data.instance);
    expect(left.result.data.url).toBe(right.result.data.url);
    // Include ignored runtime files deliberately; machine binding must not travel with the checkout.
    await writeFile(join(project, ".fleur", "copied-runtime.json"), JSON.stringify({ instance: left.result.data.instance }));
    await cp(project, copied, { recursive: true });
    const independent = await second("dev", "--background");
    expect(independent.exit, independent.stdout).toBe(0);
    expect(independent.result.data.instance).not.toBe(left.result.data.instance);
    expect(independent.result.data.url).not.toBe(left.result.data.url);
    expect((await readdir(join(root, ".local/state/fleur/development"))).length).toBe(2);
    const stopped = await Promise.all([second("stop"), second("stop")]);
    for (const result of stopped) expect(result.exit, result.stdout).toBe(0);
    expect((await cli("status")).result.data).toMatchObject({ state: "ready", instance: left.result.data.instance });
    expect((await fetch(left.result.data.url)).status).toBe(200);
  } finally { await second("stop"); await cleanup(root, cli); }
}, 240_000);

test("an incompatible source schema blocks database authority in the retained generation", async () => {
  const { root, project, cli } = await fixture(true);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const started = await cli("dev", "--background");
    expect(started.exit, started.stdout).toBe(0);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(new URL("/reactive", started.result.data.url).href);
    await browserExpect(page.getByRole("textbox", { name: "Draft 1", exact: true })).toBeVisible();
    const path = join(project, "server/items.tsx"), original = await readFile(path, "utf8");
    await writeFile(path, original.replace('name: column.string() }', 'name: column.string(), added: column.string().nullable() }'));
    const seed = join(project, "seeds/items.ts");
    await writeFile(seed, (await readFile(seed, "utf8")).replace('name: "Alpha"', 'name: "Alpha", added: null'));
    await browserExpect.poll(async () => (await cli("logs")).result.data.logs.some((entry: { code: string }) => ["SCHEMA_DRIFT", "MIGRATIONS_PENDING"].includes(entry.code)), { timeout: 90000 }).toBe(true);
    await page.getByRole("textbox", { name: "Draft 1", exact: true }).fill("Must not write");
    await page.getByRole("button", { name: "Save 1", exact: true }).click();
    await browserExpect(page.getByLabel("Save status 1", { exact: true })).toHaveText("failure");
    const inspected = await cli("db", "inspect", "--table", "reactive_items");
    expect(inspected.exit, inspected.stdout).toBe(0);
    expect(JSON.stringify(inspected.result.data)).toContain("Alpha");
    expect(JSON.stringify(inspected.result.data)).not.toContain("Must not write");
    expect((await cli("status")).result.data).toMatchObject({ ready: false, state: "maintenance", generation: 1 });
  } finally { await browser?.close(); await cleanup(root, cli); }
}, 240_000);

test("explicit occupied ports fail promptly and automatic broad binding warns while database stays local", async () => {
  const { root, cli } = await fixture();
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unrelated owner") });
  try {
    const start = performance.now();
    const failed = await cli("dev", "--background", "--port", String(occupied.port));
    expect(failed.exit).toBe(4);
    expect(failed.result.error.code).toBe("PORT_OCCUPIED");
    expect(performance.now() - start).toBeLessThan(5000);
    expect(await (await fetch(occupied.url)).text()).toBe("unrelated owner");
    expect((await cli("stop")).exit).toBe(0);
    const broad = await cli("dev", "--background", "--host", "0.0.0.0");
    expect(broad.exit, broad.stdout).toBe(0);
    expect(broad.stderr).toContain("v1 has no authentication");
    const reachable = new URL(broad.result.data.url); reachable.hostname = "127.0.0.1";
    expect((await fetch(reachable)).status).toBe(200);
    expect(Number(new URL(broad.result.data.url).port)).toBeGreaterThanOrEqual(3000);
    const directory = join(root, ".local/state/fleur/development"), names = await readdir(directory);
    const record = JSON.parse(await readFile(join(directory, names[0]!, "postgres.json"), "utf8"));
    const inspect = Bun.spawn(["docker", "inspect", record.container, "--format", "{{json .HostConfig.PortBindings}}"], { stdout: "pipe", stderr: "pipe" });
    const ports = JSON.parse(await new Response(inspect.stdout).text());
    expect(await inspect.exited).toBe(0);
    expect(ports["5432/tcp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: "" }]);
  } finally { await occupied.stop(true); await cleanup(root, cli); }
}, 240_000);

test("a superseded reload cannot publish after a later source snapshot was saved", async () => {
  const { root, project, cli } = await fixture();
  try {
    const first = await cli("dev", "--background");
    expect(first.exit, first.stdout).toBe(0);
    const file = join(project, "server/home.tsx"), original = await readFile(file, "utf8");
    await writeFile(file, original.replace("Local catalog", "Superseded A"));
    await browserExpect.poll(async () => (await cli("logs")).result.data.logs.filter((entry: { code: string }) => entry.code === "CLIENT_COMPILED").length, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
    await writeFile(file, original.replace("Local catalog", "Latest B"));
    await browserExpect.poll(async () => (await cli("status")).result.data.generation, { timeout: 90000 }).toBe(2);
    const html = await (await fetch(first.result.data.url)).text();
    expect(html).toContain("Latest B");
    expect(html).not.toContain("Superseded A");
    expect((await cli("status")).result.data).toMatchObject({ ready: true, generation: 2 });
  } finally { await cleanup(root, cli); }
}, 240_000);


async function privateDatabase(root: string) {
  const directory = join(root, ".local/state/fleur/development"), names = await readdir(directory);
  expect(names).toHaveLength(1);
  const state = join(directory, names[0]!);
  const record = JSON.parse(await readFile(join(state, "postgres.json"), "utf8"));
  const inspect = Bun.spawn(["docker", "inspect", record.container, "--format", "{{json .NetworkSettings.Ports}}"], { stdout: "pipe", stderr: "pipe" });
  const ports = JSON.parse(await new Response(inspect.stdout).text());
  expect(await inspect.exited).toBe(0);
  expect(ports["5432/tcp"][0].HostIp).toBe("127.0.0.1");
  const url = `postgres://fleur:${record.password}@127.0.0.1:${ports["5432/tcp"][0].HostPort}/application`;
  return { url, record, state, config: { stateRoot: join(state, "maintenance"), controlUrl: url.replace(/\/application$/, "/postgres") } };
}

test("ordinary stop cannot interrupt a shared maintenance owner and succeeds after verified release", async () => {
  const { root, cli } = await fixture();
  let maintenance: MaintenanceLease | undefined;
  try {
    const started = await cli("dev", "--background");
    expect(started.exit, started.stdout).toBe(0);
    const database = await privateDatabase(root);
    maintenance = await MaintenanceLease.acquire(database.url, true, database.config);
    const stop = await cli("stop");
    expect(stop.exit, stop.stdout).toBe(5);
    expect(stop.result.error.code).toBe("MAINTENANCE_BUSY");
    await maintenance.assertSession();
    expect((await cli("status")).result.data).toMatchObject({ state: "maintenance", ready: false });
    await maintenance.close(); maintenance = undefined;
    expect((await cli("stop")).exit).toBe(0);
  } finally { await maintenance?.close(); await cleanup(root, cli); }
}, 180_000);

test("a live unrelated PID with a stale start identity never grants stop authority", async () => {
  const { root, cli } = await fixture();
  const unrelated = Bun.spawn(["/bin/sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let file: string | undefined, original: string | undefined;
  try {
    const started = await cli("dev", "--background");
    expect(started.exit, started.stdout).toBe(0);
    const database = await privateDatabase(root);
    file = join(database.state, "instance.json"); original = await readFile(file, "utf8");
    const record = JSON.parse(original);
    await writeFile(file, JSON.stringify({ ...record, pid: unrelated.pid }));
    const status = await cli("status");
    expect(status.exit, status.stdout).toBe(0);
    expect(status.result.data).toMatchObject({ state: "failed", ready: false, error: "INSTANCE_UNAVAILABLE" });
    expect((await cli("stop")).exit).toBe(5);
    expect(unrelated.exitCode).toBeNull();
    expect((await fetch(started.result.data.url)).status).toBe(200);
    await writeFile(file, original); original = undefined;
    expect((await cli("stop")).exit).toBe(0);
  } finally {
    if (file && original) await writeFile(file, original);
    unrelated.kill("SIGKILL"); await unrelated.exited;
    await cleanup(root, cli);
  }
}, 180_000);

test("foreign same-name containers and volumes are never adopted or removed", async () => {
  const { root, cli } = await fixture();
  const owner = crypto.randomUUID(), label = `fleur.lifecycle.foreign-fixture=${owner}`;
  let container: string | undefined, volume: string | undefined;
  const docker = async (...args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text(), stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0); return stdout.trim();
  };
  try {
    expect((await cli("stop")).exit).toBe(0);
    const names = await readdir(join(root, ".local/state/fleur/development"));
    expect(names).toHaveLength(1);
    const name = `fleur-dev-${names[0]}`;
    container = await docker("create", "--name", name, "--label", label, "--tmpfs", "/var/lib/postgresql", "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336");
    const rejected = await cli("dev", "--background");
    expect(rejected.exit, rejected.stdout).toBe(5);
    expect((await cli("stop")).exit).toBe(0);
    expect(await docker("inspect", container, "--format", '{{index .Config.Labels "fleur.lifecycle.foreign-fixture"}}')).toBe(owner);
    await docker("rm", container); container = undefined;
    volume = await docker("volume", "create", "--label", label, name);
    const refused = await cli("dev", "--background");
    expect(refused.exit, refused.stdout).toBe(5);
    expect((await cli("stop")).exit).toBe(0);
    expect(await docker("volume", "inspect", volume, "--format", '{{index .Labels "fleur.lifecycle.foreign-fixture"}}')).toBe(owner);
  } finally {
    if (container) { expect(await docker("inspect", container, "--format", '{{index .Config.Labels "fleur.lifecycle.foreign-fixture"}}')).toBe(owner); await docker("rm", container); }
    if (volume) { expect(await docker("volume", "inspect", volume, "--format", '{{index .Labels "fleur.lifecycle.foreign-fixture"}}')).toBe(owner); await docker("volume", "rm", volume); }
    await cleanup(root, cli);
  }
}, 180_000);

test("stop during startup closes inherited ownership before a late candidate can publish", async () => {
  const { root, cli } = await fixture();
  try {
    const timed = await cli("dev", "--background", "--timeout", "0.01");
    expect(timed.exit, timed.stdout).toBe(4);
    expect(timed.result.error.code).toBe("READINESS_TIMEOUT");
    await browserExpect.poll(async () => (await cli("stop")).exit, { timeout: 60000 }).toBe(0);
    for (let repeat = 0; repeat < 2; repeat++) {
      const status = await cli("status");
      expect(status.exit, status.stdout).toBe(0);
      expect(status.result.data).toMatchObject({ state: "stopped", ready: false });
      const directory = join(root, ".local/state/fleur/development");
      for (const binding of await readdir(directory)) {
        const file = join(directory, binding, "postgres.json");
        try {
          const record = JSON.parse(await readFile(file, "utf8"));
          const inspect = Bun.spawn(["docker", "inspect", record.container, "--format", "{{.State.Running}}"], { stdout: "pipe", stderr: "pipe" });
          expect((await new Response(inspect.stdout).text()).trim()).toBe("false");
          expect(await inspect.exited).toBe(0);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  } finally { await cleanup(root, cli); }
}, 120_000);


test("ambient private database configuration cannot redirect development ownership to another cluster", async () => {
  const { root, project, cli, cliFor } = await fixture();
  const foreign = await ownedPostgres();
  const redirected = cliFor(project, { FLEUR_PRIVATE_DATABASE_URL: foreign.url, FLEUR_PRIVATE_CONTROL_DATABASE_URL: foreign.url, FLEUR_PRIVATE_STATE_ROOT: join(root, "foreign-state") });
  try {
    const started = await redirected("dev", "--background");
    expect(started.exit, started.stdout).toBe(0);
    expect((await foreign.sql.unsafe("SELECT datname FROM pg_database WHERE datname='application'")).length).toBe(0);
    const owned = await privateDatabase(root);
    expect(new URL(owned.url).port).not.toBe(new URL(foreign.url).port);
    expect((await cli("status")).result.data).toMatchObject({ state: "ready", ready: true });
  } finally { await cleanup(root, cli); await foreign.cleanup(); }
}, 180_000);

test("dynamic-only pages satisfy rendering and reactive readiness without a static fixture route", async () => {
  const { root, project, cli } = await fixture();
  try {
    await writeFile(join(project, "shared/pages.ts"), 'import { definePage } from "fleur/routing"; import { schema } from "fleur/schema"; export const detail = definePage({ path: "/catalog/:kind", params: schema.object({ kind: schema.enum(["neutral", "other"]) }) });\n');
    await writeFile(join(project, "server/home.tsx"), 'import { registerPage } from "fleur/server"; import { detail } from "../shared/pages"; registerPage(detail, { component: ({ params }) => <main><h1>Catalog {params.kind}</h1></main> });\n');
    const started = await cli("dev", "--background");
    expect(started.exit, started.stdout).toBe(0);
    expect(started.result.data).toMatchObject({ state: "ready", ready: true });
    expect(await (await fetch(new URL("/catalog/neutral", started.result.data.url))).text()).toContain("Catalog neutral");
  } finally { await cleanup(root, cli); }
}, 180_000);

for (const mode of ["background", "attached"] as const) test(`real PTY death of a ${mode} launcher preserves the existing background owner`, async () => {
  const { root, project, cli } = await fixture();
  try {
    const owner = mode === "attached" ? await cli("dev", "--background") : undefined;
    if (owner) expect(owner.exit, owner.stdout).toBe(0);
    const terminal = Bun.spawn(["python3", join(import.meta.dir, "lifecycle-terminal.py"), process.execPath, executable, project, mode], { env: { ...process.env, HOME: root, DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(homedir(), ".docker") }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(terminal.stdout).text(), new Response(terminal.stderr).text(), terminal.exited]);
    expect(exit, stderr).toBe(0); expect(JSON.parse(stdout).ready).toBe(true);
    const status = await cli("status");
    expect(status.exit, status.stdout).toBe(0); expect(status.result.data).toMatchObject({ ready: true, state: "ready" });
    if (owner) expect(status.result.data.instance).toBe(owner.result.data.instance);
    expect((await fetch(status.result.data.url)).status).toBe(200);
  } finally { await cleanup(root, cli); }
}, 180000);

for (const victim of ["supervisor", "database"] as const) test(`a ${victim} crash stays failed on observation and requires explicit stop and dev`, async () => {
  const { root, project, cli } = await fixture();
  try {
    const started = await cli("dev", "--background"); expect(started.exit, started.stdout).toBe(0);
    const database = await privateDatabase(root), record = JSON.parse(await readFile(join(database.state, "instance.json"), "utf8"));
    expect(record.instance).toBe(started.result.data.instance);
    if (victim === "supervisor") {
      const identity = await startIdentity(record.pid);
      expect(identity).not.toBeNull();
      expect(identity).toBe(record.start);
      process.kill(record.pid, "SIGKILL");
    }
    else {
      const file = join(project, "server/home.tsx");
      await writeFile(file, (await readFile(file, "utf8")).replace("Local catalog", "Candidate after crash"));
      await browserExpect.poll(async () => (await cli("logs")).result.data.logs.filter((entry: { code: string }) => entry.code === "CLIENT_COMPILED").length, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
      const metadata = Bun.spawn(["docker", "inspect", database.record.container, "--format", '{{index .Config.Labels "dev.fleur.development-binding"}}'], { stdout: "pipe", stderr: "pipe" });
      expect((await new Response(metadata.stdout).text()).trim()).toBe(database.record.binding); expect(await metadata.exited).toBe(0);
      const killed = Bun.spawn(["docker", "kill", database.record.container], { stdout: "ignore", stderr: "pipe" });
      expect(await killed.exited, await new Response(killed.stderr).text()).toBe(0);
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      const status = await cli("status"); expect(status.exit, status.stdout).toBe(0);
      expect(status.result.data).toMatchObject({ state: "failed", ready: false, instance: record.instance });
      expect((await cli("dev", "--background")).exit).not.toBe(0);
      const logs = await cli("logs"); expect(logs.exit, logs.stdout).toBe(0); expect(logs.result.data.logs.length).toBeGreaterThan(0);
    }
    if (victim === "database") {
      // Even explicit infrastructure recovery cannot let an in-flight reload
      // silently restart the failed application owner.
      const restartedDatabase = Bun.spawn(["docker", "start", database.record.container], { stdout: "ignore", stderr: "pipe" });
      expect(await restartedDatabase.exited, await new Response(restartedDatabase.stderr).text()).toBe(0);
      expect((await cli("status")).result.data).toMatchObject({ state: "failed", ready: false, instance: record.instance });
    }
    expect((await cli("stop")).exit).toBe(0);
    const restarted = await cli("dev", "--background"); expect(restarted.exit, restarted.stdout).toBe(0);
    expect(restarted.result.data).toMatchObject({ ready: true, state: "ready" });
    expect(restarted.result.data.instance).not.toBe(record.instance);
    expect(restarted.result.data.initialization.status).toBe("existing");
  } finally { await cleanup(root, cli); }
}, 240000);

test("a departed maintenance owner's uncertain durable stage blocks stop until shared state-verifying reconciliation", async () => {
  const { root, project, cli } = await fixture();
  let database: Awaited<ReturnType<typeof privateDatabase>> | undefined;
  let maintenance: MaintenanceLease | undefined, uncertain = false;
  const { inspectMaintenance, reconcileMaintenance } = await import("../../src/runtime/database/recovery");
  try {
    const started = await cli("dev", "--background"); expect(started.exit, started.stdout).toBe(0);
    database = await privateDatabase(root);
    const before = await inspectMaintenance(database.url, database.config); expect(before.actual).not.toBeNull();
    maintenance = await MaintenanceLease.acquire(database.url, true, database.config);
    // Model owner loss after durable intent, before any database mutation.
    await maintenance.persist({ formatVersion: 1, target: maintenance.target, stage: "applying", planChecksum: "a".repeat(64), backup: null, epoch: crypto.randomUUID(), intent: { operation: "migration", beforeSchema: before.actual!.schema, beforeData: before.actual!.data, beforeHistory: before.actual!.history, afterSchema: null, afterHistory: null } });
    const marker = await maintenance.marker(); uncertain = true;
    await maintenance.close(); maintenance = undefined;
    const inspection = await cli("db", "recover", "--inspect"); expect(inspection.exit, inspection.stdout).toBe(0);
    expect((await inspectMaintenance(database.url, database.config)).maintenance).toEqual(marker);
    const stop = await cli("stop"); expect(stop.exit, stop.stdout).toBe(5);
    expect(stop.result.error.code).toBe("RECOVERY_REQUIRED");
    expect((await cli("status")).result.data).toMatchObject({ ready: false });
    const proof = await reconcileMaintenance(database.url, project, { ...database.config, confirm: async approval => approval.action === "reconcile" });
    expect(proof).toMatchObject({ applied: [], reconciled: "rollback verified" }); uncertain = false;
    expect((await inspectMaintenance(database.url, database.config)).actual).toEqual(before.actual);
    expect((await cli("stop")).exit).toBe(0);
  } finally {
    await maintenance?.close();
    if (uncertain && database) await reconcileMaintenance(database.url, project, { ...database.config, confirm: async approval => approval.action === "reconcile" });
    await cleanup(root, cli);
  }
}, 180000);

test("a save during verified retirement never publishes the superseded candidate and preserves the last valid app", async () => {
  const { root, project, cli } = await fixture();
  const paused: string[] = [];
  const docker = async (...args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0); return stdout.trim();
  };
  try {
    const started = await cli("dev", "--background"); expect(started.exit, started.stdout).toBe(0);
    const database = await privateDatabase(root), file = join(project, "server/home.tsx"), source = await readFile(file, "utf8");
    // Wait for the existing bounded warm window to end before pausing idle
    // controllers. No preparation timeout may substitute for the retirement race.
    await browserExpect.poll(async () => {
      const execution = (await cli("status")).result.data.execution;
      return execution && execution.starting === 0 && execution.prepared === 0 && execution.idle === execution.occupied && execution.occupied > 0;
    }, { timeout: 65000 }).toBe(true);
    const containers = (await docker("ps", "-q", "--no-trunc", "--filter", `label=dev.fleur.development-binding=${database.record.binding}`)).split("\n").filter(Boolean);
    for (const id of containers) {
      const metadata = JSON.parse(await docker("inspect", id, "--format", "{{json .}}"));
      if (!metadata.Name.startsWith("/fleur-exec-controller-")) continue;
      const owner = metadata.Config.Labels["dev.fleur.execution-owner"];
      expect(metadata.Config.Labels["dev.fleur.development-binding"]).toBe(database.record.binding);
      const names = await readdir(join(database.state, "native"));
      let verified = false;
      for (const name of names.filter(name => name.startsWith("fleur-retained-lease-"))) {
        const record = JSON.parse(await readFile(join(database.state, "native", name, "lease.json"), "utf8"));
        if (record.owner === owner && record.images.controller === metadata.Image) verified = true;
      }
      expect(verified).toBe(true); expect(metadata.Id).toBe(id);
      await docker("pause", id); paused.push(id);
    }
    expect(paused.length).toBeGreaterThan(0);
    await writeFile(file, source.replace("Local catalog", "Superseded A"));
    await browserExpect.poll(async () => (await cli("logs")).result.data.logs.some((entry: { code: string }) => entry.code === "DRAINING"), { timeout: 90000 }).toBe(true);
    await writeFile(file, source+'\nimport { readFile } from "node:fs";\n');
    while (paused.length) { await docker("unpause", paused[0]!); paused.shift(); }
    await browserExpect.poll(async () => (await cli("status")).result.data, { timeout: 90000 }).toMatchObject({ state: "ready", ready: true, generation: 1, error: "SOURCE_REJECTED" });
    const retained = await (await fetch(started.result.data.url)).text();
    expect(retained).toContain("Local catalog"); expect(retained).not.toContain("Superseded A");
    await writeFile(file, source.replace("Local catalog", "Latest B"));
    await browserExpect.poll(async () => (await cli("status")).result.data, { timeout: 90000 }).toMatchObject({ state: "ready", ready: true, generation: 2, error: null });
    expect(await (await fetch(started.result.data.url)).text()).toContain("Latest B");
  } finally {
    const resumed = await Promise.allSettled(paused.map(id => docker("unpause", id)));
    try { await cleanup(root, cli); }
    finally { expect(resumed.filter(result => result.status === "rejected"), "Every paused owned controller must resume or report failed cleanup").toEqual([]); }
  }
}, 300000);

test("presentation asset bytes participate in admission snapshots and invalid edits preserve the last valid asset", async () => {
  const { root, project, cli } = await fixture();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const { mkdir } = await import("node:fs/promises");
  try {
    await mkdir(join(project, "assets"), { recursive: true });
    const file = join(project, "assets/badge.svg"), svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><path fill="red" d="M0 0h8v8H0z"/></svg>';
    await writeFile(file, svg);
    await writeFile(join(project, "server/home.tsx"), 'import { registerPage } from "fleur/server"; import { home } from "../shared/pages"; import badge from "../assets/badge.svg"; registerPage(home, { component: () => <main><h1>Local catalog</h1><img src={badge} alt="Catalog badge"/></main> });');
    const started = await cli("dev", "--background"); expect(started.exit, started.stdout).toBe(0);
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.goto(started.result.data.url);
    await browserExpect(page.getByRole("img", { name: "Catalog badge" })).toHaveJSProperty("naturalWidth", 8);
    const url = new URL("/assets/badge.svg", started.result.data.url);
    expect(await (await fetch(url)).text()).toBe(svg);
    const corrected = svg.replace('fill="red"', 'fill="blue"'); await writeFile(file, corrected);
    await browserExpect.poll(async () => (await cli("status")).result.data.generation, { timeout: 90000 }).toBe(2);
    expect(await (await fetch(url)).text()).toBe(corrected);
    await writeFile(file, corrected.replace("</svg>", "<script>throw 1</script></svg>"));
    await browserExpect.poll(async () => (await cli("status")).result.data.error, { timeout: 10000 }).toBe("SOURCE_REJECTED");
    expect(await (await fetch(url)).text()).toBe(corrected);
    expect((await cli("status")).result.data).toMatchObject({ state: "ready", ready: true, generation: 2 });
    await page.reload(); await browserExpect(page.getByRole("img", { name: "Catalog badge" })).toHaveJSProperty("naturalWidth", 8);
  } finally { await browser?.close(); await cleanup(root, cli); }
}, 240000);

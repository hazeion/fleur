import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MaintenanceLease } from "../../src/runtime/database/maintenance";
import { applyMigrations } from "../../src/runtime/database/migrations";
import { admitProject } from "../../src/runtime/build/admission";
import { writeArtifact } from "../../src/runtime/production/build";
import { ownedPostgres } from "./owned-postgres";

// Requirements: issue #36. One real build is shared; every start uses public commands.
const repository = resolve(import.meta.dir, "../..");
const executable = join(repository, "bin/fleur.ts");
const canary = "production-secret-canary-3f1c";
const launchers = new Set<{ kill(signal?: number | NodeJS.Signals): void; readonly exited: Promise<number> }>();
let directHits = 0, listener: ReturnType<typeof Bun.serve> | undefined, hostile: string;
let root: string, project: string, artifact: string, shim: string, commands: string, database: Awaited<ReturnType<typeof ownedPostgres>>;
const stateRoot = () => join(root, "database-state");
const credentials = JSON.stringify({ probe: { origin: "http://probe.fixture.test:4173", header: "authorization", value: canary } });
const dockerConfig = process.env.DOCKER_CONFIG ?? join(homedir(), ".docker");
function environment(extra: Record<string, string | undefined> = {}) {
  return { PATH: `${shim}:${process.env.PATH}`, HOME: root, TMPDIR: root, DOCKER_CONFIG: dockerConfig, DOCKER_HOST: process.env.DOCKER_HOST, BUN_INSTALL_CACHE_DIR: join(root, "no-cache"), FLEUR_DOCKER_LOG: commands, FLEUR_PRIVATE_STATE_ROOT: stateRoot(), FLEUR_PRIVATE_DATABASE_URL: database.url, FLEUR_RETRIEVAL_CREDENTIALS: credentials, FLEUR_CANARY: canary, ...extra };
}
async function finite(args: string[], extra: Record<string, string | undefined> = {}, cwd = root) {
  const child = Bun.spawn([process.execPath, executable, ...args, "--json"], { cwd, env: environment(extra), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit, lines: stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) };
}
type Started = { url: string; stop(signal?: "SIGTERM" | "SIGINT"): Promise<{ exit: number; output: string }>; output(): string };
/** Foreground start until its first terminal event; fails the test with what it printed otherwise. */
async function start(args: string[] = [], extra: Record<string, string | undefined> = {}, selected = artifact): Promise<Started> {
  const child = Bun.spawn([process.execPath, executable, "start", "--artifact", selected, "--timeout", "240", "--json", ...args], { cwd: root, env: environment(extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  launchers.add(child);
  let text = "", errors = "";
  void (async () => { for await (const chunk of child.stderr) errors += new TextDecoder().decode(chunk); })();
  const reader = child.stdout.getReader();
  const pump = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      text += new TextDecoder().decode(next.value);
    }
  })();
  const ready = (): { url: string } | undefined => {
    for (const line of text.split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as { event?: string; data?: { url?: string } };
      if (event.event === "ready") return { url: event.data!.url! };
    }
    return undefined;
  };
  const deadline = Date.now() + 240_000;
  while (!ready()) {
    if (child.exitCode !== null) { await pump; throw new Error(`start exited ${child.exitCode}: ${text}\n${errors}`); }
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error(`start did not become ready: ${text}\n${errors}`); }
    await Bun.sleep(100);
  }
  return { url: ready()!.url, output: () => text + errors, async stop(signal = "SIGTERM") {
    child.kill(signal);
    const exit = await child.exited; await pump;
    return { exit, output: text + errors };
  } };
}
/** A start expected to refuse: returns its terminal code and exit. */
async function refused(args: string[] = [], extra: Record<string, string | undefined> = {}) {
  const outcome = await finite(["start", "--artifact", artifact, "--timeout", "120", ...args], extra);
  const terminal = outcome.lines.at(-1) as { data?: { result?: { error?: { code: string } } } };
  const output = outcome.stdout + outcome.stderr;
  for (const secret of [canary, database.url, "nothing@"]) expect(output.includes(secret), `refusal printed ${secret}`).toBe(false);
  return { exit: outcome.exit, code: terminal.data?.result?.error?.code, output };
}
const logged = async () => (await readFile(commands, "utf8").catch(() => "")).split("\n").filter(Boolean);
/** A Docker subcommand that fetches or creates images; image tags also contain the word "build". */
const acquisition = (line: string) => /^(--host \S+ )?(pull|build|buildx|push|image pull|image build|compose (?!version\b))/.test(line);
/** Containers of exactly this artifact's images, so another project on the machine cannot affect a result. */
async function artifactContainers(directory: string): Promise<string[]> {
  const { images } = JSON.parse(await readFile(join(directory, "fleur-artifact.json"), "utf8")) as { images: { worker: { tag: string }; controller: { tag: string } } };
  const found: string[] = [];
  for (const role of [images.worker.tag, images.controller.tag]) {
    const list = Bun.spawn(["docker", "ps", "--all", "--filter", `ancestor=${role}`, "--format", "{{.ID}}"], { stdout: "pipe" });
    found.push(...(await new Response(list.stdout).text()).trim().split("\n").filter(Boolean));
  }
  return found;
}
async function clearLog() { await writeFile(commands, ""); }

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "fleur-production-")));
  shim = join(root, "shim"); commands = join(root, "docker-commands.log");
  await mkdir(shim);
  // Records every Docker client invocation, so "no pull or build" is observed rather than assumed.
  const real = Bun.which("docker");
  await writeFile(join(shim, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FLEUR_DOCKER_LOG"\nexec ${JSON.stringify(real)} "$@"\n`);
  await chmod(join(shim, "docker"), 0o755);
  database = await ownedPostgres();
  project = join(root, "app");
  const created = await finite(["new", project, "--no-git"]);
  expect(created.exit, created.stdout).toBe(0);
  for (const directory of ["client", "server", "shared"]) await cp(join(import.meta.dir, "fixtures/reactive", directory), join(project, directory), { recursive: true });
  // A declared credential makes the broker secret a startup requirement. Only the broker receives it.
  await writeFile(join(project, "shared/isolation.ts"), `
import { definePage } from "fleur/routing";
import { defineQuery, schema } from "fleur/schema";
const probe = schema.enum(["none", "network", "file", "spawn", "environment"]);
export const reach = defineQuery({ name: "isolation.reach", input: schema.object({ probe }), output: schema.string() });
export const isolationPage = definePage({ path: "/isolation/:probe", params: schema.object({ probe }) });
`);
  await writeFile(join(project, "server/isolation.tsx"), `
import { defineDestination, handleQuery, readQuery, registerPage } from "fleur/server";
import { schema } from "fleur/schema";
import { isolationPage, reach } from "../shared/isolation";
export const probeApi = defineDestination({ name: "probe.api", origin: "http://probe.fixture.test:4173", path: "/v1", response: schema.object({ ok: schema.boolean() }), credential: "probe" });
const attempt = async (work: () => unknown) => { try { await work(); return "allowed"; } catch { return "denied"; } };
handleQuery(reach, async ({ input }) => {
  if (input.probe === "network") return attempt(() => Promise.reject(new Error("TEST_ONLY_NATIVE_NETWORK_PROBE")));
  if (input.probe === "file") return attempt(() => Promise.reject(new Error("TEST_ONLY_NATIVE_FILE_PROBE")));
  if (input.probe === "spawn") return attempt(() => Promise.reject(new Error("TEST_ONLY_NATIVE_SPAWN_PROBE")));
  if (input.probe === "environment") return ["TEST_ONLY_NATIVE_ENVIRONMENT_PROBE"].includes("") ? "allowed" : "denied";
  return "none";
});
// Readiness renders the harmless first value, so each hostile probe runs only when requested.
registerPage(isolationPage, { component: async ({ params }) => <main><p id="result">{await readQuery(reach, { probe: params.probe })}</p></main> });
`);
  const migrated = await finite(["db", "migration", "generate"], { FLEUR_PRIVATE_DATABASE_URL: undefined }, project);
  expect(migrated.exit, migrated.stdout).toBe(0);
  const built = await finite(["build", "--timeout", "240"], {}, project);
  expect(built.exit, built.stdout + built.stderr).toBe(0);
  const result = built.lines.at(-1) as { data: { artifact: string; id: string } };
  // The clean artifact is moved away from its source project, which then disappears.
  artifact = join(root, "released", "artifact");
  await mkdir(join(root, "released"));
  await rename(result.data.artifact, artifact);

  // Source admission rejects ambient network, file and environment access. Inject the
  // hostile probes only into this trusted test's compiler input, so the same native
  // boundary is exercised in a real artifact independently of the source gate.
  listener = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch(request) { if (new URL(request.url).pathname === "/direct") directHits++; return new Response("reached"); } });
  const admitted = await admitProject(project);
  const sources = new Map(admitted.sources), probe = join(admitted.root, "server/isolation.tsx");
  sources.set(probe, sources.get(probe)!
    .replace('Promise.reject(new Error("TEST_ONLY_NATIVE_NETWORK_PROBE"))', `(async () => { for (const host of ["172.17.0.1", "127.0.0.1", "host.docker.internal"]) { try { await globalThis.fetch("http://" + host + ":${listener.port}/direct"); return; } catch { /* The next route may be open. */ } } throw new Error("unreachable"); })()`)
    .replace('Promise.reject(new Error("TEST_ONLY_NATIVE_FILE_PROBE"))', 'globalThis.Bun.file("/etc/passwd").text()')
    .replace('Promise.reject(new Error("TEST_ONLY_NATIVE_SPAWN_PROBE"))', 'globalThis.Bun.spawn(["/bin/true"]).exited')
    .replace('["TEST_ONLY_NATIVE_ENVIRONMENT_PROBE"].includes("")', `typeof process !== "undefined" && JSON.stringify(process.env).includes("${canary}")`));
  hostile = (await writeArtifact({ ...admitted, sources }, admitted.root, join(root, "hostile"))).directory;
}, 900_000);
afterAll(async () => {
  // Every step runs: one failed assertion must not orphan a start or its database.
  for (const child of launchers) child.kill("SIGTERM");
  await Promise.allSettled([...launchers].map(child => child.exited));
  await listener?.stop(true);
  // Start retains imported images for its next run. These belong only to this test.
  for (const directory of [artifact, hostile].filter(Boolean)) {
    const { images } = JSON.parse(await readFile(join(directory, "fleur-artifact.json"), "utf8")) as { images: { worker: { tag: string }; controller: { tag: string } } };
    await Bun.spawn(["docker", "image", "rm", "--force", images.worker.tag, images.controller.tag], { stdout: "ignore", stderr: "ignore" }).exited;
  }
  await database?.cleanup();
  await Bun.spawn(["chmod", "-R", "u+w", root]).exited;
  await rm(root, { recursive: true, force: true });
}, 180_000);

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path)); else found.push(path);
  }
  return found;
}
test("build emits the published layout with no secret, machine path or external cache", async () => {
  const manifest = JSON.parse(await readFile(join(artifact, "fleur-artifact.json"), "utf8"));
  expect(manifest).toMatchObject({ formatVersion: 1, compiler: "microsoft", platform: { os: "linux" } });
  // Both records name the Bun that produced the artifact, never the release's Bun floor.
  expect(manifest.bun).toBe(Bun.version);
  expect(JSON.parse(await readFile(join(artifact, "manifest/dependencies.json"), "utf8"))).toMatchObject({ fleur: manifest.fleurVersion, bun: Bun.version });
  const files = (await walk(artifact)).map(path => path.slice(artifact.length + 1)).sort();
  expect(files).toContain("supervisor/entry.js");
  expect(files).toContain("manifest/registry.json");
  expect(files).toContain("manifest/dependencies.json");
  expect(files).toContain("schema/migrations/0001.json");
  expect(files).toContain("docs/production.md");
  expect(files.some(file => file.startsWith("client/files/"))).toBe(true);
  expect(files).toContain(manifest.images.archive);
  expect(files.filter(file => /(^|\/)(\.env|node_modules|\.fleur|fleur\.json)(\/|$)/.test(file))).toEqual([]);
  // Bundlers name modules relative to the working directory, so match paths without their leading slash.
  const forbidden = [canary, database.url, repository.slice(1), root.slice(1), homedir().slice(1)];
  for (const file of files.filter(name => name !== manifest.images.archive)) {
    const text = await readFile(join(artifact, file), "utf8");
    for (const value of forbidden) expect(text.includes(value), `${file} contains ${value}`).toBe(false);
  }
  // Archive layers are compressed, so read the code the worker image actually carries.
  const load = Bun.spawn(["docker", "load", "--quiet", "--input", join(artifact, manifest.images.archive)], { stdout: "ignore", stderr: "ignore" });
  expect(await load.exited).toBe(0);
  const carried = Bun.spawn(["docker", "run", "--rm", "--network=none", "--entrypoint", "cat", manifest.images.worker.tag, "/probe/application.js", "/probe/bootstrap.js"], { stdout: "pipe", stderr: "ignore" });
  const code = await new Response(carried.stdout).text();
  expect(await carried.exited).toBe(0);
  expect(code.length).toBeGreaterThan(1000);
  for (const value of forbidden) expect(code.includes(value), `worker image contains ${value}`).toBe(false);
  await Bun.spawn(["docker", "image", "rm", manifest.images.worker.tag, manifest.images.controller.tag], { stdout: "ignore", stderr: "ignore" }).exited;
  // The supervisor is self-contained: nothing outside Bun itself and the artifact resolves.
  for (const name of ["entry.js", "control-worker.js"]) {
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(await readFile(join(artifact, "supervisor", name), "utf8")).map(item => item.path);
    expect(imports.filter(path => !/^(node:|bun:|bun$)/.test(path) && !builtinModules.includes(path)), name).toEqual([]);
  }
}, 120_000);
test("pending migrations, drift, maintenance and missing configuration block readiness with stable codes", async () => {
  expect(await refused()).toMatchObject({ code: "MIGRATIONS_PENDING", exit: 5 });
  expect(await refused([], { FLEUR_PRIVATE_DATABASE_URL: undefined })).toMatchObject({ code: "CONFIGURATION_MISSING", exit: 4 });
  // The operator applies reviewed migrations from the source project explicitly; start never does.
  await applyMigrations(database.url, project, { stateRoot: stateRoot(), toolDirectory: await database.pgTools(join(root, "tools")), confirm: async () => true });
  await database.sql.unsafe(`INSERT INTO public.reactive_items (id, name, version) VALUES (1, 'Alpha', 1)`);
  // Source dependencies and the project are unavailable to every start from here on.
  await rename(project, `${project}-away`);
  expect(await refused([], { FLEUR_RETRIEVAL_CREDENTIALS: undefined })).toMatchObject({ code: "CONFIGURATION_MISSING", exit: 4 });
  await database.sql.unsafe("CREATE TABLE public.unrecorded (id integer)");
  expect(await refused()).toMatchObject({ code: "SCHEMA_DRIFT", exit: 5 });
  await database.sql.unsafe("DROP TABLE public.unrecorded");
  const lease = await MaintenanceLease.acquire(database.url, true, { stateRoot: stateRoot() });
  try { expect(await refused()).toMatchObject({ code: "MAINTENANCE_BUSY", exit: 5 }); }
  finally { await lease.close(); }
  const closed = await refused([], { FLEUR_PRIVATE_DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:9/absent" });
  expect(closed).toMatchObject({ code: "DATABASE_UNAVAILABLE", exit: 4 });
  // Docker unavailable: a complete artifact and reachable database still refuse, naming the prerequisite.
  expect(await refused([], { DOCKER_HOST: "unix:///nonexistent/fleur-docker.sock" })).toMatchObject({ code: "PREREQUISITE_UNAVAILABLE", exit: 4 });
}, 600_000);
test("clean start imports only the exact image, serves the browser save/read flow and persists across restart", async () => {
  // Earlier refusals may have imported the images; this start must do so itself.
  const { images } = JSON.parse(await readFile(join(artifact, "fleur-artifact.json"), "utf8")) as { images: { worker: { tag: string }; controller: { tag: string } } };
  await Bun.spawn(["docker", "image", "rm", images.worker.tag, images.controller.tag], { stdout: "ignore", stderr: "ignore" }).exited;
  await clearLog();
  const first = await start(["--port", "31311"]);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, stopped: Awaited<ReturnType<Started["stop"]>> | undefined;
  try {
    expect(first.url).toBe("http://127.0.0.1:31311/");
    const issued = await logged();
    expect(issued.filter(line => /\bload\b/.test(line)).length).toBe(1);
    expect(issued.filter(acquisition)).toEqual([]);
    expect(issued.every(line => !line.includes(database.url))).toBe(true);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(new URL("/reactive", first.url).href);
    await page.getByRole("textbox", { name: "Draft 1", exact: true }).fill("Retained edit");
    await page.getByRole("button", { name: "Save 1", exact: true }).click();
    await browserExpect(page.getByLabel("Save status 1", { exact: true })).toHaveText("success");
    await browserExpect(page.getByLabel("Live names", { exact: true })).toHaveText("Retained edit", { timeout: 10000 });
    // Development-only document metadata never reaches production.
    expect(await page.content()).not.toContain("fleur-development");

    // Health exposes availability only, and no dev inspection endpoint exists.
    const health = await fetch(new URL("/__fleur/health", first.url));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "available" });
    expect((await fetch(new URL(`/__fleur/health/${"a".repeat(64)}`, first.url))).status).toBe(404);
    expect((await fetch(first.url, { headers: { host: "attacker.example:31311" } })).status).toBe(403);

    // Registration is visible to read-only status for this project only while it runs.
    await rename(`${project}-away`, project);
    try {
      const status = await finite(["status", "--production", "--project", project]);
      expect(status.exit, status.stdout).toBe(0);
      expect((status.lines[0] as { data: unknown }).data).toMatchObject({ state: "ready", ready: true, url: first.url, database: { connectivity: "connected", target: { kind: "production" } } });
      for (const secret of [canary, database.url]) expect(status.stdout.includes(secret)).toBe(false);
      // A start on this database says nothing about another target in the caller's environment.
      await database.sql.unsafe("CREATE DATABASE other_target");
      const other = await finite(["status", "--production", "--project", project], { FLEUR_PRIVATE_DATABASE_URL: database.url.replace(/\/[^/]+$/, "/other_target") });
      expect((other.lines[0] as { data: unknown }).data).toMatchObject({ state: null, ready: false });
      await database.sql.unsafe("DROP DATABASE other_target");
    } finally { await rename(project, `${project}-away`); }
    const body = await (await fetch(new URL("/reactive", first.url))).text();
    expect(body.includes(canary)).toBe(false);
    expect(body.includes(database.url)).toBe(false);
  } finally { await browser?.close(); stopped = await first.stop(); }
  expect(stopped.exit, stopped.output).toBe(0);
  await rename(`${project}-away`, project);
  try { expect(((await finite(["status", "--production", "--project", project])).lines[0] as { data: { state: unknown } }).data.state).toBeNull(); }
  finally { await rename(project, `${project}-away`); }
  const rows = await database.sql.unsafe("SELECT name FROM public.reactive_items WHERE id=1");
  expect(rows[0].name).toBe("Retained edit");
  for (const secret of [canary, database.url]) expect(stopped.output.includes(secret)).toBe(false);

  // A second start reuses the exact owned image with no import and keeps data.
  await clearLog();
  const second = await start(["--port", "31311"]);
  try {
    expect((await logged()).filter(line => /\bload\b/.test(line) || acquisition(line))).toEqual([]);
    const html = await (await fetch(new URL("/reactive", second.url))).text();
    expect(html).toContain("Retained edit");
  } finally { expect((await second.stop("SIGINT")).exit).toBe(0); }
}, 480_000);
test("the same runtime isolation holds: no ambient network, no secrets, restricted containers", async () => {
  const running = await start(["--port", "31312"], {}, hostile);
  try {
    // Positive control: with ordinary networking this same image does reach the listener,
    // so zero hits below are evidence rather than an unreachable target.
    const { images } = JSON.parse(await readFile(join(hostile, "fleur-artifact.json"), "utf8")) as { images: { worker: { tag: string } } };
    const control = Bun.spawn(["docker", "run", "--rm", "--add-host", "host.docker.internal:host-gateway", "--entrypoint", "bun", images.worker.tag, "-e", `await fetch("http://host.docker.internal:${listener!.port}/direct")`], { stdout: "ignore", stderr: "pipe" });
    expect(await control.exited, await new Response(control.stderr).text()).toBe(0);
    expect(directHits).toBe(1);
    directHits = 0;
    const outcomes: Record<string, string> = {};
    for (const probe of ["network", "file", "spawn", "environment"]) {
      const response = await fetch(new URL(`/isolation/${probe}`, running.url));
      const html = await response.text();
      outcomes[probe] = `${response.status} ${/id="result">([^<]*)</.exec(html)?.[1] ?? html.slice(0, 200)}`;
    }
    // An attempted connection may also retire its worker, or stall until the query deadline while
    // resolving the last, named route. Both fail closed: the exact code, and zero listener hits
    // against the positive control above, are the evidence. Nothing else passes.
    expect(['200 denied', '500 {"error":{"code":"INTERNAL_FAILURE"}}', '500 {"error":{"code":"QUERY_TIMEOUT"}}']).toContain(outcomes.network!);
    for (const probe of ["file", "spawn", "environment"]) expect(outcomes[probe], probe).toBe("200 denied");
    expect(directHits).toBe(0);
    // One hostile operation leaves the application serving healthy work.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const healthy = await fetch(new URL("/isolation/none", running.url));
      if (healthy.ok) { expect(await healthy.text()).toContain(">none<"); break; }
      if (Date.now() > deadline) throw new Error(`Healthy work did not recover: ${healthy.status}`);
      await Bun.sleep(500);
    }
    const containers = await artifactContainers(hostile);
    expect(containers.length).toBeGreaterThan(0);
    let workers = 0;
    for (const id of containers) {
      const inspected = JSON.parse(await new Response(Bun.spawn(["docker", "inspect", id], { stdout: "pipe" }).stdout).text())[0];
      expect(inspected.HostConfig.NetworkMode).toBe("none");
      expect(inspected.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspected.HostConfig.CapDrop).toContain("ALL");
      expect(inspected.HostConfig.SecurityOpt).toContain("no-new-privileges");
      expect(JSON.stringify(inspected.Config.Env)).not.toContain(canary);
      expect(JSON.stringify(inspected.Config.Env)).not.toContain(database.url);
      // Only the trusted controller holds the Docker socket; the application worker has no mount at all.
      if (inspected.Name.endsWith("-worker")) {
        workers++;
        expect(inspected.Mounts).toEqual([]);
        expect(inspected.Config.User).toBe("65534:65534");
        expect(inspected.HostConfig.PidsLimit).toBe(64);
        expect(inspected.HostConfig.Memory).toBe(536870912);
      }
      else if (inspected.Name.startsWith("/fleur-exec-controller-")) expect(inspected.Mounts.map((mount: { Destination: string }) => mount.Destination)).toEqual(["/var/run/docker.sock"]);
    }
    expect(workers).toBeGreaterThan(0);
  } finally { expect((await running.stop()).exit).toBe(0); }
  expect(await artifactContainers(hostile)).toEqual([]);
}, 240_000);
test("production binds its default loopback port and never silently changes an occupied port", async () => {
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 31313, fetch: () => new Response("taken") });
  try { expect(await refused(["--port", "31313"])).toMatchObject({ code: "PORT_OCCUPIED", exit: 4 }); }
  finally { await blocker.stop(true); }
  let free = true;
  try { const probe = Bun.serve({ hostname: "127.0.0.1", port: 3000, fetch: () => new Response() }); await probe.stop(true); } catch { free = false; }
  if (!free) { expect(await refused()).toMatchObject({ code: "PORT_OCCUPIED", exit: 4 }); return; }
  const running = await start();
  try { expect(running.url).toBe("http://127.0.0.1:3000/"); }
  finally { await running.stop(); }
}, 240_000);
test("a second start of the same application is refused while the first owns its state", async () => {
  const running = await start(["--port", "31314"]);
  try { expect(await refused(["--port", "31315"])).toMatchObject({ code: "ALREADY_RUNNING", exit: 4 }); }
  finally { expect((await running.stop()).exit).toBe(0); }
}, 240_000);
test("an abruptly killed launcher stops its supervisor and owned containers", async () => {
  const child = Bun.spawn([process.execPath, executable, "start", "--artifact", artifact, "--port", "31316", "--timeout", "240", "--json"], { cwd: root, env: environment(), stdout: "pipe", stderr: "ignore" });
  launchers.add(child);
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes('"event":"ready"')) {
    const next = await reader.read();
    if (next.done) throw new Error(text);
    text += new TextDecoder().decode(next.value);
  }
  child.kill("SIGKILL");
  await child.exited;
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (!(await artifactContainers(artifact)).length) break;
    if (Date.now() > deadline) throw new Error("Owned containers outlived their launcher");
    await Bun.sleep(250);
  }
  const next = await start(["--port", "31316"]);
  expect((await next.stop()).exit).toBe(0);
}, 300_000);

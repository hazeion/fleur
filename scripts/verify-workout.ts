// #38 public-package acceptance. The workout source stays in its own repository.
// Observable boundaries: produced CLI JSON/exits, HTTP mutations and two independent
// browsers. No Fleur implementation imports, database credentials or SQL shortcuts.
import assert from "node:assert/strict";
import { proofSource } from "./proof-source";
import workoutPin from "./workout-source.json";
import { proofBrowser, usingProofContext } from "./proof-browser";
import { workoutProduction } from "./workout-production";
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";

const source = process.argv[2];
const reference = process.argv[3] === "--reference";
if (!source || (process.argv.length !== 3 && !(reference && process.argv.length === 4))) throw new Error("Usage: bun scripts/verify-workout.ts <workout-checkout> [--reference]");
const repository = resolve(import.meta.dir, "..");
const releaseSource = await proofSource(repository);
const sourceIdentity = await proofSource(resolve(source));
assert.equal(sourceIdentity.commit, workoutPin.commit, "The workout checkout differs from its reviewed immutable source pin");
assert.equal(sourceIdentity.dirty, false, "Qualification requires the committed workout source");
const root = await realpath(await mkdtemp(join(tmpdir(), "fleur-workout-proof-")));
const app = join(root, "app"), archive = join(root, "fleur.tgz");
const environment: Record<string, string | undefined> = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright"), XDG_STATE_HOME: undefined, XDG_CONFIG_HOME: undefined, XDG_CACHE_HOME: join(root, "cache"), FLEUR_RETRIEVAL_CREDENTIALS: undefined, FLEUR_RETRIEVAL_POLICY: undefined, FLEUR_PRIVATE_PG_TOOLS: undefined, HOME: root, DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"), BUN_INSTALL_CACHE_DIR: join(root, "cache"), FLEUR_PRIVATE_DATABASE_URL: undefined, FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL: undefined, FLEUR_PRIVATE_CONTROL_DATABASE_URL: undefined, FLEUR_PRIVATE_STATE_ROOT: undefined };
const checks: string[] = [];
const children = new Set<ReturnType<typeof Bun.spawn>>();
const cancellation = new AbortController();
let interruptionGrace: ReturnType<typeof setTimeout> | undefined;
let interrupted: "SIGINT" | "SIGTERM" | undefined;
let cleaning = false;
const interrupt = (signal: "SIGINT" | "SIGTERM") => {
  interrupted ??= signal;
  if (!cleaning) {
    cancellation.abort();
    for (const child of children) child.kill(signal);
    interruptionGrace ??= setTimeout(() => { for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already retired. */ } } }, 30000);

  }
};
const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
let primaryError: unknown, cleanupError: unknown;
let archiveSha256: string | undefined;
let developmentColdStartMilliseconds: number | undefined;
let productionEvidence: Awaited<ReturnType<typeof workoutProduction>> | undefined;
let executable = "", browser: Browser | undefined;
let browserOwner: Awaited<ReturnType<typeof proofBrowser>> | undefined;
const generations = new Map<string, string | undefined>();
async function run(args: string[], cwd = app, expectedExit = 0) {
  if (interrupted && !cleaning) throw new Error("Workout proof interrupted");
  const child = Bun.spawn(args, { detached: true, cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 300_000, killSignal: "SIGKILL" });
  children.add(child);
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  children.delete(child);
  assert.equal(exit, expectedExit, `${args.slice(1).join(" ")} failed: ${stdout}\n${stderr}`);
  return stdout;
}
async function outcome(args: string[], expectedExit = 0) {
  const timeout = args[0] === "db" && args[1] === "query" ? "5" : "240";
  const stdout = await run([process.execPath, executable, ...args, "--project", app, "--timeout", timeout, "--json"], app, expectedExit);
  const result = JSON.parse(stdout);
  assert.deepEqual(Object.keys(result).sort(), ["command", "data", "error", "formatVersion", "ok", "truncated"].sort());
  assert.equal(result.formatVersion, 1); assert.equal(result.ok, expectedExit === 0);
  if (expectedExit === 0) assert.equal(result.error, null); else assert.equal(typeof result.error.code, "string");
  return result;
}
async function cli(...args: string[]) { return (await outcome(args)).data; }
async function mutate(url: string, name: string, input: unknown) {
  // Trusted driver, not application code. Like a browser, bind each request to its origin/generation.
  if (!generations.has(url)) {
    const document = await fetch(url, { method: "HEAD", signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(15000)]) });
    assert.equal(document.status, 200, "The application document is unavailable");
    generations.set(url, document.headers.get("X-Fleur-Development") ?? undefined);
  }
  const marker = generations.get(url);
  const headers: Record<string, string> = { origin: new URL(url).origin, "content-type": "application/json", "x-fleur-request": "mutation" };
  if (marker) headers["x-fleur-development"] = marker;
  const response = await fetch(new URL("/__fleur/mutation", url), { method: "POST", headers, body: JSON.stringify({ name, input }), signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(15000)]) });
  return response.json();
}
async function exercise(page: Page, name: string) {
  const form = page.getByRole("form", { name: "New exercise" });
  await form.getByLabel("Exercise name").fill(name);
  await form.getByRole("button", { name: "Create exercise" }).click();
  await expect(form.getByRole("status")).toHaveText("Saved");
}
try {
  const bin = join(root, "no-node"); await mkdir(bin);
  await writeFile(join(bin, "node"), "#!/bin/sh\necho unexpected-node >&2\nexit 99\n", { mode: 0o700 });
  await symlink(process.execPath, join(bin, "bun"));
  environment.PATH = `${bin}:${process.env.PATH ?? ""}`;
  await run([process.execPath, "pm", "pack", "--filename", archive], repository);
  const archived = await readFile(archive);
  archiveSha256 = Bun.CryptoHasher.hash("sha256", archived, "hex");
  await writeFile(join(root, "release.tar"), Bun.gunzipSync(archived));
  await run(["/usr/bin/tar", "-xf", join(root, "release.tar"), "-C", root], root);
  executable = join(root, "package/bin/fleur.ts");
  await mkdir(app);
  await cli("init", "--no-git");
  for (const directory of ["client", "server", "shared", "migrations", "tests"]) await cp(join(resolve(source), directory), join(app, directory), { recursive: true });
  if (reference) {
    for (const [from, to] of [["contracts.ts", "shared/reference.ts"], ["View.tsx", "client/ReferenceView.tsx"], ["server.tsx", "server/reference.tsx"]]) await cp(join(resolve(source), "benchmarks", from!), join(app, to!));
  }
  for (const args of [["install", "--frozen-lockfile", "--ignore-scripts"], ["install", "--cwd", "lint", "--frozen-lockfile", "--ignore-scripts"], ["add", "--ignore-scripts", "--no-save", archive]]) await run([process.execPath, ...args]);
  const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  manifest.devDependencies.fleur = JSON.parse(await readFile(join(root, "package/package.json"), "utf8")).version;
  await writeFile(join(app, "package.json"), JSON.stringify(manifest));
  executable = join(app, "node_modules/fleur/bin/fleur.ts");
  for (const command of ["explain", "test", "types", "lint"]) await cli(command);
  await cli("docs", "core"); await cli("docs", "catalog"); await cli("docs", "upgrades");
  const instructions = join(app, "AGENTS.md"), userNote = "\nKeep this user-authored proof note.\n";
  await writeFile(instructions, (await readFile(instructions, "utf8")) + userNote);
  await cli("docs", "refresh", "--preview"); await cli("docs", "refresh");
  assert.ok((await readFile(instructions, "utf8")).endsWith(userNote));
  await writeFile(instructions, (await readFile(instructions, "utf8")).replace("# Fleur", "# Edited Fleur"));
  const preview = await cli("docs", "refresh", "--preview");
  await outcome(["docs", "refresh"], 3); await cli("docs", "refresh", "--replace", preview.token); await cli("docs", "refresh", "--recover");
  assert.ok((await readFile(instructions, "utf8")).endsWith(userNote));
  assert.equal((await outcome(["upgrade", "--to", "0.2.0", "--preview"], 4)).error.code, "UPGRADE_PATH_UNSUPPORTED");
  await outcome(["new", app, "--no-git"], 5);
  await outcome(["test", "--suite", "not-a-suite"], 2);
  checks.push("produced archive, isolated cache, generated project and real tests/compiler/full lint");
  const developmentStarted = performance.now();
  let started = await cli("dev", "--background");
  developmentColdStartMilliseconds = performance.now() - developmentStarted;
  assert.equal(started.ready, true);
  console.error("Packed tools and development readiness passed");
  browserOwner = await proofBrowser(cancellation.signal); browser = browserOwner.browser;
  const activeBrowser = browser;
  for (let repeat = 1; repeat <= 2; repeat++) {
    await usingProofContext(activeBrowser, async firstContext => usingProofContext(activeBrowser, async secondContext => {
      const first = await firstContext.newPage(), second = await secondContext.newPage();
      await Promise.all([first.goto(started.url), second.goto(started.url)]);
      const exerciseForm = first.getByRole("form", { name: "New exercise" });
      await exerciseForm.getByLabel("Exercise name").fill("   ");
      await exerciseForm.getByRole("button", { name: "Create exercise" }).click();
      await expect(exerciseForm.getByRole("status")).toHaveText("INPUT_INVALID");
      await exercise(first, `Squat ${repeat}`);
      await exerciseForm.getByLabel("Exercise name").fill(`sQuAt ${repeat}`);
      await exerciseForm.getByRole("button", { name: "Create exercise" }).click();
      await expect(exerciseForm.getByRole("status")).toHaveText("CONSTRAINT_CONFLICT");
      await expect(second.getByRole("heading", { name: `Squat ${repeat}`, exact: true })).toBeVisible({ timeout: 15_000 });
      const rows = await cli("db", "inspect", "--table", "exercises");
      const row = rows.rows.find((value: { name: string }) => value.name === `Squat ${repeat}`);
      assert.ok(row);
      const entry = { exerciseId: row.id, targetSets: 1, targetRepetitions: 5 };
      const created = await mutate(started.url, "template.create", { name: `Strength ${repeat}`, entries: [entry] });
      assert.equal(created.status, "success", JSON.stringify(created));
      const savedTemplate = created.data;
      if (reference) {
        const rejected = await mutate(started.url, "reference.rejectTemplateOutput", { id: savedTemplate.id, expectedVersion: savedTemplate.version, name: "Must roll back output", entries: [{ ...entry, targetSets: 9 }] });
        assert.equal(rejected.error.code, "INTERNAL_FAILURE");
        const templates = await cli("db", "inspect", "--table", "workout_templates");
        const stored = templates.rows.find((value: { id: string }) => value.id === savedTemplate.id);
        assert.equal(stored.name, savedTemplate.name); assert.equal(Number(stored.version), savedTemplate.version);
        const children = await cli("db", "inspect", "--table", "workout_template_entries");
        assert.equal(children.rows.find((value: { templateId: string }) => value.templateId === savedTemplate.id).targetSets, "1");
      }
      const snapshot = { date: "2026-11-01", templateName: savedTemplate.name, exercises: [{ name: row.name, sets: [{ repetitions: 5, weight: { value: "000.00", unit: "lb" } }] }] };
      const session = await mutate(started.url, "session.create", snapshot);
      assert.equal(session.status, "success", JSON.stringify(session));
      assert.deepEqual(session.data.exercises[0].sets[0].weight, { value: "0", unit: "lb" });
      const large = await mutate(started.url, "session.create", { date: "2026-11-01", exercises: [{ name: row.name, sets: Array.from({ length: 51 }, () => ({ repetitions: 1, weight: { value: "10000000000000000000000.01", unit: "kg" } })) }] });
      assert.equal(large.status, "success", JSON.stringify(large));
      assert.equal(large.data.exercises[0].sets.length, 51); assert.equal(large.data.exercises[0].sets[50].weight.value, "10000000000000000000000.01");
      assert.equal((await mutate(started.url, "session.delete", { id: large.data.id, expectedVersion: large.data.version })).status, "success");
      if (reference) for (const operation of ["reference.rejectSessionOutput", "reference.rejectSessionChild"]) {
        const rejected = await mutate(started.url, operation, { ...snapshot, id: session.data.id, expectedVersion: session.data.version, templateName: "Must roll back" });
        assert.equal(rejected.error.code, operation.endsWith("Output") ? "INTERNAL_FAILURE" : "CONSTRAINT_CONFLICT");
        const rows = await cli("db", "inspect", "--table", "workout_sessions");
        const stored = rows.rows.find((value: { id: string }) => value.id === session.data.id);
        assert.equal(stored.templateName, savedTemplate.name); assert.equal(Number(stored.version), session.data.version);
      }
      for (const input of [{ ...snapshot, extra: true }, { ...snapshot, date: "2026-02-30" }, { ...snapshot, exercises: [{ name: "Squat", sets: [{ repetitions: 5, weight: { value: "1.234", unit: "kg" } }] }] }]) {
        const rejected = await mutate(started.url, "session.create", input);
        assert.equal(rejected.status, "failure"); assert.equal(rejected.error.code, "INPUT_INVALID");
      }
      // Foreign-key failure after the header write must leave no partial aggregate.
      const rejected = await mutate(started.url, "template.create", { name: "Must roll back", entries: [entry, { ...entry, exerciseId: "00000000-0000-4000-8000-000000000000" }] });
      assert.equal(rejected.status, "failure"); assert.equal(rejected.error.code, "CONSTRAINT_CONFLICT");
      assert.equal((await cli("db", "inspect", "--table", "workout_templates")).rows.some((value: { name: string }) => value.name === "Must roll back"), false);
      const conflicting = await mutate(started.url, "exercise.delete", { id: row.id, expectedVersion: Number(row.version) });
      assert.equal(conflicting.error.code, "CONSTRAINT_CONFLICT");
      const winners = await Promise.all(["A", "B"].map(name => mutate(started.url, "template.update", { id: savedTemplate.id, expectedVersion: savedTemplate.version, name: `${name} ${repeat}`, entries: [entry] })));
      assert.equal(winners.filter(value => value.status === "success").length, 1);
      assert.equal(winners.filter(value => value.error?.code === "VERSION_CONFLICT").length, 1);
      await first.goto(new URL("/templates", started.url).href); await second.goto(new URL("/templates", started.url).href);
      const winner = winners.find(value => value.status === "success").data;
      const firstEditor = first.locator(`#template-${winner.id}`).getByRole("form");
      const secondEditor = second.locator(`#template-${winner.id}`).getByRole("form");
      const draft = secondEditor.getByLabel("Template name");
      await draft.fill("Unsaved draft"); await draft.focus();
      await firstEditor.getByLabel("Template name").fill(`Renamed ${repeat}`);
      await firstEditor.getByRole("button", { name: "Save template", exact: true }).click();
      await expect(second.getByRole("heading", { name: `Renamed ${repeat}`, exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(draft).toHaveValue("Unsaved draft"); await expect(draft).toBeFocused();
      assert.equal((await mutate(started.url, "exercise.update", { id: row.id, expectedVersion: Number(row.version), name: `Catalog renamed ${repeat}` })).status, "success");
      assert.equal((await mutate(started.url, "template.delete", { id: savedTemplate.id, expectedVersion: winner.version + 1 })).status, "success");
      assert.equal((await mutate(started.url, "exercise.delete", { id: row.id, expectedVersion: Number(row.version) + 1 })).status, "success");
      await first.goto(new URL("/sessions", started.url).href);
      await expect(first.getByRole("article").getByText(`From template Strength ${repeat}`, { exact: true })).toBeVisible();
      await expect(first.getByRole("article").getByRole("listitem")).toContainText([`Squat ${repeat}: 5 reps @ 0 lb`]);
      // A committed mutation whose acknowledgement is lost is sent exactly once.
      await first.goto(started.url);
      let submitted = 0;
      await first.route("**/__fleur/mutation", async route => { submitted++; const response = await route.fetch(); assert.equal(response.status(), 200); await response.dispose(); await route.abort("failed"); });
      const creator = first.getByRole("form", { name: "New exercise" });
      await creator.getByLabel("Exercise name").fill(`Unknown ${repeat}`);
      await creator.getByRole("button", { name: "Create exercise" }).click();
      await expect(creator.getByRole("status")).toContainText("Outcome unknown");
      await expect(first.getByRole("heading", { name: `Unknown ${repeat}`, exact: true })).toBeVisible({ timeout: 15_000 });
      assert.equal(submitted, 1);
      await expect(creator.getByRole("button", { name: "Create exercise" })).toBeDisabled();
      checks.push(`workout validation, atomic children, concurrency, reference conflict, snapshot, two-view draft/focus and no replay, repeat ${repeat}`);
    }));
    console.error(`Workout functional repeat ${repeat}/2 passed`);
  }
  await cli("doctor"); await cli("status");
  await cli("db", "migration", "generate"); await cli("db", "migration", "plan"); await cli("db", "migration", "status"); await cli("db", "migration", "apply");
  await cli("db", "seed"); await cli("db", "recover", "--inspect"); await cli("db", "inspect");
  const exportFile = join(root, "export.json");
  await cli("db", "inspect", "--table", "exercises", "--limit", "1", "--export", exportFile);
  assert.ok((await readFile(exportFile)).length > 0);
  const sqlFile = join(root, "query.sql"); await writeFile(sqlFile, "SELECT name FROM exercises WHERE name = $1");
  const queried = await cli("db", "query", "--sql-file", sqlFile, "--param", "Unknown 1", "--limit", "1");
  assert.ok(JSON.stringify(queried.rows).includes("Unknown 1"));
  await cli("db", "query", "--sql", "SELECT name FROM exercises ORDER BY name", "--limit", "1");
  const logs = await cli("logs", "--limit", "1"); if (logs.cursor) await cli("logs", "--limit", "1", "--cursor", logs.cursor);
  console.error("Packed maintenance checks reached backup verification");
  const backup = join(root, "retained.dump"); await cli("db", "backup", "--out", backup); const backupBytes = await readFile(backup); assert.ok(backupBytes.length > 0);
  await outcome(["db", "restore", "--from", backup], 3); await outcome(["db", "reset", "--seed"], 3);
  assert.equal((await cli("db", "inspect", "--table", "workout_sessions")).rows.length, 2);
  checks.push("packed docs/refresh/upgrades, diagnostics, inspection/export/query, seeds, reviewed migrations, verified backup and authority refusals");
  await cli("stop"); started = await cli("dev", "--background");
  assert.deepEqual(await readFile(backup), backupBytes);
  const persisted = await cli("db", "inspect", "--table", "workout_sessions");
  assert.equal(persisted.rows.length, 2);
  checks.push("two sessions persist across explicit stop and restart");
  await cli("verify");
  checks.push("packed verify includes the real production build");
  await cli("stop");
  productionEvidence = await workoutProduction({ root, app, executable, environment, children, signal: cancellation.signal, ...(reference ? { reference: { archiveSha256, releaseSource, source: resolve(source), report: join(repository, "test-results/workout-reference.json") } } : {}) });
  checks.push(...productionEvidence.checks);
} catch (error) {
  primaryError = error;
  if (executable && !interrupted) {
    try { console.error("Workout diagnostics:", JSON.stringify(await cli("logs", "--limit", "50"))); } catch { /* Keep the original failure. */ }
  }
} finally {
  cleaning = true;
  const cleanupFailures: unknown[] = [];
  try { await browserOwner?.close(); } catch (error) { cleanupFailures.push(error); }
  try {
  // Retire only the resources whose binding is recorded inside this fresh HOME.
  if (executable) {
    const stopped = await run([process.execPath, executable, "stop", "--project", app, "--json"]).then(() => true, () => false);
    assert.ok(stopped, `Workout proof cleanup failed; retained evidence at ${root}`);
    const directory = join(root, ".local/state/fleur/development");
    for (const binding of await readdir(directory).catch(() => [] as string[])) {
      const record = JSON.parse(await readFile(join(directory, binding, "postgres.json"), "utf8"));
      const metadata = JSON.parse(await run(["docker", "inspect", record.container, "--format", "{{json .}}"], root));
      assert.equal(metadata.Config.Labels["dev.fleur.development-binding"], binding);
      assert.equal(metadata.State.Running, false);
      assert.equal(metadata.Mounts[0].Name, record.volume);
      await run(["docker", "rm", record.container], root); await run(["docker", "volume", "rm", record.volume], root);
    }
  }
  } catch (error) { cleanupFailures.push(error); }
  if (!primaryError && cleanupFailures.length === 0) {
    try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
  } else console.error(`Private proof evidence retained at ${root}`);
  if (cleanupFailures.length) cleanupError = new AggregateError(cleanupFailures, "Owned proof disposal failed");
  clearTimeout(interruptionGrace);
  process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
}
if (interrupted) { if (cleanupError) console.error("Workout disposal failed", cleanupError); process.exit(interrupted === "SIGINT" ? 130 : 143); }
if (primaryError || cleanupError) throw new AggregateError([primaryError, cleanupError].filter(Boolean), "Workout acceptance or disposal failed");
process.stdout.write(JSON.stringify({ formatVersion: 1, ok: true, source: { workout: sourceIdentity, fleur: releaseSource }, archiveSha256, artifact: productionEvidence?.artifact, bun: Bun.version, host: { os: process.platform, architecture: process.arch, browser: browser?.version() }, coldStartup: { developmentMilliseconds: developmentColdStartMilliseconds, productionMilliseconds: productionEvidence?.coldStartMilliseconds, scope: "new owned application containers; dependencies installed and Docker daemon/base layers already warm" }, checks: [...checks, "owned processes, container and volume retired"] }) + "\n");

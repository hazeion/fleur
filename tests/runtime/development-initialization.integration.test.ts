import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { column, defineSeed, defineTable, type Seed, type Table } from "../../src/database";
import { ReadBroker } from "../../src/runtime/database/broker";
import { createDevelopmentDatabase, describeDevelopmentStartup, startDevelopmentDatabase, type DevelopmentDatabase } from "../../src/runtime/database/development";
import { MaintenanceLease } from "../../src/runtime/database/maintenance";
import { generateMigration } from "../../src/runtime/database/migration-plan";
import { applyMigrations, migrationStatus } from "../../src/runtime/database/migrations";
import { resetDatabase } from "../../src/runtime/database/reset";
import { ownedPostgres } from "./owned-postgres";

/**
 * Requirements: V1-SPEC "New development database initialization" and the #66 resolution. A `fleur dev` startup
 * initializes only a database Fleur created for a storage binding that has provably never been initialized: the whole
 * committed chain and the declared seeds commit in one transaction, with no backup and no approval. Every other
 * database keeps the explicit `db migration apply` and `db seed` flow.
 */
type Fixture = Awaited<ReturnType<typeof ownedPostgres>>;
async function cluster(prefix: string) {
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), `fleur-${prefix}-`));
  const project = join(root, "app"), config = { stateRoot: join(root, "state") };
  const database = (name: string, binding: string = randomUUID()): DevelopmentDatabase => {
    const url = new URL(fixture.url); url.pathname = `/${name}`;
    return { url: url.toString(), binding };
  };
  return { fixture, root, project, config, database };
}
async function withDatabase<T>(url: string, use: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(url, { max: 1, connectionTimeout: 2 });
  try { return await use(sql); } finally { await sql.close({ timeout: 0 }); }
}
/** The catalog evidence of a database that nothing has initialized: no relations, functions or types, and no Fleur metadata. */
async function untouched(url: string): Promise<boolean> {
  return withDatabase(url, async sql => (await sql.unsafe("SELECT NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','fleur_internal')) AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='fleur_internal') AS untouched"))[0].untouched === true);
}
async function files(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true }).catch(() => [] as string[])).map(String);
}
/** A two-migration chain whose second migration removes a column, so it needs approval in the explicit flow. */
async function chain(project: string, prefix: string) {
  const original = defineTable(`${prefix}_categories`, { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(40), code: column.string().nullable() } });
  const plan = await generateMigration(project, [original]);
  const categories = defineTable(`${prefix}_categories`, { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(40) } });
  const items = defineTable(`${prefix}_items`, { columns: { id: column.safeInteger().primaryKey(), category: column.safeInteger().references(categories.id, { onDelete: "cascade" }), title: column.string().max(80) }, indexes: [{ fields: ["category"] }] });
  const removal = await generateMigration(project, [categories, items]);
  const categorySeed = defineSeed({ key: "categories", table: categories, rows: [{ ownerKey: "general", values: { id: 1, name: "General" } }, { ownerKey: "archive", values: { id: 2, name: "Archive" } }] });
  const itemSeed = defineSeed({ key: "items", table: items, dependsOn: [categorySeed], rows: [{ ownerKey: "welcome", values: { id: 1, category: 1, title: "Welcome" } }] });
  return { plans: [plan.plan, removal.plan], categories, items, seeds: [categorySeed, itemSeed] as Seed[], tables: [categories, items] as Table[] };
}
async function admitted(url: string, tables: readonly Table[], config: { stateRoot: string }): Promise<boolean> {
  try { await (await MaintenanceLease.acquire(url, false, { ...config, tables, completeRegistry: true })).close(); return true; }
  catch { return false; }
}
function withoutCredentials(fixture: Fixture, value: unknown): void {
  const url = new URL(fixture.url), text = JSON.stringify(value);
  for (const secret of [url.password, url.username, url.port, url.host, fixture.url]) expect(text).not.toContain(secret);
}

test("a new development database becomes ready with the whole committed chain and declared seeds, without backup or approval", async () => {
  const { fixture, root, project, config, database } = await cluster("dev-init");
  try {
    const app = await chain(project, "first");
    expect(app.plans[1]!.removals.length).toBeGreaterThan(0);
    const target = database("fleur_dev_first");
    const report = await startDevelopmentDatabase(target, project, app.seeds, config);
    expect(report).toMatchObject({
      state: "ready", ready: true, error: null, reasons: [],
      initialization: { status: "initialized", migrationsApplied: ["0001", "0002"], seedRowsApplied: 3, migrations: { compatible: true, applied: ["0001", "0002"], pending: [], drift: false } },
    });
    // The report is the JSON `dev` emits; human output names the same three facts.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    const human = describeDevelopmentStartup(report);
    expect(human).toContain("Initialized the new development database");
    expect(human).toContain("2 migrations (0001, 0002)");
    expect(human).toContain("3 seed rows");
    expect(human).toContain("2 applied, 0 pending, no drift");
    withoutCredentials(fixture, report); withoutCredentials(fixture, human);
    // No backup and no approval grant were created; the expected catalog was recorded for drift detection.
    expect((await files(config.stateRoot)).filter(name => name.endsWith(".dump") || name.includes("grant-"))).toEqual([]);
    expect((await migrationStatus(target.url, project, config)).migrations).toMatchObject({ applied: ["0001", "0002"], pending: [], drift: false });
    expect(await admitted(target.url, app.tables, config)).toBe(true);
    const broker = new ReadBroker({ url: target.url, tables: app.tables, maintenance: config });
    try {
      expect(await broker.read(db => db.select(app.categories, { fields: ["id", "name"], orderBy: [{ field: "id", direction: "asc" }] }))).toEqual([{ id: 1, name: "General" }, { id: 2, name: "Archive" }]);
      expect(await broker.read(db => db.select(app.items, { fields: ["id", "category", "title"] }))).toEqual([{ id: 1, category: 1, title: "Welcome" }]);
    } finally { await broker.close(); }
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("an initialized database keeps its data across restart and is never initialized again", async () => {
  const { fixture, root, project, config, database } = await cluster("dev-restart");
  try {
    const app = await chain(project, "restart");
    const target = database("fleur_dev_restart");
    expect((await startDevelopmentDatabase(target, project, app.seeds, config)).initialization.status).toBe("initialized");
    const broker = new ReadBroker({ url: target.url, tables: app.tables, maintenance: config });
    try {
      await broker.mutate(db => db.updateVersioned(app.categories, { id: 1, expectedVersion: 1, set: { name: "Edited" }, returning: ["id"] }));
      await broker.mutate(db => db.deleteVersioned(app.categories, { id: 2, expectedVersion: 1 }));
    } finally { await broker.close(); }
    await fixture.restart();
    const again = await startDevelopmentDatabase(target, project, app.seeds, config);
    expect(again).toMatchObject({ state: "ready", ready: true, initialization: { status: "existing", migrationsApplied: [], seedRowsApplied: 0 } });
    expect(describeDevelopmentStartup(again)).not.toContain("Initialized");
    // The edit survives and the deleted seed row is not recreated: startup did not reseed.
    expect(await withDatabase(target.url, sql => sql.unsafe("SELECT id::int AS id, name FROM public.restart_categories ORDER BY id"))).toEqual([{ id: 1, name: "Edited" }]);
    expect(await withDatabase(target.url, sql => sql.unsafe("SELECT count(*)::int AS count FROM fleur_internal.migrations"))).toEqual([{ count: 2 }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("adopted databases and another binding's database keep the explicit flow", async () => {
  const { fixture, root, project, config, database } = await cluster("dev-adopted");
  try {
    const app = await chain(project, "adopted");
    // A database Fleur did not create for this binding, though empty, is never new.
    const adopted = database("fleur_dev_adopted");
    await fixture.sql.unsafe("CREATE DATABASE fleur_dev_adopted");
    expect(await createDevelopmentDatabase(adopted, config)).toEqual({ created: false });
    const report = await startDevelopmentDatabase(adopted, project, app.seeds, config);
    expect(report).toMatchObject({ ready: false, initialization: { status: "existing", migrationsApplied: [], seedRowsApplied: 0, migrations: { pending: ["0001", "0002"] } } });
    expect(report.reasons.map(reason => reason.code)).toEqual(["MIGRATION_PENDING"]);
    expect(await untouched(adopted.url)).toBe(true);
    // The explicit flow still applies, with its backup, and startup then neither reseeds nor reinitializes.
    await applyMigrations(adopted.url, project, { ...config, toolDirectory: await fixture.pgTools(join(root, "tools")), confirm: async () => true });
    expect(await startDevelopmentDatabase(adopted, project, app.seeds, config)).toMatchObject({ state: "ready", initialization: { status: "existing", seedRowsApplied: 0 } });
    expect(await withDatabase(adopted.url, sql => sql.unsafe("SELECT count(*)::int AS count FROM public.adopted_categories"))).toEqual([{ count: 0 }]);
    // A copied checkout's binding cannot claim the source binding's new database; the creating binding still can.
    const created = database("fleur_dev_bound", "source-binding");
    expect(await createDevelopmentDatabase(created, config)).toEqual({ created: true });
    expect(await createDevelopmentDatabase(created, config)).toEqual({ created: false });
    expect((await startDevelopmentDatabase({ ...created, binding: "copied-binding" }, project, app.seeds, config)).initialization.status).toBe("existing");
    expect(await untouched(created.url)).toBe(true);
    expect((await startDevelopmentDatabase(created, project, app.seeds, config)).initialization).toMatchObject({ status: "initialized", seedRowsApplied: 3 });
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("an emptied, explicitly migrated or reset database is not new again", async () => {
  const { fixture, root, project, config, database } = await cluster("dev-emptied");
  const empty = (url: string) => withDatabase(url, sql => sql.unsafe("DROP SCHEMA fleur_internal CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public"));
  try {
    const app = await chain(project, "emptied");
    const initialized = database("fleur_dev_emptied");
    expect((await startDevelopmentDatabase(initialized, project, app.seeds, config)).initialization.status).toBe("initialized");
    await empty(initialized.url);
    expect(await untouched(initialized.url)).toBe(true);
    const emptied = await startDevelopmentDatabase(initialized, project, app.seeds, config);
    expect(emptied).toMatchObject({ ready: false, initialization: { status: "existing", migrationsApplied: [] } });
    expect(await untouched(initialized.url)).toBe(true);
    // A new database that the explicit flow migrated first stops being new, even after it is emptied.
    const explicit = database("fleur_dev_explicit");
    expect(await createDevelopmentDatabase(explicit, config)).toEqual({ created: true });
    const tools = await fixture.pgTools(join(root, "tools"));
    await applyMigrations(explicit.url, project, { ...config, toolDirectory: tools, confirm: async () => true });
    expect((await startDevelopmentDatabase(explicit, project, app.seeds, config)).initialization.status).toBe("existing");
    await empty(explicit.url);
    expect((await startDevelopmentDatabase(explicit, project, app.seeds, config)).initialization.status).toBe("existing");
    expect(await untouched(explicit.url)).toBe(true);
    // Reset keeps its approval and --seed flow: the recreated database is not new and is not seeded by startup.
    const reset = database("fleur_dev_reset");
    expect((await startDevelopmentDatabase(reset, project, app.seeds, config)).initialization.status).toBe("initialized");
    await resetDatabase(reset.url, project, app.seeds, { ...config, toolDirectory: tools, developmentUrl: reset.url, confirm: async request => request.action === "reset" });
    expect(await startDevelopmentDatabase(reset, project, app.seeds, config)).toMatchObject({ state: "ready", initialization: { status: "existing", seedRowsApplied: 0 } });
    expect(await withDatabase(reset.url, sql => sql.unsafe("SELECT count(*)::int AS count FROM public.emptied_categories"))).toEqual([{ count: 0 }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("a failing seed or migration leaves the database new and blocked until a corrected retry succeeds", async () => {
  const { fixture, root, project, config, database } = await cluster("dev-failure");
  try {
    const app = await chain(project, "failure");
    const target = database("fleur_dev_failure");
    const blocked = async (seeds: readonly Seed[], code: string) => {
      const report = await startDevelopmentDatabase(target, project, seeds, config);
      expect(report).toMatchObject({ state: "failed", ready: false, initialization: { status: "failed", migrationsApplied: [], seedRowsApplied: 0 }, error: { code } });
      expect(report.error!.exitCode).toBeGreaterThan(0);
      expect(report.error!.action.command).toMatch(/^fleur /);
      expect(report.error!.action.description.length).toBeGreaterThan(0);
      expect(describeDevelopmentStartup(report)).toContain(code);
      withoutCredentials(fixture, report);
      expect(await untouched(target.url)).toBe(true);
      expect(await admitted(target.url, app.tables, config)).toBe(false);
      return report;
    };
    // A seed conflict fails after the migrations ran inside the transaction: their tables roll back too.
    const conflicting = defineSeed({ key: "categories", table: app.categories, rows: [{ ownerKey: "one", values: { id: 1, name: "One" } }, { ownerKey: "two", values: { id: 1, name: "Two" } }] });
    await blocked([conflicting], "SEED_CONFLICT");
    // Later startups retry while the database is still provably new.
    await blocked([conflicting], "SEED_CONFLICT");
    // Seeds for a table the committed chain does not create.
    const undeclared = defineTable("failure_undeclared", { columns: { id: column.safeInteger().primaryKey() } });
    await blocked([defineSeed({ key: "undeclared", table: undeclared, rows: [{ ownerKey: "one", values: { id: 1 } }] })], "MIGRATIONS_PENDING");
    // An edited committed migration fails plan validation before anything runs.
    const path = join(project, "migrations", "0002.json"), original = await readFile(path, "utf8");
    const edited = JSON.parse(original) as { statements: string[] };
    await writeFile(path, JSON.stringify({ ...edited, statements: [...edited.statements, "SELECT 1"] }) + "\n");
    await blocked(app.seeds, "MIGRATION_EDITED");
    await writeFile(path, original);
    const retried = await startDevelopmentDatabase(target, project, app.seeds, config);
    expect(retried).toMatchObject({ state: "ready", ready: true, error: null, initialization: { status: "initialized", migrationsApplied: ["0001", "0002"], seedRowsApplied: 3 } });
    expect(await admitted(target.url, app.tables, config)).toBe(true);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("an empty committed chain leaves the database new until a startup finds a migration", async () => {
  const { fixture, root, project, config, database } = await cluster("dev-empty-chain");
  try {
    const target = database("fleur_dev_empty_chain");
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await startDevelopmentDatabase(target, project, [], config);
      expect(report).toMatchObject({ initialization: { status: "new", migrationsApplied: [], seedRowsApplied: 0 } });
      expect(describeDevelopmentStartup(report)).toContain("no committed migrations");
      expect(await untouched(target.url)).toBe(true);
    }
    const app = await chain(project, "later");
    expect(await startDevelopmentDatabase(target, project, app.seeds, config)).toMatchObject({ state: "ready", initialization: { status: "initialized", migrationsApplied: ["0001", "0002"], seedRowsApplied: 3 } });
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("two racing startups create and initialize the database exactly once", async () => {
  const { fixture, root, project, config, database } = await cluster("dev-race");
  try {
    const app = await chain(project, "race");
    for (const name of ["fleur_dev_race_one", "fleur_dev_race_two"]) {
      const target = database(name);
      const reports = await Promise.all([startDevelopmentDatabase(target, project, app.seeds, config), startDevelopmentDatabase(target, project, app.seeds, config)]);
      expect(reports.map(report => report.initialization.status).sort()).toEqual(["existing", "initialized"]);
      expect(reports.map(report => ({ state: report.state, ready: report.ready, reasons: report.reasons.map(reason => reason.code) }))).toEqual([{ state: "ready", ready: true, reasons: [] }, { state: "ready", ready: true, reasons: [] }]);
      expect(reports.reduce((total, report) => total + report.initialization.seedRowsApplied, 0)).toBe(3);
      expect(await withDatabase(target.url, sql => sql.unsafe("SELECT (SELECT count(*)::int FROM fleur_internal.migrations) AS migrations, (SELECT count(*)::int FROM public.race_categories) AS categories, (SELECT count(*)::int FROM public.race_items) AS items"))).toEqual([{ migrations: 2, categories: 2, items: 1 }]);
    }
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

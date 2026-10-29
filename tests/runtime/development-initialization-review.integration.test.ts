import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { column, defineSeed, defineTable, type Seed } from "../../src/database";
import { ReadBroker } from "../../src/runtime/database/broker";
import { createDevelopmentDatabase, startDevelopmentDatabase, type DevelopmentDatabase } from "../../src/runtime/database/development";
import { generateMigration } from "../../src/runtime/database/migration-plan";
import { applyMigrations } from "../../src/runtime/database/migrations";
import { seedDatabase } from "../../src/runtime/database/seeds";
import { ownedPostgres } from "./owned-postgres";

// Independent reviewer tests for #71. Requirements: V1-SPEC "New development database initialization" and the #66 resolution.
async function setup(prefix: string) {
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), `fleur-review-${prefix}-`));
  const project = join(root, "app"), config = { stateRoot: join(root, "state") };
  const database = (name: string): DevelopmentDatabase => { const url = new URL(fixture.url); url.pathname = `/${name}`; return { url: url.toString(), binding: randomUUID() }; };
  return { fixture, root, project, config, database };
}
async function recordPath(stateRoot: string): Promise<string[]> {
  return (await readdir(stateRoot, { recursive: true })).map(String).filter(name => name.endsWith("development-creation.json")).map(name => join(stateRoot, name));
}

test("after initialization, explicit db seed and db migration apply keep working", async () => {
  const { fixture, root, project, config, database } = await setup("explicit");
  try {
    const categories = defineTable("review_categories", { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(40) } });
    await generateMigration(project, [categories]);
    const seed = defineSeed({ key: "categories", table: categories, rows: [{ ownerKey: "general", values: { id: 1, name: "General" } }] });
    const target = database("fleur_review_explicit");
    expect((await startDevelopmentDatabase(target, project, [seed] as Seed[], config)).initialization.status).toBe("initialized");
    // Repeating the declared seeds explicitly changes nothing.
    expect(await seedDatabase(target.url, project, [seed] as Seed[], config)).toEqual({ inserted: 0, updated: 0, skipped: [] });
    const broker = new ReadBroker({ url: target.url, tables: [categories], maintenance: config });
    try { await broker.mutate(db => db.updateVersioned(categories, { id: 1, expectedVersion: 1, set: { name: "Edited" }, returning: ["id"] })); } finally { await broker.close(); }
    expect((await seedDatabase(target.url, project, [seed] as Seed[], config)).skipped).toEqual([{ seed: "categories", ownerKey: "general", reason: "user-edited" }]);
    // A later migration uses the explicit flow.
    const extended = defineTable("review_categories", { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(40), note: column.string().nullable() } });
    await generateMigration(project, [extended]);
    expect((await applyMigrations(target.url, project, { ...config, toolDirectory: await fixture.pgTools(join(root, "tools")), confirm: async () => true })).applied).toEqual(["0002"]);
    expect(await startDevelopmentDatabase(target, project, [seed] as Seed[], config)).toMatchObject({ state: "ready", initialization: { status: "existing" } });
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("a crash after the record names an aborted initialization transaction lets the next startup initialize", async () => {
  const { fixture, root, project, config, database } = await setup("crash");
  try {
    const categories = defineTable("crash_categories", { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(40) } });
    await generateMigration(project, [categories]);
    const target = database("fleur_review_crash");
    expect(await createDevelopmentDatabase(target, config)).toEqual({ created: true });
    const [path] = await recordPath(config.stateRoot);
    const record = JSON.parse(await readFile(path!, "utf8"));
    expect(record.stage).toBe("new");
    // Simulate a crash between writing `initializing` and COMMIT: the named transaction never committed.
    const xid = await (async () => {
      const sql = new SQL(target.url, { max: 1 });
      try { await sql.unsafe("BEGIN"); const rows = await sql.unsafe("SELECT pg_current_xact_id()::text AS xid"); await sql.unsafe("ROLLBACK"); return String(rows[0].xid); }
      finally { await sql.close({ timeout: 0 }); }
    })();
    await writeFile(path!, JSON.stringify({ ...record, stage: "initializing", transaction: xid }) + "\n");
    expect(await startDevelopmentDatabase(target, project, [], config)).toMatchObject({ state: "ready", initialization: { status: "initialized", migrationsApplied: ["0001"] } });
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("a crash after an initialization committed never applies the chain twice", async () => {
  const { fixture, root, project, config, database } = await setup("committed");
  try {
    const categories = defineTable("committed_categories", { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(40) } });
    await generateMigration(project, [categories]);
    const target = database("fleur_review_committed");
    expect(await createDevelopmentDatabase(target, config)).toEqual({ created: true });
    const [path] = await recordPath(config.stateRoot);
    const record = JSON.parse(await readFile(path!, "utf8"));
    // The record names a transaction that committed; the catalog alone (empty here) must not decide newness.
    const xid = await (async () => {
      const sql = new SQL(target.url, { max: 1 });
      try { await sql.unsafe("BEGIN"); const rows = await sql.unsafe("SELECT pg_current_xact_id()::text AS xid"); await sql.unsafe("COMMIT"); return String(rows[0].xid); }
      finally { await sql.close({ timeout: 0 }); }
    })();
    await writeFile(path!, JSON.stringify({ ...record, stage: "initializing", transaction: xid }) + "\n");
    for (let attempt = 0; attempt < 2; attempt++) expect((await startDevelopmentDatabase(target, project, [], config)).initialization).toMatchObject({ status: "existing", migrationsApplied: [] });
    expect(JSON.parse(await readFile(path!, "utf8")).stage).toBe("retired");
    const tables = await (async () => { const sql = new SQL(target.url, { max: 1 }); try { return await sql.unsafe("SELECT to_regclass('public.committed_categories') IS NULL AS absent"); } finally { await sql.close({ timeout: 0 }); } })();
    expect(tables).toEqual([{ absent: true }]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("a dropped development database is recreated as new only if it was never initialized, with no dead end", async () => {
  const { fixture, root, project, config, database } = await setup("dropped");
  try {
    const target = database("fleur_review_dropped");
    // Empty chain: the database is new and never initialized; dropping it lets startup recreate it as new.
    expect((await startDevelopmentDatabase(target, project, [], config)).initialization.status).toBe("new");
    await fixture.sql.unsafe("DROP DATABASE fleur_review_dropped WITH (FORCE)");
    const categories = defineTable("dropped_categories", { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(40) } });
    await generateMigration(project, [categories]);
    const seed = defineSeed({ key: "categories", table: categories, rows: [{ ownerKey: "general", values: { id: 1, name: "General" } }] });
    expect((await startDevelopmentDatabase(target, project, [seed] as Seed[], config)).initialization).toMatchObject({ status: "initialized", seedRowsApplied: 1 });
    // Once initialized, a dropped database comes back empty and not new. Startup reports readiness from the shared
    // probe, which still holds Fleur's recorded catalog, every time; it neither reinitializes nor fails with an action
    // that cannot resolve the loss.
    await fixture.sql.unsafe("DROP DATABASE fleur_review_dropped WITH (FORCE)");
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await startDevelopmentDatabase(target, project, [seed] as Seed[], config);
      expect(report).toMatchObject({ error: null, state: "failed", ready: false, initialization: { status: "existing", migrationsApplied: [], seedRowsApplied: 0 } });
      expect(report.reasons.map(reason => reason.code)).toEqual(["MIGRATION_PENDING", "SCHEMA_DRIFT"]);
      const sql = new SQL(target.url, { max: 1 });
      try { expect(await sql.unsafe("SELECT to_regclass('public.dropped_categories') IS NULL AS absent")).toEqual([{ absent: true }]); } finally { await sql.close({ timeout: 0 }); }
    }
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("a crash after the initialization committed but before its bookkeeping still leaves external drift evidence", async () => {
  const { fixture, root, project, config, database } = await setup("bookkeeping");
  try {
    const categories = defineTable("bookkeeping_categories", { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(40) } });
    await generateMigration(project, [categories]);
    const target = database("fleur_review_bookkeeping");
    expect((await startDevelopmentDatabase(target, project, [], config)).initialization.status).toBe("initialized");
    // Simulate losing everything written after COMMIT: the record still names the committed transaction and the
    // external maintenance record was never written.
    const [path] = await recordPath(config.stateRoot);
    await writeFile(path!, JSON.stringify({ ...JSON.parse(await readFile(path!, "utf8")), stage: "initializing" }) + "\n");
    await rm(join(path!, "..", "maintenance.json"));
    expect(await startDevelopmentDatabase(target, project, [], config)).toMatchObject({ state: "ready", initialization: { status: "existing" } });
    // Erasing the database's own metadata and contents cannot hide the drift from Fleur's external record.
    const sql = new SQL(target.url, { max: 1 });
    try { await sql.unsafe("DROP SCHEMA fleur_internal CASCADE; DROP TABLE bookkeeping_categories"); } finally { await sql.close({ timeout: 0 }); }
    expect((await startDevelopmentDatabase(target, project, [], config)).reasons.map(reason => reason.code)).toContain("SCHEMA_DRIFT");
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("database creation blocked past the startup deadline fails without reporting ready", async () => {
  const { fixture, root, project, config, database } = await setup("deadline");
  const blocker = new SQL(fixture.url, { max: 1 });
  try {
    // SHARE blocks the catalog insert of CREATE DATABASE while still allowing catalog reads.
    await blocker.unsafe("BEGIN"); await blocker.unsafe("LOCK TABLE pg_catalog.pg_database IN SHARE MODE");
    const started = performance.now();
    const report = await startDevelopmentDatabase(database("fleur_review_deadline"), project, [], { ...config, timeoutMs: 3000 });
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(report).toMatchObject({ ready: false, state: "failed" });
    expect(report.error?.action.command).toBeString();
  } finally { await blocker.unsafe("ROLLBACK").catch(() => {}); await blocker.close({ timeout: 0 }); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

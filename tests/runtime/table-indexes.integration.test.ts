import { expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ownedPostgres } from "./owned-postgres";
import { column, defineTable, eq, type ColumnReference, type Table } from "../../src/database";
import { tableDefinitions } from "../../src/runtime/declarations";
import { constraintName } from "../../src/runtime/database/table-ddl";
import { generateMigration } from "../../src/runtime/database/migration-plan";
import { applyMigrations, migrationStatus } from "../../src/runtime/database/migrations";
import { inspectDatabase } from "../../src/runtime/database/inspection";
import { compileRead } from "../../src/runtime/database/selection";
import { ReadBroker } from "../../src/runtime/database/broker";
import { migrationTables } from "../../src/runtime/database/migration-declarations";

// Requirements: issue #93; docs/planning/V1-SPEC.md "Database migrations, seeds and recovery", "Schema inspection and
// database health", "Database tooling for application agents" and the reference workload of 10,000 sessions.
// Every database is an owned disposable PostgreSQL container; nothing here touches development data.
interface PlanNode { "Node Type": string; "Index Name"?: string; "Relation Name"?: string; Plans?: PlanNode[] }
async function project(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(root, "fleur.json"), JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
  return root;
}
async function migrationStatusCli(root: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../bin/fleur.ts"), "db", "migration", "status", "--project", root, "--json"], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(errors).toBe("");
  return { exit, result: JSON.parse(output) as { data: unknown } };
}
const indexName = (table: string, key: string) => constraintName(table, key, "index");
async function indexDefinitions(sql: SQL, table: string): Promise<Record<string, string>> {
  const rows = await sql.unsafe("SELECT indexname::text AS name, indexdef AS definition FROM pg_indexes WHERE schemaname='public' AND tablename=$1 AND indexname::text LIKE 'fleur\\_index\\_%' ORDER BY 1", [table]) as { name: string; definition: string }[];
  return Object.fromEntries(rows.map(row => [row.name, row.definition]));
}
function planNodes(node: PlanNode): PlanNode[] { return [node, ...(node.Plans ?? []).flatMap(planNodes)]; }
/** EXPLAIN of the exact statement Fleur compiles for a typed read, with its bound values. */
async function explainRead(sql: SQL, tables: readonly Table[], selection: Parameters<typeof compileRead>[0]): Promise<PlanNode[]> {
  const compiled = compileRead(selection, new Set(tables), randomBytes(32));
  const rows = await sql.unsafe(`EXPLAIN (FORMAT JSON) ${compiled.sql}`, compiled.values) as { "QUERY PLAN": [{ Plan: PlanNode }] | string }[];
  const plan = rows[0]!["QUERY PLAN"];
  return planNodes((typeof plan === "string" ? JSON.parse(plan) as [{ Plan: PlanNode }] : plan)[0].Plan);
}
/** Index scans PostgreSQL performed in the current transaction, including those of referential-action queries. */
async function scansDuring(sql: SQL, index: string, action: (transaction: SQL) => Promise<unknown>): Promise<number> {
  return sql.begin(async transaction => {
    await action(transaction as unknown as SQL);
    const rows = await transaction.unsafe("SELECT pg_stat_get_xact_numscans(to_regclass($1))::int AS scans", [`public.${index}`]) as { scans: number }[];
    return rows[0]!.scans;
  }) as Promise<number>;
}

function historyTables(version: 1 | 2 | 3) {
  const sessions = defineTable("index_sessions", {
    columns: { id: column.uuid().primaryKey().generated(), performedOn: column.localDate(), label: column.string().max(100).nullable() },
    ...(version === 2 ? { indexes: [{ fields: [{ field: "performedOn", direction: "desc" }, { field: "id", direction: "desc" }] }] } as const : {}),
  });
  const sets = defineTable("index_sets", {
    columns: { id: column.uuid().primaryKey().generated(), sessionId: column.uuid().references(sessions.id, { onDelete: "cascade" }), position: column.safeInteger() },
    ...(version === 1 ? {} : { indexes: [{ fields: ["sessionId", "position"] }] } as const),
  });
  return { sessions, sets, all: [sessions, sets] as const };
}

test("declared indexes generate reviewed migrations, serve history and cascade paths, and persist across a PostgreSQL restart", async () => {
  const fixture = await ownedPostgres();
  const root = await project("fleur-indexes-apply-");
  const historyIndex = indexName("index_sessions", "performedOn desc,id desc"), setIndex = indexName("index_sets", "sessionId,position");
  let witness: SQL | undefined, broker: ReadBroker | undefined;
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    await generateMigration(root, historyTables(1).all);
    expect((await applyMigrations(fixture.url, root, config)).applied).toEqual(["0001"]);
    // Development-shaped rows that the index migration must preserve: 10,000 sessions with 10 sets each.
    await fixture.sql.unsafe("INSERT INTO index_sessions(\"performedOn\",label) SELECT DATE '2000-01-01' + (n % 3650), 'session '||n FROM generate_series(1,10000) n");
    await fixture.sql.unsafe("INSERT INTO index_sets(\"sessionId\",position) SELECT s.id, p FROM index_sessions s CROSS JOIN generate_series(0,9) p");

    // Generation compiles the declarations into reviewable SQL and leaves the database unchanged.
    const declared = historyTables(2);
    const generated = await generateMigration(root, declared.all);
    expect(generated.generated).toBe(true);
    expect(generated.plan).toMatchObject({ id: "0002", removals: [], incompatibilities: [], backfills: [] });
    expect(generated.plan.statements).toContain(`CREATE INDEX "${historyIndex}" ON "public"."index_sessions" ("performedOn" DESC NULLS LAST, "id" DESC NULLS LAST)`);
    expect(generated.plan.statements).toContain(`CREATE INDEX "${setIndex}" ON "public"."index_sets" ("sessionId", "position")`);
    expect(generated.plan.statements.filter(statement => /\bINDEX\b/.test(statement) && !statement.includes("UNIQUE") && statement.startsWith("CREATE"))).toHaveLength(2);
    expect(await indexDefinitions(fixture.sql, "index_sets")).toEqual({});
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: false, pending: ["0002"], drift: false });

    // Adding indexes removes no data, so it applies without human approval and preserves every row.
    const approvals: unknown[] = [];
    expect((await applyMigrations(fixture.url, root, { ...config, confirm: async request => { approvals.push(request); return true; } })).applied).toEqual(["0002"]);
    expect(approvals).toEqual([]);
    expect(await fixture.sql.unsafe("SELECT (SELECT count(*) FROM index_sessions)::int AS sessions, (SELECT count(*) FROM index_sets)::int AS sets")).toEqual([{ sessions: 10000, sets: 100000 }]);
    expect(await indexDefinitions(fixture.sql, "index_sessions")).toEqual({ [historyIndex]: `CREATE INDEX ${historyIndex} ON public.index_sessions USING btree ("performedOn" DESC NULLS LAST, id DESC NULLS LAST)` });
    expect(await indexDefinitions(fixture.sql, "index_sets")).toEqual({ [setIndex]: `CREATE INDEX ${setIndex} ON public.index_sets USING btree ("sessionId", "position")` });
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: true, applied: ["0001", "0002"], pending: [], drift: false, differenceCount: 0 });

    // The schema overview reports the declared indexes with their key columns and definitions.
    const overview = (await inspectDatabase(fixture.url, { project: root }, config)).data as { tables: { name: string; indexes: unknown[] }[] };
    expect(overview.tables.find(table => table.name === "index_sessions")!.indexes).toEqual([{ name: historyIndex, unique: false, columns: ["performedOn", "id"], caseFolded: false, definition: expect.stringContaining('("performedOn" DESC NULLS LAST, id DESC NULLS LAST)') }]);
    expect(overview.tables.find(table => table.name === "index_sets")!.indexes).toEqual([{ name: setIndex, unique: false, columns: ["sessionId", "position"], caseFolded: false, definition: expect.stringContaining('("sessionId", "position")') }]);

    // Fleur orders nulls last in both directions; the descending index matches that order, so a newest-first history
    // page and one session's ordered sets read through the indexes without sorting.
    await fixture.sql.unsafe("ANALYZE index_sessions; ANALYZE index_sets");
    const history = await explainRead(fixture.sql, declared.all, { from: declared.sessions, joins: [], fields: { id: declared.sessions.id, performedOn: declared.sessions.performedOn }, orderBy: [{ column: declared.sessions.performedOn, direction: "desc" }, { column: declared.sessions.id, direction: "desc" }], limit: 21 });
    expect(history.filter(node => node["Index Name"] === historyIndex).length).toBe(1);
    expect(history.map(node => node["Node Type"])).not.toContain("Sort");
    expect(history.map(node => node["Node Type"])).not.toContain("Seq Scan");
    // The primary key's ascending index read backwards sorts nulls first, so Fleur's descending order needs its own index.
    const byId = await explainRead(fixture.sql, declared.all, { from: declared.sessions, joins: [], fields: { id: declared.sessions.id }, orderBy: [{ column: declared.sessions.id, direction: "desc" }], limit: 21 });
    expect(byId.map(node => node["Node Type"])).toContain("Sort");
    const [{ id: sessionId }] = await fixture.sql.unsafe("SELECT id FROM index_sessions ORDER BY \"performedOn\", id LIMIT 1") as [{ id: string }];
    const children = await explainRead(fixture.sql, declared.all, { from: declared.sets, joins: [], fields: { id: declared.sets.id, position: declared.sets.position }, where: eq(declared.sets.sessionId, sessionId as never), orderBy: [{ column: declared.sets.position, direction: "asc" }], limit: 500 });
    expect(children.filter(node => node["Index Name"] === setIndex).length).toBe(1);
    expect(children.map(node => node["Node Type"])).not.toContain("Seq Scan");
    // Deleting a session cascades to its sets through the foreign-key index.
    expect(await scansDuring(fixture.sql, setIndex, transaction => transaction.unsafe("DELETE FROM index_sessions WHERE id=$1", [sessionId]))).toBeGreaterThan(0);
    expect(await fixture.sql.unsafe("SELECT count(*)::int AS sets FROM index_sets WHERE \"sessionId\"=$1", [sessionId])).toEqual([{ sets: 0 }]);

    // A PostgreSQL restart terminates every session and recovers from storage; data, indexes and history persist.
    witness = new SQL(fixture.url, { max: 1, connectionTimeout: 2 });
    const [{ pid }] = await witness`SELECT pg_backend_pid() AS pid` as [{ pid: number }];
    await fixture.restart();
    expect(await fixture.sql.unsafe("SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE pid=$1", [pid])).toEqual([{ sessions: 0 }]);
    expect(await fixture.sql.unsafe("SELECT (SELECT count(*) FROM index_sessions)::int AS sessions, (SELECT count(*) FROM index_sets)::int AS sets")).toEqual([{ sessions: 9999, sets: 99990 }]);
    expect(Object.keys(await indexDefinitions(fixture.sql, "index_sessions"))).toEqual([historyIndex]);
    expect(Object.keys(await indexDefinitions(fixture.sql, "index_sets"))).toEqual([setIndex]);
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: true, applied: ["0001", "0002"], drift: false });
    broker = new ReadBroker({ url: fixture.url, tables: declared.all, maintenance: { stateRoot: root } });
    const newest = await broker.read(db => db.select(declared.sessions, { fields: ["performedOn"], orderBy: [{ field: "performedOn", direction: "desc" }], limit: 1 }));
    expect(newest.map(row => String(row.performedOn))).toEqual(["2009-12-28"]);
    await broker.close(); broker = undefined;

    // Removing a declared index is not a data removal: it applies without approval and keeps every row.
    const reduced = await generateMigration(root, historyTables(3).all);
    expect(reduced.plan).toMatchObject({ id: "0003", removals: [], incompatibilities: [], backfills: [] });
    expect(reduced.plan.statements).toContain(`DROP INDEX public."${historyIndex}"`);
    expect((await applyMigrations(fixture.url, root, { ...config, confirm: async request => { approvals.push(request); return true; } })).applied).toEqual(["0003"]);
    expect(approvals).toEqual([]);
    expect(await indexDefinitions(fixture.sql, "index_sessions")).toEqual({});
    expect(Object.keys(await indexDefinitions(fixture.sql, "index_sets"))).toEqual([setIndex]);
    expect(await fixture.sql.unsafe("SELECT count(*)::int AS sets FROM index_sets")).toEqual([{ sets: 99990 }]);
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: true, applied: ["0001", "0002", "0003"], drift: false });
  } finally {
    await witness?.close({ timeout: 0 }).catch(() => {});
    await broker?.close();
    await fixture.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

test("status reports a missing or different declared index as drift, and admission refuses it until the index matches", async () => {
  const fixture = await ownedPostgres();
  const root = await project("fleur-indexes-drift-");
  const parents = defineTable("drift_parents", { columns: { id: column.uuid().primaryKey() } });
  const children = defineTable("drift_children", {
    columns: { id: column.uuid().primaryKey(), parentId: column.uuid().references(parents.id, { onDelete: "cascade" }), position: column.safeInteger() },
    indexes: [{ fields: ["parentId", "position"] }, { fields: [{ field: "position", direction: "desc" }] }],
  });
  const ordered = indexName("drift_children", "parentId,position"), descending = indexName("drift_children", "position desc");
  const broker = new ReadBroker({ url: fixture.url, tables: [parents, children], maintenance: { stateRoot: root } });
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    await generateMigration(root, [parents, children]);
    await applyMigrations(fixture.url, root, config);
    const env = { FLEUR_PRIVATE_DATABASE_URL: fixture.url, FLEUR_PRIVATE_STATE_ROOT: root };
    const status = async () => {
      const outcome = await migrationStatusCli(root, env);
      expect(outcome.exit).toBe(0);
      return outcome.result.data as { migrations: { compatible: boolean; drift: boolean }; differences: unknown[] };
    };
    const refused = async () => {
      let dispatched = false;
      await expect(broker.read(async () => { dispatched = true; return []; })).rejects.toThrow("SCHEMA_DRIFT");
      expect(dispatched).toBe(false);
    };
    expect((await status()).migrations).toMatchObject({ compatible: true, drift: false });
    expect(await broker.read(db => db.select(children, { fields: ["id"] }))).toEqual([]);

    await fixture.sql.unsafe(`DROP INDEX public."${ordered}"`);
    expect(await status()).toMatchObject({ migrations: { compatible: false, drift: true }, differences: [{ object: `index drift_children.${ordered}`, expected: "index (parentId, position)", actual: null }] });
    await refused();

    for (const [definition, actual] of [
      [`("position", "parentId")`, "index (position, parentId)"],
      [`("parentId", "position" DESC)`, "index (parentId, position desc nulls first)"],
      [`("parentId" NULLS FIRST, "position")`, "index (parentId nulls first, position)"],
    ] as const) {
      await fixture.sql.unsafe(`CREATE INDEX "${ordered}" ON public.drift_children ${definition}`);
      expect(await status()).toMatchObject({ migrations: { drift: true }, differences: [{ object: `index drift_children.${ordered}`, expected: "index (parentId, position)", actual }] });
      await refused();
      await fixture.sql.unsafe(`DROP INDEX public."${ordered}"`);
    }
    await fixture.sql.unsafe(`CREATE UNIQUE INDEX "${ordered}" ON public.drift_children ("parentId", "position")`);
    expect(await status()).toMatchObject({ differences: [{ object: `index drift_children.${ordered}`, expected: "index (parentId, position)", actual: "unique (parentId, position)" }] });
    await fixture.sql.unsafe(`DROP INDEX public."${ordered}"`);

    // PostgreSQL's default descending order puts nulls first; Fleur's declared descending index keeps them last.
    await fixture.sql.unsafe(`DROP INDEX public."${descending}"; CREATE INDEX "${descending}" ON public.drift_children ("position" DESC)`);
    await fixture.sql.unsafe(`CREATE INDEX "${ordered}" ON public.drift_children ("parentId", "position")`);
    expect(await status()).toMatchObject({ differences: [{ object: `index drift_children.${descending}`, expected: "index (position desc)", actual: "index (position desc nulls first)" }] });
    await refused();

    // Recreating the exact declared definitions restores the recorded catalog: no drift, and reads are admitted again.
    await fixture.sql.unsafe(`DROP INDEX public."${descending}"; CREATE INDEX "${descending}" ON public.drift_children ("position" DESC NULLS LAST)`);
    expect(await status()).toMatchObject({ migrations: { compatible: true, drift: false }, differences: [] });
    expect(await broker.read(db => db.select(children, { fields: ["id"] }))).toEqual([]);
  } finally {
    await broker.close();
    await fixture.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);

test("the workout templates fixture's reviewed migration indexes its foreign keys and ordered entry reads", async () => {
  const tables = await migrationTables(fileURLToPath(new URL("fixtures/workouts", import.meta.url)));
  const named = (name: string) => tables.find(table => tableDefinitions.get(table)?.name === name)!;
  const entries = named("workout_template_entries");
  const field = (name: string) => (entries as unknown as Record<string, ColumnReference>)[name]!;
  const byTemplate = indexName("workout_template_entries", "templateId,position"), byExercise = indexName("workout_template_entries", "exerciseId");
  const fixture = await ownedPostgres();
  const root = await project("fleur-indexes-workouts-");
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    const { plan } = await generateMigration(root, tables);
    expect(plan.statements).toContain(`CREATE INDEX "${byTemplate}" ON "public"."workout_template_entries" ("templateId", "position")`);
    expect(plan.statements).toContain(`CREATE INDEX "${byExercise}" ON "public"."workout_template_entries" ("exerciseId")`);
    for (const table of ["exercises", "workout_templates"]) expect(plan.statements).toContain(`CREATE INDEX "${indexName(table, "name,id")}" ON "public"."${table}" ("name", "id")`);
    expect((await applyMigrations(fixture.url, root, config)).applied).toEqual(["0001"]);
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: true, drift: false });

    // Reference catalog: 500 exercises and 100 templates, here with 100 entries each.
    await fixture.sql.unsafe("INSERT INTO exercises(name) SELECT 'Exercise '||n FROM generate_series(1,500) n");
    await fixture.sql.unsafe("INSERT INTO workout_templates(name) SELECT 'Template '||n FROM generate_series(1,100) n");
    await fixture.sql.unsafe("WITH catalog AS (SELECT array_agg(id ORDER BY name) AS ids FROM exercises) INSERT INTO workout_template_entries(\"templateId\",position,\"exerciseId\",\"targetSets\",\"targetRepetitions\") SELECT t.id, p, catalog.ids[1 + (p * 7 + length(t.name)) % 500], 3, 5 FROM workout_templates t CROSS JOIN generate_series(0,99) p CROSS JOIN catalog");
    await fixture.sql.unsafe("ANALYZE exercises; ANALYZE workout_templates; ANALYZE workout_template_entries");
    const [template] = await fixture.sql.unsafe("SELECT id FROM workout_templates ORDER BY name LIMIT 1") as [{ id: string }];
    const read = await explainRead(fixture.sql, tables, { from: entries, joins: [], fields: { id: field("id"), position: field("position") }, where: eq(field("templateId"), template.id), orderBy: [{ column: field("position"), direction: "asc" }], limit: 100 });
    expect(read.filter(node => node["Index Name"] === byTemplate).length).toBe(1);
    expect(read.map(node => node["Node Type"])).not.toContain("Seq Scan");
    // Restrict checks on exercise deletion and cascades on template deletion look entries up through their indexes.
    const [unused] = await fixture.sql.unsafe("INSERT INTO exercises(name) VALUES ('Unused') RETURNING id") as [{ id: string }];
    expect(await scansDuring(fixture.sql, byExercise, transaction => transaction.unsafe("DELETE FROM exercises WHERE id=$1", [unused.id]))).toBeGreaterThan(0);
    expect(await scansDuring(fixture.sql, byTemplate, transaction => transaction.unsafe("DELETE FROM workout_templates WHERE id=$1", [template.id]))).toBeGreaterThan(0);
    expect(await fixture.sql.unsafe("SELECT count(*)::int AS entries FROM workout_template_entries")).toEqual([{ entries: 9900 }]);
  } finally {
    await fixture.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 360_000);

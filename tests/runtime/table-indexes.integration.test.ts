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
// database health", "Database tooling for application agents" and the reference workload of 10,000 dated history records.
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
  const meals = defineTable("index_meals", {
    columns: { id: column.uuid().primaryKey().generated(), servedOn: column.localDate(), label: column.string().max(100).nullable() },
    ...(version === 2 ? { indexes: [{ fields: [{ field: "servedOn", direction: "desc" }, { field: "id", direction: "desc" }] }] } as const : {}),
  });
  const portions = defineTable("index_portions", {
    columns: { id: column.uuid().primaryKey().generated(), mealId: column.uuid().references(meals.id, { onDelete: "cascade" }), position: column.safeInteger() },
    ...(version === 1 ? {} : { indexes: [{ fields: ["mealId", "position"] }] } as const),
  });
  return { meals, portions, all: [meals, portions] as const };
}

test("declared indexes generate reviewed migrations, serve history and cascade paths, and persist across a PostgreSQL restart", async () => {
  const fixture = await ownedPostgres();
  const root = await project("fleur-indexes-apply-");
  const historyIndex = indexName("index_meals", "servedOn desc,id desc"), portionIndex = indexName("index_portions", "mealId,position");
  let witness: SQL | undefined, broker: ReadBroker | undefined;
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    await generateMigration(root, historyTables(1).all);
    expect((await applyMigrations(fixture.url, root, config)).applied).toEqual(["0001"]);
    // Development-shaped rows that the index migration must preserve: 10,000 meals with 10 portions each.
    await fixture.sql.unsafe("INSERT INTO index_meals(\"servedOn\",label) SELECT DATE '2000-01-01' + (n % 3650), 'meal '||n FROM generate_series(1,10000) n");
    await fixture.sql.unsafe("INSERT INTO index_portions(\"mealId\",position) SELECT s.id, p FROM index_meals s CROSS JOIN generate_series(0,9) p");

    // Generation compiles the declarations into reviewable SQL and leaves the database unchanged.
    const declared = historyTables(2);
    const generated = await generateMigration(root, declared.all);
    expect(generated.generated).toBe(true);
    expect(generated.plan).toMatchObject({ id: "0002", removals: [], incompatibilities: [], backfills: [] });
    expect(generated.plan.statements).toContain(`CREATE INDEX "${historyIndex}" ON "public"."index_meals" ("servedOn" DESC NULLS LAST, "id" DESC NULLS LAST)`);
    expect(generated.plan.statements).toContain(`CREATE INDEX "${portionIndex}" ON "public"."index_portions" ("mealId", "position")`);
    expect(generated.plan.statements.filter(statement => /\bINDEX\b/.test(statement) && !statement.includes("UNIQUE") && statement.startsWith("CREATE"))).toHaveLength(2);
    expect(await indexDefinitions(fixture.sql, "index_portions")).toEqual({});
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: false, pending: ["0002"], drift: false });

    // Adding indexes removes no data, so it applies without human approval and preserves every row.
    const approvals: unknown[] = [];
    expect((await applyMigrations(fixture.url, root, { ...config, confirm: async request => { approvals.push(request); return true; } })).applied).toEqual(["0002"]);
    expect(approvals).toEqual([]);
    expect(await fixture.sql.unsafe("SELECT (SELECT count(*) FROM index_meals)::int AS meals, (SELECT count(*) FROM index_portions)::int AS portions")).toEqual([{ meals: 10000, portions: 100000 }]);
    expect(await indexDefinitions(fixture.sql, "index_meals")).toEqual({ [historyIndex]: `CREATE INDEX ${historyIndex} ON public.index_meals USING btree ("servedOn" DESC NULLS LAST, id DESC NULLS LAST)` });
    expect(await indexDefinitions(fixture.sql, "index_portions")).toEqual({ [portionIndex]: `CREATE INDEX ${portionIndex} ON public.index_portions USING btree ("mealId", "position")` });
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: true, applied: ["0001", "0002"], pending: [], drift: false, differenceCount: 0 });

    // The schema overview reports the declared indexes with their key columns and definitions.
    const overview = (await inspectDatabase(fixture.url, { project: root }, config)).data as { tables: { name: string; indexes: unknown[] }[] };
    expect(overview.tables.find(table => table.name === "index_meals")!.indexes).toEqual([{ name: historyIndex, unique: false, columns: ["servedOn", "id"], caseFolded: false, definition: expect.stringContaining('("servedOn" DESC NULLS LAST, id DESC NULLS LAST)') }]);
    expect(overview.tables.find(table => table.name === "index_portions")!.indexes).toEqual([{ name: portionIndex, unique: false, columns: ["mealId", "position"], caseFolded: false, definition: expect.stringContaining('("mealId", "position")') }]);

    // Fleur orders nulls last in both directions; the descending index matches that order, so a newest-first history
    // page and one meal's ordered portions read through the indexes without sorting.
    await fixture.sql.unsafe("ANALYZE index_meals; ANALYZE index_portions");
    const history = await explainRead(fixture.sql, declared.all, { from: declared.meals, joins: [], fields: { id: declared.meals.id, servedOn: declared.meals.servedOn }, orderBy: [{ column: declared.meals.servedOn, direction: "desc" }, { column: declared.meals.id, direction: "desc" }], limit: 21 });
    expect(history.filter(node => node["Index Name"] === historyIndex).length).toBe(1);
    expect(history.map(node => node["Node Type"])).not.toContain("Sort");
    expect(history.map(node => node["Node Type"])).not.toContain("Seq Scan");
    // The primary key's ascending index read backwards sorts nulls first, so Fleur's descending order needs its own index.
    const byId = await explainRead(fixture.sql, declared.all, { from: declared.meals, joins: [], fields: { id: declared.meals.id }, orderBy: [{ column: declared.meals.id, direction: "desc" }], limit: 21 });
    expect(byId.map(node => node["Node Type"])).toContain("Sort");
    const [{ id: mealId }] = await fixture.sql.unsafe("SELECT id FROM index_meals ORDER BY \"servedOn\", id LIMIT 1") as [{ id: string }];
    const children = await explainRead(fixture.sql, declared.all, { from: declared.portions, joins: [], fields: { id: declared.portions.id, position: declared.portions.position }, where: eq(declared.portions.mealId, mealId as never), orderBy: [{ column: declared.portions.position, direction: "asc" }], limit: 500 });
    expect(children.filter(node => node["Index Name"] === portionIndex).length).toBe(1);
    expect(children.map(node => node["Node Type"])).not.toContain("Seq Scan");
    // Deleting a meal cascades to its portions through the foreign-key index.
    expect(await scansDuring(fixture.sql, portionIndex, transaction => transaction.unsafe("DELETE FROM index_meals WHERE id=$1", [mealId]))).toBeGreaterThan(0);
    expect(await fixture.sql.unsafe("SELECT count(*)::int AS portions FROM index_portions WHERE \"mealId\"=$1", [mealId])).toEqual([{ portions: 0 }]);

    // A PostgreSQL restart terminates every session and recovers from storage; data, indexes and history persist.
    witness = new SQL(fixture.url, { max: 1, connectionTimeout: 2 });
    const [{ pid }] = await witness`SELECT pg_backend_pid() AS pid` as [{ pid: number }];
    await fixture.restart();
    expect(await fixture.sql.unsafe("SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE pid=$1", [pid])).toEqual([{ sessions: 0 }]);
    expect(await fixture.sql.unsafe("SELECT (SELECT count(*) FROM index_meals)::int AS meals, (SELECT count(*) FROM index_portions)::int AS portions")).toEqual([{ meals: 9999, portions: 99990 }]);
    expect(Object.keys(await indexDefinitions(fixture.sql, "index_meals"))).toEqual([historyIndex]);
    expect(Object.keys(await indexDefinitions(fixture.sql, "index_portions"))).toEqual([portionIndex]);
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: true, applied: ["0001", "0002"], drift: false });
    broker = new ReadBroker({ url: fixture.url, tables: declared.all, maintenance: { stateRoot: root } });
    const newest = await broker.read(db => db.select(declared.meals, { fields: ["servedOn"], orderBy: [{ field: "servedOn", direction: "desc" }], limit: 1 }));
    expect(newest.map(row => String(row.servedOn))).toEqual(["2009-12-28"]);
    await broker.close(); broker = undefined;

    // Removing a declared index is not a data removal: it applies without approval and keeps every row.
    const reduced = await generateMigration(root, historyTables(3).all);
    expect(reduced.plan).toMatchObject({ id: "0003", removals: [], incompatibilities: [], backfills: [] });
    expect(reduced.plan.statements).toContain(`DROP INDEX public."${historyIndex}"`);
    expect((await applyMigrations(fixture.url, root, { ...config, confirm: async request => { approvals.push(request); return true; } })).applied).toEqual(["0003"]);
    expect(approvals).toEqual([]);
    expect(await indexDefinitions(fixture.sql, "index_meals")).toEqual({});
    expect(Object.keys(await indexDefinitions(fixture.sql, "index_portions"))).toEqual([portionIndex]);
    expect(await fixture.sql.unsafe("SELECT count(*)::int AS portions FROM index_portions")).toEqual([{ portions: 99990 }]);
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

test("the recipes fixture's reviewed migration indexes its foreign keys, ordered step reads and meal history", async () => {
  const tables = await migrationTables(fileURLToPath(new URL("fixtures/recipes", import.meta.url)));
  const named = (name: string) => tables.find(table => tableDefinitions.get(table)?.name === name)!;
  const steps = named("recipe_steps");
  const field = (name: string) => (steps as unknown as Record<string, ColumnReference>)[name]!;
  const byRecipe = indexName("recipe_steps", "recipeId,position"), byIngredient = indexName("recipe_steps", "ingredientId");
  const fixture = await ownedPostgres();
  const root = await project("fleur-indexes-recipes-");
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    const { plan } = await generateMigration(root, tables);
    expect(plan.statements).toContain(`CREATE INDEX "${byRecipe}" ON "public"."recipe_steps" ("recipeId", "position")`);
    expect(plan.statements).toContain(`CREATE INDEX "${byIngredient}" ON "public"."recipe_steps" ("ingredientId")`);
    for (const table of ["ingredients", "recipes"]) expect(plan.statements).toContain(`CREATE INDEX "${indexName(table, "name,id")}" ON "public"."${table}" ("name", "id")`);
    // Meal history reads newest dates first with Fleur's ascending id tie-breaker; children read by parent in position order.
    expect(plan.statements).toContain(`CREATE INDEX "${indexName("meals", "date desc,id")}" ON "public"."meals" ("date" DESC NULLS LAST, "id")`);
    expect(plan.statements).toContain(`CREATE INDEX "${indexName("meal_ingredients", "mealId,position")}" ON "public"."meal_ingredients" ("mealId", "position")`);
    expect(plan.statements).toContain(`CREATE INDEX "${indexName("meal_portions", "mealIngredientId,position")}" ON "public"."meal_portions" ("mealIngredientId", "position")`);
    expect((await applyMigrations(fixture.url, root, config)).applied).toEqual(["0001"]);
    expect((await migrationStatus(fixture.url, root, config)).migrations).toMatchObject({ compatible: true, drift: false });

    // Reference catalog: 500 ingredients and 100 recipes, here with 100 steps each.
    await fixture.sql.unsafe("INSERT INTO ingredients(name) SELECT 'Ingredient '||n FROM generate_series(1,500) n");
    await fixture.sql.unsafe("INSERT INTO recipes(name) SELECT 'Recipe '||n FROM generate_series(1,100) n");
    await fixture.sql.unsafe("WITH catalog AS (SELECT array_agg(id ORDER BY name) AS ids FROM ingredients) INSERT INTO recipe_steps(\"recipeId\",position,\"ingredientId\",\"targetPortions\",\"targetCount\") SELECT t.id, p, catalog.ids[1 + (p * 7 + length(t.name)) % 500], 3, 5 FROM recipes t CROSS JOIN generate_series(0,99) p CROSS JOIN catalog");
    await fixture.sql.unsafe("ANALYZE ingredients; ANALYZE recipes; ANALYZE recipe_steps");
    const [recipe] = await fixture.sql.unsafe("SELECT id FROM recipes ORDER BY name LIMIT 1") as [{ id: string }];
    const read = await explainRead(fixture.sql, tables, { from: steps, joins: [], fields: { id: field("id"), position: field("position") }, where: eq(field("recipeId"), recipe.id), orderBy: [{ column: field("position"), direction: "asc" }], limit: 100 });
    expect(read.filter(node => node["Index Name"] === byRecipe).length).toBe(1);
    expect(read.map(node => node["Node Type"])).not.toContain("Seq Scan");
    // Restrict checks on ingredient deletion and cascades on recipe deletion look steps up through their indexes.
    const [unused] = await fixture.sql.unsafe("INSERT INTO ingredients(name) VALUES ('Unused') RETURNING id") as [{ id: string }];
    expect(await scansDuring(fixture.sql, byIngredient, transaction => transaction.unsafe("DELETE FROM ingredients WHERE id=$1", [unused.id]))).toBeGreaterThan(0);
    expect(await scansDuring(fixture.sql, byRecipe, transaction => transaction.unsafe("DELETE FROM recipes WHERE id=$1", [recipe.id]))).toBeGreaterThan(0);
    expect(await fixture.sql.unsafe("SELECT count(*)::int AS steps FROM recipe_steps")).toEqual([{ steps: 9900 }]);
  } finally {
    await fixture.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 360_000);

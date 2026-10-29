import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { ownedPostgres } from "./owned-postgres";

// Requirements: issues #31 and #102; docs/mutations.md "Ordered child collections". A recipe is one ordered
// aggregate: a trimmed name and 1–100 steps, each referencing a catalog ingredient with positive integer targets.
// Every operation runs through the restricted application path against an owned disposable database.
interface Ingredient { id: string; name: string; version: number }
interface Step { ingredientId: string; ingredientName: string; targetPortions: number; targetCount: number }
interface Recipe { id: string; name: string; version: number; steps: Step[] }
interface Listing { recipes: Recipe[]; cursor?: string }
const pageSize = 10;

let images: Awaited<ReturnType<typeof prepareNativeImages>> | undefined;
let fixture: Awaited<ReturnType<typeof ownedPostgres>> | undefined;
let app: ReadApplication;
const ingredients: Record<string, Ingredient> = {};
/** Follows continuation cursors through every listing page. */
async function pages(): Promise<Listing[]> {
  const result: Listing[] = [];
  let cursor: string | undefined;
  do {
    const page = await app.query("recipe.list", cursor === undefined ? {} : { cursor }) as Listing;
    result.push(page);
    cursor = page.cursor;
    if (result.length > 100) throw new Error("Listing did not end within 100 pages");
  } while (cursor !== undefined);
  return result;
}
const list = async () => (await pages()).flatMap(page => page.recipes);
const stored = async (id: string) => (await list()).find(item => item.id === id);
const step = (name: string, targetPortions: number, targetCount: number) => ({ ingredientId: ingredients[name]!.id, targetPortions, targetCount });
const shown = (name: string, targetPortions: number, targetCount: number): Step => ({ ingredientId: ingredients[name]!.id, ingredientName: name, targetPortions, targetCount });

beforeAll(async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/recipes", import.meta.url)));
  images = await prepareNativeImages(await compileWorker(project));
  fixture = await ownedPostgres();
  await fixture.reviewApplication(images, true);
  app = await ReadApplication.open(images, fixture.url);
  for (const name of ["Flour", "Butter", "Sugar", "Egg"]) ingredients[name] = await app.mutate("ingredient.create", { name }) as Ingredient;
  // Competing saves need two retained slots. Create the second before any race so cold
  // slot creation cannot consume a contender's five-second deadline.
  await Promise.allSettled([app.query("recipe.list", {}), app.query("recipe.list", {})]);
  const deadline = Date.now() + 60_000;
  while (app.diagnostics().filter(slot => slot.state === "idle").length < 2) {
    if (Date.now() > deadline) throw new Error("Second retained slot did not become ready");
    await Bun.sleep(100);
  }
}, 300_000);
afterAll(async () => {
  const failures: unknown[] = [];
  for (const cleanup of [() => app?.close(), () => fixture?.cleanup(), () => images?.dispose()]) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  expect(failures, "Recipe fixture cleanup requires inspection").toEqual([]);
}, 120_000);

test("creates trimmed recipes with repeated ordered ingredients and reads them through one joined ordered listing", async () => {
  const created = await app.mutate("recipe.create", { name: "  Shortbread  ", steps: [step("Butter", 3, 5), step("Flour", 2, 10), step("Butter", 4, 6)] }) as Recipe;
  expect(created).toEqual({ id: expect.any(String), name: "Shortbread", version: 1, steps: [shown("Butter", 3, 5), shown("Flour", 2, 10), shown("Butter", 4, 6)] });
  const duplicate = await app.mutate("recipe.create", { name: "Shortbread", steps: [step("Sugar", 1, 1)] }) as Recipe;
  expect(duplicate.id).not.toBe(created.id);
  const astral = "😀".repeat(100);
  const widest = await app.mutate("recipe.create", { name: astral, steps: [step("Egg", Number.MAX_SAFE_INTEGER, 1)] }) as Recipe;
  expect(widest).toMatchObject({ name: astral, steps: [shown("Egg", Number.MAX_SAFE_INTEGER, 1)] });
  // Names order by code point, then id; "S" precedes U+1F600 under any comparison.
  const own = (await list()).filter(item => [created.id, duplicate.id, widest.id].includes(item.id));
  expect(own.map(item => item.id)).toEqual([...[created.id, duplicate.id].sort(), widest.id]);
  expect(own.find(item => item.id === created.id)).toEqual(created);
}, 60_000);

test("steps read in position order regardless of insertion order or row identity", async () => {
  const id = randomUUID();
  await fixture!.sql.unsafe("INSERT INTO recipes(id,name) VALUES($1,'Seeded order')", [id]);
  // Inserted 1, 2, 0 with identities ordering 2, 1, 0: only position yields 0, 1, 2.
  for (const [stepId, position, name] of [["bbbbbbbb-0000-4000-8000-000000000000", 1, "Sugar"], ["aaaaaaaa-0000-4000-8000-000000000000", 2, "Flour"], ["cccccccc-0000-4000-8000-000000000000", 0, "Egg"]] as const)
    await fixture!.sql.unsafe('INSERT INTO recipe_steps(id,"recipeId",position,"ingredientId","targetPortions","targetCount") VALUES($1,$2,$3,$4,$5,1)', [stepId, id, position, ingredients[name]!.id, position + 1]);
  expect((await stored(id))?.steps).toEqual([shown("Egg", 1, 1), shown("Sugar", 2, 1), shown("Flour", 3, 1)]);
}, 60_000);

test("listing pages through recipes whose steps exceed one bounded read, never splitting a recipe", async () => {
  const ids: string[] = [];
  for (let index = 1; index <= 12; index++) {
    const id = randomUUID();
    ids.push(id);
    await fixture!.sql.unsafe("INSERT INTO recipes(id,name) VALUES($1,$2)", [id, `Bulk ${String(index).padStart(2, "0")}`]);
    await fixture!.sql.unsafe('INSERT INTO recipe_steps("recipeId",position,"ingredientId","targetPortions","targetCount") SELECT $1,position,$2,position+1,1 FROM generate_series(0,99) AS position', [id, ingredients.Flour!.id]);
  }
  const listed = await pages();
  expect(listed.length).toBeGreaterThanOrEqual(2);
  for (const page of listed.slice(0, -1)) expect(page).toMatchObject({ recipes: { length: pageSize }, cursor: expect.any(String) });
  expect(listed.at(-1)!.cursor).toBeUndefined();
  const all = listed.flatMap(page => page.recipes);
  expect(new Set(all.map(item => item.id)).size).toBe(all.length);
  const bulk = all.filter(item => ids.includes(item.id));
  expect(bulk.map(item => item.name)).toEqual(Array.from({ length: 12 }, (_, index) => `Bulk ${String(index + 1).padStart(2, "0")}`));
  for (const item of bulk) expect(item.steps).toEqual(Array.from({ length: 100 }, (_, position) => shown("Flour", position + 1, 1)));
}, 60_000);

test("rejects malformed recipe input before any write", async () => {
  const before = await list();
  const valid = { name: "Rejected", steps: [step("Flour", 3, 5)] };
  const malformed: unknown[] = [
    { ...valid, name: "   " },
    { ...valid, name: "😀".repeat(101) },
    { ...valid, steps: [] },
    { name: "Rejected" },
    { ...valid, extra: true },
    { ...valid, steps: [{ ...step("Flour", 3, 5), note: "undeclared" }] },
    { ...valid, steps: [{ ingredientId: ingredients.Flour!.id, targetPortions: 3 }] },
    { ...valid, steps: [step("Flour", 0, 5)] },
    { ...valid, steps: [step("Flour", 3, -1)] },
    { ...valid, steps: [step("Flour", 1.5, 5)] },
    { ...valid, steps: [{ ...step("Flour", 3, 5), targetPortions: "3" }] },
    { ...valid, steps: [step("Flour", Number.MAX_SAFE_INTEGER + 1, 5)] },
    { ...valid, steps: [{ ...step("Flour", 3, 5), ingredientId: "not-a-uuid" }] },
    { ...valid, steps: Array.from({ length: 101 }, () => step("Flour", 1, 1)) },
  ];
  for (const input of malformed) await expect(app.mutate("recipe.create", input), JSON.stringify(input).slice(0, 120)).rejects.toMatchObject({ code: "INPUT_INVALID" });
  expect(await list()).toEqual(before);
}, 60_000);

test("header, child and ordering edits each advance one aggregate version", async () => {
  const created = await app.mutate("recipe.create", { name: "Pancakes", steps: [step("Flour", 5, 5), step("Egg", 1, 5)] }) as Recipe;
  const renamed = await app.mutate("recipe.update", { id: created.id, expectedVersion: 1, name: " Thick pancakes ", steps: [step("Flour", 5, 5), step("Egg", 1, 5)] }) as Recipe;
  expect(renamed).toEqual({ ...created, name: "Thick pancakes", version: 2 });
  const retargeted = await app.mutate("recipe.update", { id: created.id, expectedVersion: 2, name: "Thick pancakes", steps: [step("Flour", 3, 8), step("Egg", 1, 5), step("Flour", 2, 12)] }) as Recipe;
  expect(retargeted).toEqual({ ...renamed, version: 3, steps: [shown("Flour", 3, 8), shown("Egg", 1, 5), shown("Flour", 2, 12)] });
  const reordered = await app.mutate("recipe.update", { id: created.id, expectedVersion: 3, name: "Thick pancakes", steps: [step("Flour", 2, 12), step("Flour", 3, 8), step("Egg", 1, 5)] }) as Recipe;
  expect(reordered).toEqual({ ...retargeted, version: 4, steps: [shown("Flour", 2, 12), shown("Flour", 3, 8), shown("Egg", 1, 5)] });
  expect(await stored(created.id)).toEqual(reordered);
  await expect(app.mutate("recipe.update", { id: created.id, expectedVersion: 3, name: "Stale", steps: [step("Sugar", 1, 1)] })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(app.mutate("recipe.update", { id: randomUUID(), expectedVersion: 1, name: "Absent", steps: [step("Sugar", 1, 1)] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(app.mutate("recipe.update", { id: created.id, expectedVersion: 4, name: "  ", steps: [step("Sugar", 1, 1)] })).rejects.toMatchObject({ code: "INPUT_INVALID", details: { name: expect.any(String) } });
  expect(await stored(created.id)).toEqual(reordered);
}, 60_000);

test("child and output failures roll back the header and every child write", async () => {
  const before = await list();
  await expect(app.mutate("recipe.create", { name: "Orphan", steps: [step("Sugar", 3, 10), { ingredientId: randomUUID(), targetPortions: 3, targetCount: 10 }] })).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect(await list()).toEqual(before);
  const created = await app.mutate("recipe.create", { name: "Meringue", steps: [step("Sugar", 4, 8), step("Egg", 1, 3)] }) as Recipe;
  await expect(app.mutate("recipe.update", { id: created.id, expectedVersion: 1, name: "Meringue changed", steps: [step("Butter", 2, 2), { ingredientId: randomUUID(), targetPortions: 1, targetCount: 1 }] })).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect(await stored(created.id)).toEqual(created);
  await expect(app.mutate("recipe.rejectOutput", { id: created.id, expectedVersion: 1, name: "Meringue output", steps: [step("Flour", 9, 9)] })).rejects.toThrow("INTERNAL_FAILURE");
  expect(await stored(created.id)).toEqual(created);
}, 60_000);

for (let repeat = 1; repeat <= 2; repeat++) test(`competing saves at one expected version have one winner and never mix children, repeat ${repeat}`, async () => {
  const created = await app.mutate("recipe.create", { name: `Contested ${repeat}`, steps: [step("Flour", 1, 1), step("Sugar", 1, 1)] }) as Recipe;
  const left = { id: created.id, expectedVersion: 1, name: `Left ${repeat}`, steps: [step("Butter", 3, 5), step("Butter", 3, 5), step("Butter", 3, 5)] };
  const right = { id: created.id, expectedVersion: 1, name: `Right ${repeat}`, steps: [step("Egg", 1, 1)] };
  // Hold the recipe row so both saves are admitted and blocked before either can lock it.
  const lock = await fixture!.sql.reserve();
  let results: PromiseSettledResult<unknown>[];
  try {
    await lock.unsafe("BEGIN");
    await lock.unsafe("SELECT id FROM recipes WHERE id=$1 FOR UPDATE", [created.id]);
    const contest = Promise.allSettled([app.mutate("recipe.update", left), app.mutate("recipe.update", right)]);
    try {
      const deadline = Date.now() + 4000;
      for (;;) {
        const [row] = await fixture!.sql.unsafe("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
        if (row?.waiting >= 2) break;
        if (Date.now() > deadline) throw new Error("Both saves did not reach the held recipe lock");
        await Bun.sleep(20);
      }
    } finally { await lock.unsafe("ROLLBACK"); }
    results = await contest;
  } finally { lock.release(); }
  const winners = results.filter(result => result.status === "fulfilled");
  expect(winners).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
  const winner = (winners[0] as PromiseFulfilledResult<unknown>).value as Recipe;
  expect(winner.version).toBe(2);
  expect([`Left ${repeat}`, `Right ${repeat}`]).toContain(winner.name);
  expect(await stored(created.id)).toEqual(winner);
}, 60_000);

test("current recipe steps restrict ingredient deletion until the recipe stops referencing it", async () => {
  const yeast = await app.mutate("ingredient.create", { name: "Yeast" }) as Ingredient;
  ingredients.Yeast = yeast;
  const created = await app.mutate("recipe.create", { name: "Bread", steps: [step("Yeast", 3, 12), step("Flour", 3, 5)] }) as Recipe;
  await expect(app.mutate("ingredient.delete", { id: yeast.id, expectedVersion: yeast.version })).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect((await app.query("ingredient.list", {}) as Ingredient[]).some(item => item.id === yeast.id)).toBe(true);
  expect(await stored(created.id)).toEqual(created);
  await app.mutate("recipe.update", { id: created.id, expectedVersion: 1, name: "Flatbread", steps: [step("Flour", 3, 5)] });
  expect(await app.mutate("ingredient.delete", { id: yeast.id, expectedVersion: yeast.version })).toEqual({ deleted: true });
}, 60_000);

test("a delete committed between the listing's header and step reads omits that recipe instead of failing the list", async () => {
  // "!" sorts before every other fixture name, so both recipes are on the first page.
  const doomed = await app.mutate("recipe.create", { name: "!doomed", steps: [step("Sugar", 1, 1)] }) as Recipe;
  const kept = await app.mutate("recipe.create", { name: "!kept", steps: [step("Flour", 2, 2)] }) as Recipe;
  // REINDEX holds the step table's primary-key index exclusively. Planning any statement that
  // reads the table opens its indexes, so the list's step read waits; the schema drift check and
  // the header read do not open it and proceed. The delete commits before the step read starts.
  const lock = await fixture!.sql.reserve();
  let reading: Promise<unknown> | undefined;
  try {
    await lock.unsafe("BEGIN");
    const [index] = await lock.unsafe("SELECT indexrelid::regclass::text AS name FROM pg_index WHERE indrelid='recipe_steps'::regclass AND indisprimary");
    await lock.unsafe(`REINDEX INDEX "${String(index?.name).replaceAll('"', '""')}"`);
    reading = app.query("recipe.list", {});
    reading.catch(() => {}); // Observed below; keep an early failure from going unhandled.
    let committed = false;
    try {
      // The query's own five-second budget includes this wait, so the delete must follow promptly.
      const deadline = Date.now() + 4000;
      for (;;) {
        const [row] = await fixture!.sql.unsafe("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%recipe_steps%'");
        if (row?.waiting >= 1) break;
        if (Date.now() > deadline) throw new Error(`The listing's step read did not reach the held table lock: ${JSON.stringify(await fixture!.sql.unsafe("SELECT state, wait_event_type, left(query, 120) AS query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()"))}`);
        await Bun.sleep(10);
      }
      await lock.unsafe("DELETE FROM recipes WHERE id=$1", [doomed.id]);
      await lock.unsafe("COMMIT");
      committed = true;
    } finally { if (!committed) await lock.unsafe("ROLLBACK"); }
  } finally { lock.release(); }
  const listing = await reading as Listing;
  expect(listing.recipes.map(item => item.id)).not.toContain(doomed.id);
  expect(listing.recipes.find(item => item.id === kept.id)).toEqual(kept);
  expect(await stored(doomed.id)).toBeUndefined();
}, 60_000);

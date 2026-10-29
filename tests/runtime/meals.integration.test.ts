import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { ownedPostgres } from "./owned-postgres";

// Requirements: issues #32 and #102; docs/mutations.md "Recorded snapshots". Meals are dated, immutable
// snapshots: ingredient names, order, portions, counts and exact g/ml amounts are copied into meal rows, so
// later catalog or recipe changes cannot rewrite them. Every operation runs through the restricted
// application path against an owned disposable database.
interface Amount { value: string; unit: "g" | "ml" }
interface Portion { count: number; amount?: Amount }
interface MealIngredient { name: string; portions: Portion[] }
interface Meal { id: string; date: string; recipeName?: string; version: number; ingredients: MealIngredient[] }
interface Listing { meals: Meal[]; cursor?: string }
interface Ingredient { id: string; name: string; version: number }
interface Recipe { id: string; name: string; version: number }
const pageSize = 20;

let images: Awaited<ReturnType<typeof prepareNativeImages>> | undefined;
let fixture: Awaited<ReturnType<typeof ownedPostgres>> | undefined;
let app: ReadApplication;
async function pages(): Promise<Listing[]> {
  const result: Listing[] = [];
  let cursor: string | undefined;
  do {
    const page = await app.query("meal.list", cursor === undefined ? {} : { cursor }) as Listing;
    result.push(page);
    cursor = page.cursor;
    if (result.length > 100) throw new Error("History did not end within 100 pages");
  } while (cursor !== undefined);
  return result;
}
const list = async () => (await pages()).flatMap(page => page.meals);
const stored = async (id: string) => (await list()).find(item => item.id === id);
const childRows = async () => {
  const [row] = await fixture!.sql.unsafe("SELECT (SELECT count(*) FROM meal_ingredients)::int AS ingredients, (SELECT count(*) FROM meal_portions)::int AS portions");
  return row as { ingredients: number; portions: number };
};
const portion = (count: number, value?: string, unit?: "g" | "ml"): Portion => value === undefined ? { count } : { count, amount: { value, unit: unit! } };
const valid = () => ({ date: "2026-10-20", ingredients: [{ name: "Flour", portions: [portion(5, "100", "g")] }] });

beforeAll(async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/recipes", import.meta.url)));
  images = await prepareNativeImages(await compileWorker(project));
  fixture = await ownedPostgres();
  await fixture.reviewApplication(images, true);
  // Calendar dates carry no time zone: a meal's LocalDate must not shift with the database
  // session's zone. Pick one 14 hours ahead of UTC before any connection opens.
  await fixture.sql.unsafe(`ALTER DATABASE "${String((await fixture.sql.unsafe("SELECT current_database() AS name"))[0].name).replaceAll('"', '""')}" SET timezone TO 'Pacific/Kiritimati'`);
  app = await ReadApplication.open(images, fixture.url);
  // Competing saves need two retained slots. Create the second before any race so cold
  // slot creation cannot consume a contender's five-second deadline.
  await Promise.allSettled([app.query("meal.list", {}), app.query("meal.list", {})]);
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
  expect(failures, "Meal fixture cleanup requires inspection").toEqual([]);
}, 120_000);

test("records ordered ingredient and portion snapshots with exact amounts, normalizing zeroes without numeric conversion", async () => {
  const created = await app.mutate("meal.create", {
    date: "2026-10-28", recipeName: "  Shortbread  ",
    ingredients: [
      { name: "  Butter ", portions: [portion(5, "080.50", "g"), portion(5, "0.00", "ml"), portion(8)] },
      { name: "Flour", portions: [portion(3, "100", "ml"), portion(3, "99999.99", "g"), portion(1, "007", "g")] },
      { name: "Butter", portions: [portion(12, "0.1", "g"), portion(12, "0.30", "ml")] },
    ],
  }) as Meal;
  // Trailing and leading zeroes are dropped textually; zero stays explicit data; units never convert.
  expect(created).toEqual({
    id: expect.any(String), date: "2026-10-28", recipeName: "Shortbread", version: 1,
    ingredients: [
      { name: "Butter", portions: [portion(5, "80.5", "g"), portion(5, "0", "ml"), portion(8)] },
      { name: "Flour", portions: [portion(3, "100", "ml"), portion(3, "99999.99", "g"), portion(1, "7", "g")] },
      { name: "Butter", portions: [portion(12, "0.1", "g"), portion(12, "0.3", "ml")] },
    ],
  });
  expect(await stored(created.id)).toEqual(created);
  // Meals may omit a source recipe and record ingredients outside the catalog.
  const freeform = await app.mutate("meal.create", { date: "2026-10-27", ingredients: [{ name: "Sea salt", portions: [portion(1)] }] }) as Meal;
  expect(freeform).toEqual({ id: expect.any(String), date: "2026-10-27", version: 1, ingredients: [{ name: "Sea salt", portions: [portion(1)] }] });
  expect(Object.hasOwn(freeform, "recipeName")).toBe(false);
  expect(await stored(freeform.id)).toEqual(freeform);
}, 60_000);

test("LocalDate values round-trip unchanged under a database time zone far from UTC", async () => {
  const [setting] = await fixture!.sql.unsafe("SELECT array_to_string(setconfig, ',') AS config FROM pg_db_role_setting JOIN pg_database ON pg_database.oid=setdatabase WHERE datname=current_database() AND setrole=0");
  expect(setting?.config).toBe("TimeZone=Pacific/Kiritimati");
  for (const date of ["2024-02-29", "2026-12-31", "2027-01-01", "0001-01-01", "9999-12-31"]) {
    const created = await app.mutate("meal.create", { date, ingredients: [{ name: "Sugar", portions: [portion(1)] }] }) as Meal;
    expect(created.date).toBe(date);
    expect((await stored(created.id))?.date).toBe(date);
  }
}, 60_000);

test("history lists newest dates first and reads ingredients and portions in position order regardless of insertion order or row identity", async () => {
  const id = randomUUID();
  await fixture!.sql.unsafe("INSERT INTO meals(id,date) VALUES($1,'9999-12-30')", [id]);
  // Ingredients inserted 1, 2, 0 and portions inserted 2, 0, 1, each with identities in the opposite order.
  const ingredientRows = [["bbbbbbbb-0000-4000-8000-000000000001", 1, "Sugar"], ["aaaaaaaa-0000-4000-8000-000000000001", 2, "Flour"], ["cccccccc-0000-4000-8000-000000000001", 0, "Egg"]] as const;
  for (const [ingredientId, position, name] of ingredientRows) {
    await fixture!.sql.unsafe('INSERT INTO meal_ingredients(id,"mealId",position,name) VALUES($1,$2,$3,$4)', [ingredientId, id, position, name]);
    for (const [portionId, portionPosition] of [["aaaaaaaa", 2], ["cccccccc", 0], ["bbbbbbbb", 1]] as const)
      await fixture!.sql.unsafe('INSERT INTO meal_portions(id,"mealIngredientId",position,count) VALUES($1,$2,$3,$4)', [`${portionId}-${String(position + 1).padStart(4, "0")}-4000-8000-000000000002`, ingredientId, portionPosition, portionPosition + 1]);
  }
  const all = await list();
  expect(all.find(item => item.id === id)?.ingredients).toEqual(["Egg", "Sugar", "Flour"].map(name => ({ name, portions: [portion(1), portion(2), portion(3)] })));
  const dates = all.map(item => item.date);
  expect(dates).toEqual([...dates].sort().reverse());
}, 60_000);

test("history pages through meals whose portions exceed one bounded read, never splitting a meal", async () => {
  const ids: string[] = [];
  for (let index = 1; index <= 25; index++) {
    const id = randomUUID();
    ids.push(id);
    await fixture!.sql.unsafe("INSERT INTO meals(id,date) VALUES($1,$2)", [id, `5000-01-${String(index).padStart(2, "0")}`]);
    await fixture!.sql.unsafe('INSERT INTO meal_ingredients(id,"mealId",position,name) VALUES($1,$1,0,$2)', [id, `Bulk ${index}`]);
    await fixture!.sql.unsafe('INSERT INTO meal_portions("mealIngredientId",position,count,amount,unit) SELECT $1,position,position+1,position+0.25,\'g\' FROM generate_series(0,49) AS position', [id]);
  }
  const listed = await pages();
  expect(listed.length).toBeGreaterThanOrEqual(2);
  for (const page of listed.slice(0, -1)) expect(page).toMatchObject({ meals: { length: pageSize }, cursor: expect.any(String) });
  expect(listed.at(-1)!.cursor).toBeUndefined();
  const all = listed.flatMap(page => page.meals);
  expect(new Set(all.map(item => item.id)).size).toBe(all.length);
  const bulk = all.filter(item => ids.includes(item.id));
  expect(bulk.map(item => item.date)).toEqual(Array.from({ length: 25 }, (_, index) => `5000-01-${String(25 - index).padStart(2, "0")}`));
  for (const item of bulk) expect(item.ingredients).toEqual([{ name: `Bulk ${Number(item.date.slice(-2))}`, portions: Array.from({ length: 50 }, (_, position) => portion(position + 1, `${position}.25`, "g")) }]);
}, 60_000);

test("rejects malformed dates, amounts, counts and undeclared fields on the server before any write", async () => {
  const before = await list(), rows = await childRows();
  const base = valid();
  const withPortion = (value: unknown) => ({ ...base, ingredients: [{ name: "Flour", portions: [value] }] });
  const withAmount = (amount: unknown) => withPortion({ count: 5, amount });
  const malformed: unknown[] = [
    // Dates: calendar-valid YYYY-MM-DD only; no timestamps, numbers or Date objects.
    { ...base, date: "2023-02-29" }, { ...base, date: "2026-13-01" }, { ...base, date: "2026-1-5" }, { ...base, date: "20261028" },
    { ...base, date: "2026-10-28T00:00:00Z" }, { ...base, date: "0000-01-01" }, { ...base, date: 20261028 }, { ...base, date: new Date("2026-10-28") },
    { ingredients: base.ingredients }, { ...base, date: "" },
    // Amounts: exact nonnegative decimal strings with at most two places and a g/ml unit.
    withAmount({ value: String(0.1 + 0.2), unit: "g" }), withAmount({ value: 0.3, unit: "g" }), withAmount({ value: "1.005", unit: "g" }),
    withAmount({ value: "-1", unit: "g" }), withAmount({ value: "-0", unit: "ml" }), withAmount({ value: "1e2", unit: "g" }),
    withAmount({ value: "Infinity", unit: "g" }), withAmount({ value: "NaN", unit: "g" }), withAmount({ value: ".5", unit: "g" }),
    withAmount({ value: "5.", unit: "g" }), withAmount({ value: " 5", unit: "g" }), withAmount({ value: "1,5", unit: "g" }), withAmount({ value: "+5", unit: "g" }),
    withAmount({ value: "100000", unit: "g" }), withAmount({ value: "5" }), withAmount({ unit: "g" }), withAmount({ value: "5", unit: "G" }),
    withAmount({ value: "5", unit: "kg" }), withAmount(null), withAmount("5"), withAmount({ value: "5", unit: "g", extra: true }),
    withPortion({ count: 5, amount: undefined }), withPortion({ count: 5, unit: "g" }),
    // Counts: positive safe integers.
    withPortion({ count: 0 }), withPortion({ count: -1 }), withPortion({ count: 1.5 }), withPortion({ count: "5" }),
    withPortion({ count: Number.MAX_SAFE_INTEGER + 1 }), withPortion({}), withPortion({ count: 5, note: "undeclared" }),
    // Ingredients and counts: 1–50 ingredients, 1–50 portions each and at most 50 portions per meal.
    { ...base, ingredients: [] }, { ...base, ingredients: [{ name: "Flour", portions: [] }] }, { ...base, ingredients: [{ name: "   ", portions: [portion(1)] }] },
    { ...base, ingredients: [{ name: "😀".repeat(101), portions: [portion(1)] }] }, { ...base, ingredients: [{ portions: [portion(1)] }] },
    { ...base, ingredients: [{ name: "Flour", portions: [portion(1)], ingredientId: randomUUID() }] },
    { ...base, ingredients: [{ name: "Flour", portions: Array.from({ length: 51 }, () => portion(1)) }] },
    { ...base, ingredients: Array.from({ length: 51 }, () => ({ name: "Flour", portions: [portion(1)] })) },
    { ...base, ingredients: [{ name: "Flour", portions: Array.from({ length: 26 }, () => portion(1)) }, { name: "Sugar", portions: Array.from({ length: 25 }, () => portion(1)) }] },
    // Source recipe snapshot: omitted or 1–100 code points after trimming.
    { ...base, recipeName: "  " }, { ...base, recipeName: "😀".repeat(101) }, { ...base, recipeName: null }, { ...base, recipeName: undefined },
    { ...base, recipeId: randomUUID() }, { ...base, extra: true },
  ];
  for (const input of malformed) await expect(app.mutate("meal.create", input), JSON.stringify(input)?.slice(0, 160)).rejects.toMatchObject({ code: "INPUT_INVALID" });
  // The widest valid meal is accepted: 50 portions split across ingredients.
  const widest = await app.mutate("meal.create", { ...base, ingredients: [{ name: "Flour", portions: Array.from({ length: 25 }, () => portion(1, "99999.99", "ml")) }, { name: "😀".repeat(100), portions: Array.from({ length: 25 }, () => portion(Number.MAX_SAFE_INTEGER)) }] }) as Meal;
  expect(widest.ingredients.flatMap(item => item.portions)).toHaveLength(50);
  await app.mutate("meal.delete", { id: widest.id, expectedVersion: 1 });
  expect(await list()).toEqual(before);
  expect(await childRows()).toEqual(rows);
}, 60_000);

test("edits and deletes advance or check one aggregate version and replace every child atomically", async () => {
  const created = await app.mutate("meal.create", { date: "2026-09-01", recipeName: "Pancakes", ingredients: [{ name: "Flour", portions: [portion(5, "100", "g"), portion(5, "100", "g")] }, { name: "Egg", portions: [portion(1, "180", "g")] }] }) as Meal;
  const before = await childRows();
  const edited = await app.mutate("meal.update", { id: created.id, expectedVersion: 1, date: "2026-09-02", ingredients: [{ name: "Egg", portions: [portion(1, "182.50", "g")] }, { name: "Flour", portions: [portion(5, "100", "g"), portion(4, "100", "g"), portion(3)] }] }) as Meal;
  expect(edited).toEqual({ id: created.id, date: "2026-09-02", version: 2, ingredients: [{ name: "Egg", portions: [portion(1, "182.5", "g")] }, { name: "Flour", portions: [portion(5, "100", "g"), portion(4, "100", "g"), portion(3)] }] });
  expect(await stored(created.id)).toEqual(edited);
  expect(await childRows()).toEqual({ ingredients: before.ingredients, portions: before.portions + 1 });
  await expect(app.mutate("meal.update", { ...valid(), id: created.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(app.mutate("meal.update", { ...valid(), id: randomUUID(), expectedVersion: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // Server-side rejections name the offending field by its path in the input.
  const rejected = (ingredients: unknown[], extra: object = {}) => app.mutate("meal.update", { ...valid(), id: created.id, expectedVersion: 2, ingredients, ...extra });
  await expect(rejected([{ name: "Flour", portions: [portion(1)] }, { name: " ", portions: [portion(1)] }])).rejects.toMatchObject({ code: "INPUT_INVALID", details: { "ingredients.1.name": expect.any(String) } });
  await expect(rejected([{ name: "Flour", portions: [portion(1), portion(1, "100000", "g")] }])).rejects.toMatchObject({ code: "INPUT_INVALID", details: { "ingredients.0.portions.1.amount": expect.any(String) } });
  await expect(rejected(valid().ingredients, { recipeName: " " })).rejects.toMatchObject({ code: "INPUT_INVALID", details: { recipeName: expect.any(String) } });
  await expect(rejected([{ name: "Flour", portions: Array.from({ length: 26 }, () => portion(1)) }, { name: "Sugar", portions: Array.from({ length: 25 }, () => portion(1)) }])).rejects.toMatchObject({ code: "INPUT_INVALID", details: { ingredients: expect.any(String) } });
  await expect(app.mutate("meal.delete", { id: created.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await stored(created.id)).toEqual(edited);
  expect(await app.mutate("meal.delete", { id: created.id, expectedVersion: 2 })).toEqual({ deleted: true });
  expect(await stored(created.id)).toBeUndefined();
  expect(await childRows()).toEqual({ ingredients: before.ingredients - 2, portions: before.portions - 3 });
  await expect(app.mutate("meal.delete", { id: created.id, expectedVersion: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(app.mutate("meal.update", { ...valid(), id: created.id, expectedVersion: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
}, 60_000);

test("child and output failures roll back the header and every child write", async () => {
  const created = await app.mutate("meal.create", { date: "2026-08-01", ingredients: [{ name: "Sugar", portions: [portion(8, "60", "g")] }] }) as Meal;
  const before = await list(), rows = await childRows();
  const change = { id: created.id, expectedVersion: 1, date: "2026-08-02", recipeName: "Changed", ingredients: [{ name: "Flour", portions: [portion(5, "1", "ml"), portion(5, "2", "ml")] }, { name: "Butter", portions: [portion(1)] }] };
  await expect(app.mutate("meal.rejectChild", change)).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect(await list()).toEqual(before);
  expect(await childRows()).toEqual(rows);
  await expect(app.mutate("meal.rejectOutput", change)).rejects.toThrow("INTERNAL_FAILURE");
  expect(await list()).toEqual(before);
  expect(await childRows()).toEqual(rows);
  expect(await stored(created.id)).toEqual(created);
}, 60_000);

/** Holds the meal row so both operations are admitted and blocked before either can lock it. */
async function contest(id: string, left: () => Promise<unknown>, right: () => Promise<unknown>) {
  const lock = await fixture!.sql.reserve();
  try {
    await lock.unsafe("BEGIN");
    await lock.unsafe("SELECT id FROM meals WHERE id=$1 FOR UPDATE", [id]);
    const results = Promise.allSettled([left(), right()]);
    try {
      const deadline = Date.now() + 4000;
      for (;;) {
        const [row] = await fixture!.sql.unsafe("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
        if (row?.waiting >= 2) break;
        if (Date.now() > deadline) throw new Error("Both operations did not reach the held meal lock");
        await Bun.sleep(20);
      }
    } finally { await lock.unsafe("ROLLBACK"); }
    return await results;
  } finally { lock.release(); }
}
for (let repeat = 1; repeat <= 2; repeat++) test(`competing writers at one expected version have one winner and never mix children, repeat ${repeat}`, async () => {
  const created = await app.mutate("meal.create", { date: "2026-07-01", ingredients: [{ name: "Flour", portions: [portion(1)] }, { name: "Sugar", portions: [portion(1)] }] }) as Meal;
  const left = { id: created.id, expectedVersion: 1, date: "2026-07-02", ingredients: [{ name: "Butter", portions: [portion(3, "50", "g"), portion(3, "50", "g"), portion(3, "50", "g")] }] };
  const right = { id: created.id, expectedVersion: 1, date: "2026-07-03", recipeName: `Right ${repeat}`, ingredients: [{ name: "Egg", portions: [portion(1, "200", "ml")] }] };
  const saves = await contest(created.id, () => app.mutate("meal.update", left), () => app.mutate("meal.update", right));
  const winners = saves.filter(result => result.status === "fulfilled");
  expect(winners).toHaveLength(1);
  expect(saves.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
  const winner = (winners[0] as PromiseFulfilledResult<unknown>).value as Meal;
  expect(winner.version).toBe(2);
  expect(["2026-07-02", "2026-07-03"]).toContain(winner.date);
  expect(await stored(created.id)).toEqual(winner);

  // An edit and a delete at the same version: the loser reports the typed failure the winner caused.
  const races = await contest(created.id, () => app.mutate("meal.update", { ...left, expectedVersion: 2 }), () => app.mutate("meal.delete", { id: created.id, expectedVersion: 2 }));
  expect(races.filter(result => result.status === "fulfilled")).toHaveLength(1);
  if (races[0]!.status === "fulfilled") {
    expect(races[1]).toMatchObject({ status: "rejected", reason: { code: "VERSION_CONFLICT" } });
    expect(await stored(created.id)).toEqual(races[0].value as Meal);
  } else {
    expect(races[0]).toMatchObject({ status: "rejected", reason: { code: "NOT_FOUND" } });
    expect(await stored(created.id)).toBeUndefined();
  }
}, 60_000);

test("later ingredient and recipe edits or deletion leave recorded meals unchanged", async () => {
  const yeast = await app.mutate("ingredient.create", { name: "Yeast" }) as Ingredient;
  const flour = await app.mutate("ingredient.create", { name: "Rye flour" }) as Ingredient;
  const recipe = await app.mutate("recipe.create", { name: "Rye bread", steps: [{ ingredientId: yeast.id, targetPortions: 2, targetCount: 12 }, { ingredientId: flour.id, targetPortions: 1, targetCount: 5 }] }) as Recipe;
  const recorded = await app.mutate("meal.create", { date: "2026-06-01", recipeName: "Rye bread", ingredients: [{ name: "Yeast", portions: [portion(12, "20", "g"), portion(10, "20", "g")] }, { name: "Rye flour", portions: [portion(5, "60", "g")] }] }) as Meal;
  // Edit the recipe and the catalog name, then delete both: history keeps the recorded snapshot.
  await app.mutate("recipe.update", { id: recipe.id, expectedVersion: 1, name: "Renamed", steps: [{ ingredientId: flour.id, targetPortions: 9, targetCount: 9 }] });
  await fixture!.sql.unsafe("UPDATE ingredients SET name='Dry yeast', version=version+1 WHERE id=$1", [yeast.id]);
  expect(await stored(recorded.id)).toEqual(recorded);
  await expect(app.mutate("recipe.delete", { id: recipe.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await app.mutate("recipe.delete", { id: recipe.id, expectedVersion: 2 })).toEqual({ deleted: true });
  await expect(app.mutate("recipe.delete", { id: recipe.id, expectedVersion: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const [steps] = await fixture!.sql.unsafe('SELECT count(*)::int AS count FROM recipe_steps WHERE "recipeId"=$1', [recipe.id]);
  expect(steps?.count).toBe(0);
  // Meals never restrict catalog deletion: once no recipe uses an ingredient it can go.
  expect(await app.mutate("ingredient.delete", { id: yeast.id, expectedVersion: 2 })).toEqual({ deleted: true });
  expect(await app.mutate("ingredient.delete", { id: flour.id, expectedVersion: 1 })).toEqual({ deleted: true });
  expect(await stored(recorded.id)).toEqual(recorded);
  // A recorded meal stays editable after its ingredients and recipe are gone.
  const kept = await app.mutate("meal.update", { id: recorded.id, expectedVersion: 1, date: "2026-06-01", recipeName: "Rye bread", ingredients: [...recorded.ingredients, { name: "Water", portions: [portion(1)] }] }) as Meal;
  expect(kept).toEqual({ ...recorded, version: 2, ingredients: [...recorded.ingredients, { name: "Water", portions: [portion(1)] }] });
  // Structurally, meal rows reference only their own aggregate, never the catalog or recipes.
  const references = await fixture!.sql.unsafe("SELECT conrelid::regclass::text AS source, confrelid::regclass::text AS target FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text LIKE 'meal%' ORDER BY 1");
  expect(references.map((row: { source: string; target: string }) => `${row.source}->${row.target}`)).toEqual(["meal_ingredients->meals", "meal_portions->meal_ingredients"]);
}, 60_000);

test("a delete committed between the history's header and portion reads omits that meal instead of failing the list", async () => {
  const doomed = await app.mutate("meal.create", { date: "9999-12-31", ingredients: [{ name: "Doomed", portions: [portion(1)] }] }) as Meal;
  const kept = await app.mutate("meal.create", { date: "9999-12-31", ingredients: [{ name: "Kept", portions: [portion(2)] }] }) as Meal;
  // REINDEX holds the portion table's primary-key index exclusively. Planning any statement that
  // reads the table opens its indexes, so the list's portion read waits; the schema drift check and
  // the header read do not open it and proceed. The delete commits before the portion read starts.
  const lock = await fixture!.sql.reserve();
  let reading: Promise<unknown> | undefined;
  try {
    await lock.unsafe("BEGIN");
    const [index] = await lock.unsafe("SELECT indexrelid::regclass::text AS name FROM pg_index WHERE indrelid='meal_portions'::regclass AND indisprimary");
    await lock.unsafe(`REINDEX INDEX "${String(index?.name).replaceAll('"', '""')}"`);
    reading = app.query("meal.list", {});
    reading.catch(() => {}); // Observed below; keep an early failure from going unhandled.
    let committed = false;
    try {
      // The query's own five-second budget includes this wait, so the delete must follow promptly.
      const deadline = Date.now() + 4000;
      for (;;) {
        const [row] = await fixture!.sql.unsafe("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%meal_portions%'");
        if (row?.waiting >= 1) break;
        if (Date.now() > deadline) throw new Error(`The history's portion read did not reach the held table lock: ${JSON.stringify(await fixture!.sql.unsafe("SELECT state, wait_event_type, left(query, 120) AS query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()"))}`);
        await Bun.sleep(10);
      }
      await lock.unsafe("DELETE FROM meals WHERE id=$1", [doomed.id]);
      await lock.unsafe("COMMIT");
      committed = true;
    } finally { if (!committed) await lock.unsafe("ROLLBACK"); }
  } finally { lock.release(); }
  const listing = await reading as Listing;
  expect(listing.meals.map(item => item.id)).not.toContain(doomed.id);
  expect(listing.meals.find(item => item.id === kept.id)).toEqual(kept);
  expect(await stored(doomed.id)).toBeUndefined();
}, 60_000);

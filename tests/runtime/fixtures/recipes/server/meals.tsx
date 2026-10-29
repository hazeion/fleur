import { column, defineTable, eq, inArray, type ReadDb, type WriteDb } from "fleur/database";
import { handleMutation, handleQuery, inputError, readQuery, registerPage } from "fleur/server";
import { Link } from "fleur/routing";
import { schema, type DecimalString, type Infer, type LocalDate, type UUID } from "fleur/schema";
import { listIngredients, listRecipes } from "../shared/contracts";
import { amountUnit, amountValue, createMeal, deleteMeal, listMeals, meal, mealPageSize, mealPortionLimit, normalizeDecimal, portion, rejectMealChild, rejectMealOutput, updateMeal } from "../shared/meals";
import { earlierMealsPage, mealsPage } from "../shared/pages";
import { MealEditor } from "../client/MealEditor";
import { trimmedName } from "./recipes";

// A meal is one aggregate of copied values. Its rows reference only their own parent rows,
// never ingredients or recipes, so later catalog or recipe edits and deletions cannot change it.
// The history reads newest dates first, with the primary key as Fleur's appended ascending tie-breaker.
export const meals = defineTable("meals", { columns: {
  id: column.uuid().primaryKey().generated(),
  date: column.localDate(),
  recipeName: column.string().max(100).nullable(),
}, indexes: [{ fields: [{ field: "date", direction: "desc" }, "id"] }] });
// Child reads by parent in position order and parent cascades look children up through these indexes.
export const mealIngredients = defineTable("meal_ingredients", { columns: {
  id: column.uuid().primaryKey().generated(),
  mealId: column.uuid().references(meals.id, { onDelete: "cascade" }),
  position: column.safeInteger(),
  name: column.string().max(100),
}, indexes: [{ fields: ["mealId", "position"] }] });
export const mealPortions = defineTable("meal_portions", { columns: {
  id: column.uuid().primaryKey().generated(),
  mealIngredientId: column.uuid().references(mealIngredients.id, { onDelete: "cascade" }),
  position: column.safeInteger(),
  count: column.safeInteger(),
  // Both null, or both present: the operation writes them together from one validated amount.
  amount: column.decimal({ precision: 7, scale: 2 }).nullable(),
  unit: column.string().max(2).nullable(),
}, indexes: [{ fields: ["mealIngredientId", "position"] }] });

type Meal = Infer<typeof meal>;
type Details = Infer<typeof createMeal.input>;
type Portion = Infer<typeof portion>;
interface StoredPortion { count: number; amount: DecimalString | null; unit: string | null }

/** Normalizes stored-range amounts textually; larger values are rejected rather than rounded. */
function storedAmount(value: DecimalString, field: string): DecimalString {
  const normalized = amountValue.parse(normalizeDecimal(value));
  if (normalized.split(".")[0]!.length > 5) throw inputError({ [field]: "Use an amount of at most 99999.99." });
  return normalized;
}
/** Validates and normalizes every copied value before the first write; errors name the field's input path. */
function snapshotOf(input: Details) {
  if (input.ingredients.reduce((total, item) => total + item.portions.length, 0) > mealPortionLimit) throw inputError({ ingredients: `Record at most ${mealPortionLimit} portions per meal.` });
  return {
    date: input.date,
    recipeName: input.recipeName === undefined ? null : trimmedName(input.recipeName, "recipeName"),
    ingredients: input.ingredients.map((item, index) => ({
      name: trimmedName(item.name, `ingredients.${index}.name`),
      portions: item.portions.map((part, portionIndex): StoredPortion => ({ count: part.count, amount: part.amount ? storedAmount(part.amount.value, `ingredients.${index}.portions.${portionIndex}.amount`) : null, unit: part.amount?.unit ?? null })),
    })),
  };
}
function publicPortion(row: StoredPortion): Portion {
  if (row.amount === null && row.unit === null) return { count: row.count };
  if (row.amount === null || row.unit === null) throw new Error("Stored amount and unit are incomplete");
  return { count: row.count, amount: { value: amountValue.parse(normalizeDecimal(row.amount)), unit: amountUnit.parse(row.unit) } };
}
interface Header { id: UUID; date: LocalDate; recipeName: string | null; version: number }
interface PortionRow extends StoredPortion { ingredientId: UUID; name: string }
/** Groups position-ordered portion rows into ingredients; consecutive rows of one ingredient row share its snapshot. */
function assemble(header: Header, rows: readonly PortionRow[]): Meal {
  const items: { id: UUID; name: string; portions: Portion[] }[] = [];
  for (const row of rows) {
    const current = items.at(-1);
    if (current?.id === row.ingredientId) current.portions.push(publicPortion(row));
    else items.push({ id: row.ingredientId, name: row.name, portions: [publicPortion(row)] });
  }
  return { id: header.id, date: header.date, ...(header.recipeName === null ? {} : { recipeName: header.recipeName }), version: header.version, ingredients: items.map(({ name, portions }) => ({ name, portions })) };
}
const portionFields = { ingredientId: mealIngredients.id, name: mealIngredients.name, count: mealPortions.count, amount: mealPortions.amount, unit: mealPortions.unit } as const;
/** One joined statement: a meal's header, ingredients and portions share a snapshot. */
async function readMeal(db: ReadDb, id: UUID): Promise<Meal> {
  const rows = await db.selectJoined({
    from: mealPortions,
    joins: [
      { type: "inner", table: mealIngredients, on: eq(mealPortions.mealIngredientId, mealIngredients.id) },
      { type: "inner", table: meals, on: eq(mealIngredients.mealId, meals.id) },
    ],
    fields: { id: meals.id, date: meals.date, recipeName: meals.recipeName, version: meals.version, ...portionFields },
    where: eq(meals.id, id),
    orderBy: [{ column: mealIngredients.position, direction: "asc" }, { column: mealPortions.position, direction: "asc" }],
    limit: mealPortionLimit,
  });
  if (!rows[0]) throw new Error("Saved meal is missing");
  return assemble(rows[0], rows);
}

const portionReadLimit = 500;
/** Ordered portions for one page of meals, in bounded reads of at most 500 rows. */
async function readPortions(db: ReadDb, ids: readonly UUID[]) {
  const selection = {
    from: mealPortions,
    joins: [{ type: "inner", table: mealIngredients, on: eq(mealPortions.mealIngredientId, mealIngredients.id) }] as const,
    fields: { portionId: mealPortions.id, mealId: mealIngredients.mealId, ingredientPosition: mealIngredients.position, portionPosition: mealPortions.position, ...portionFields },
    where: inArray(mealIngredients.mealId, ids),
    orderBy: [{ column: mealIngredients.mealId, direction: "asc" }, { column: mealIngredients.position, direction: "asc" }, { column: mealPortions.position, direction: "asc" }],
  } as const;
  const portions = new Map<UUID, PortionRow[]>();
  let cursor: string | undefined;
  do {
    const rows = await db.selectJoined({ ...selection, limit: portionReadLimit, ...(cursor === undefined ? {} : { cursor }) });
    for (const row of rows) portions.set(row.mealId, [...portions.get(row.mealId) ?? [], row]);
    const last = rows.length === portionReadLimit ? rows.at(-1) : undefined;
    cursor = last && db.cursorJoined({ ...selection, after: last });
  } while (cursor !== undefined);
  return portions;
}
// Headers and their portions are separate statements. A save committed between them can pair a
// header with newer portions; editing from that view then fails with VERSION_CONFLICT rather than
// overwriting, and the committed save triggers a refresh that shows the consistent result. A
// delete committed between them leaves a header without portions; omit it, since a meal needs one.
handleQuery(listMeals, async ({ input, db }) => {
  const orderBy = [{ field: "date", direction: "desc" }] as const;
  const headers = await db.select(meals, { fields: ["id", "date", "recipeName", "version"], orderBy, limit: mealPageSize + 1, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
  const page = headers.slice(0, mealPageSize), last = page.at(-1);
  const portions = page.length ? await readPortions(db, page.map(header => header.id)) : new Map<UUID, PortionRow[]>();
  return {
    meals: page.flatMap(header => { const rows = portions.get(header.id); return rows ? [assemble(header, rows)] : []; }),
    ...(headers.length > mealPageSize && last ? { cursor: db.cursor(meals, { orderBy, after: last }) } : {}),
  };
});

async function insertIngredients(db: WriteDb, mealId: UUID, items: ReturnType<typeof snapshotOf>["ingredients"]) {
  for (const [position, item] of items.entries()) {
    const { id } = await db.insert(mealIngredients, { values: { mealId, position, name: item.name }, returning: ["id"] });
    for (const [portionPosition, part] of item.portions.entries()) await db.insert(mealPortions, { values: { mealIngredientId: id, position: portionPosition, ...part }, returning: ["id"] });
  }
}
handleMutation(createMeal, async ({ input, db }) => {
  const snapshot = snapshotOf(input);
  const { id } = await db.insert(meals, { values: { date: snapshot.date, recipeName: snapshot.recipeName }, returning: ["id"] });
  await insertIngredients(db, id, snapshot.ingredients);
  return readMeal(db, id);
});
async function replaceMeal(db: WriteDb, input: Infer<typeof updateMeal.input>) {
  const snapshot = snapshotOf(input);
  // Lock and advance the aggregate version before reading or replacing children. A competing
  // save waits on this row, then fails with VERSION_CONFLICT before it touches any child.
  await db.updateVersioned(meals, { id: input.id, expectedVersion: input.expectedVersion, set: { date: snapshot.date, recipeName: snapshot.recipeName }, returning: ["id"] });
  const existing = await db.select(mealIngredients, { fields: ["id", "version"], where: eq(mealIngredients.mealId, input.id), limit: mealPortionLimit });
  // Deleting an ingredient row cascades to its portions.
  for (const item of existing) await db.deleteVersioned(mealIngredients, { id: item.id, expectedVersion: item.version });
  await insertIngredients(db, input.id, snapshot.ingredients);
  return readMeal(db, input.id);
}
handleMutation(updateMeal, async ({ input, db }) => replaceMeal(db, input));
handleMutation(deleteMeal, async ({ input, db }) => db.deleteVersioned(meals, input));
const absentIngredient = schema.uuid().parse("00000000-0000-4000-8000-000000000000");
handleMutation(rejectMealChild, async ({ input, db }) => {
  await replaceMeal(db, input);
  await db.insert(mealPortions, { values: { mealIngredientId: absentIngredient, position: 0, count: 1, amount: null, unit: null }, returning: ["id"] });
  return readMeal(db, input.id);
});
handleMutation(rejectMealOutput, async ({ input, db }) => {
  await replaceMeal(db, input);
  return "server-private-canary" as unknown as boolean;
});

const pieces = (count: number) => `${count} piece${count === 1 ? "" : "s"}`;
const describe = (part: Portion) => part.amount ? `${pieces(part.count)} @ ${part.amount.value} ${part.amount.unit}` : pieces(part.count);
async function mealsView(cursor?: string) {
  const ingredientRows = await readQuery(listIngredients, {}), recipeListing = await readQuery(listRecipes, {});
  const history = await readQuery(listMeals, cursor === undefined ? {} : { cursor });
  const catalog = ingredientRows.map(row => row.name);
  const recipes = recipeListing.recipes.map(item => ({ id: item.id, name: item.name, steps: item.steps.map(({ ingredientName, targetPortions, targetCount }) => ({ ingredientName, targetPortions, targetCount })) }));
  return <main><h1>Meals</h1>
    <MealEditor key="new" ingredients={catalog} recipes={recipes} />
    {history.cursor !== undefined && <Link to={earlierMealsPage} params={{ cursor: history.cursor }}>Earlier meals</Link>}
    {history.meals.map(stored => <article key={stored.id}>
      <h2>Meal on {stored.date}</h2>
      {stored.recipeName !== undefined && <p>From recipe {stored.recipeName}</p>}
      <p>Version {stored.version}</p>
      <ol>{stored.ingredients.map((item, index) => <li key={index}>{item.name}: {item.portions.map(describe).join(", ")}</li>)}</ol>
      <MealEditor key={stored.id} ingredients={catalog} meal={stored} />
    </article>)}
  </main>;
}
registerPage(mealsPage, { component: () => mealsView() });
registerPage(earlierMealsPage, { component: ({ params }) => mealsView(params.cursor) });

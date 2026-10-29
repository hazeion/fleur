import { column, defineTable, eq, inArray, type ReadDb, type WriteDb } from "fleur/database";
import { handleMutation, handleQuery, inputError, readQuery, registerPage } from "fleur/server";
import { Link } from "fleur/routing";
import type { Infer, UUID } from "fleur/schema";
import { createIngredient, createRecipe, deleteIngredient, deleteRecipe, listIngredients, listRecipes, recipe, recipeStep, recipeStepInput, recipeStepLimit, recipePageSize, rejectRecipeOutput, updateRecipe } from "../shared/contracts";
import { laterRecipesPage, recipesPage } from "../shared/pages";
import { RecipeEditor } from "../client/RecipeEditor";

// Indexes match the listings' name-then-id order, so a page reads in index order. The case-folded unique index
// keys on folded names and cannot serve that order.
export const ingredients = defineTable("ingredients", { columns: {
  id: column.uuid().primaryKey().generated(),
  name: column.string().max(100).unique({ caseFold: true }),
}, indexes: [{ fields: ["name", "id"] }] });
export const recipes = defineTable("recipes", { columns: {
  id: column.uuid().primaryKey().generated(),
  name: column.string().max(100),
}, indexes: [{ fields: ["name", "id"] }] });
// PostgreSQL does not index foreign keys. Step reads by recipe in position order, recipe cascades and ingredient
// restrict checks look steps up through these indexes.
export const recipeSteps = defineTable("recipe_steps", { columns: {
  id: column.uuid().primaryKey().generated(),
  recipeId: column.uuid().references(recipes.id, { onDelete: "cascade" }),
  position: column.safeInteger(),
  ingredientId: column.uuid().references(ingredients.id, { onDelete: "restrict" }),
  targetPortions: column.safeInteger(),
  targetCount: column.safeInteger(),
}, indexes: [{ fields: ["recipeId", "position"] }, { fields: ["ingredientId"] }] });

/** `field` is the input path the error names, such as `ingredients.1.name`. */
export function trimmedName(value: string, field = "name") {
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 100) throw inputError({ [field]: "Use 1–100 characters after trimming." });
  return name;
}
handleQuery(listIngredients, async ({ db }) => db.select(ingredients, { fields: ["id", "name", "version"], orderBy: [{ field: "name", direction: "asc" }] }));
handleMutation(createIngredient, async ({ input, db }) => db.insert(ingredients, { values: { name: trimmedName(input.name) }, returning: ["id", "name", "version"] }));
handleMutation(deleteIngredient, async ({ input, db }) => db.deleteVersioned(ingredients, input));

type Recipe = Infer<typeof recipe>;
/** One joined statement: a recipe's header, ordered steps and ingredient names share a snapshot. */
function readRecipeRows(db: ReadDb, id: UUID) {
  return db.selectJoined({
    from: recipeSteps,
    joins: [
      { type: "inner", table: recipes, on: eq(recipeSteps.recipeId, recipes.id) },
      { type: "inner", table: ingredients, on: eq(recipeSteps.ingredientId, ingredients.id) },
    ],
    fields: {
      id: recipes.id, name: recipes.name, version: recipes.version,
      ingredientId: recipeSteps.ingredientId, ingredientName: ingredients.name,
      targetPortions: recipeSteps.targetPortions, targetCount: recipeSteps.targetCount,
    },
    where: eq(recipes.id, id),
    orderBy: [{ column: recipeSteps.position, direction: "asc" }],
    limit: recipeStepLimit,
  });
}
async function readRecipe(db: ReadDb, id: UUID): Promise<Recipe> {
  const rows = await readRecipeRows(db, id);
  if (!rows[0]) throw new Error("Saved recipe is missing");
  return { id, name: rows[0].name, version: rows[0].version, steps: rows.map(row => ({ ingredientId: row.ingredientId, ingredientName: row.ingredientName, targetPortions: row.targetPortions, targetCount: row.targetCount })) };
}
async function insertSteps(db: WriteDb, recipeId: UUID, steps: readonly Infer<typeof recipeStepInput>[]) {
  for (const [position, step] of steps.entries()) await db.insert(recipeSteps, { values: { recipeId, position, ...step }, returning: ["id"] });
}

const stepReadLimit = 500;
/** Ordered steps for one page of recipes, in bounded reads of at most 500 rows. */
async function readSteps(db: ReadDb, ids: readonly UUID[]) {
  const selection = {
    from: recipeSteps,
    joins: [{ type: "inner", table: ingredients, on: eq(recipeSteps.ingredientId, ingredients.id) }] as const,
    fields: {
      stepId: recipeSteps.id, recipeId: recipeSteps.recipeId, position: recipeSteps.position,
      ingredientId: ingredients.id, ingredientName: ingredients.name,
      targetPortions: recipeSteps.targetPortions, targetCount: recipeSteps.targetCount,
    },
    where: inArray(recipeSteps.recipeId, ids),
    orderBy: [{ column: recipeSteps.recipeId, direction: "asc" }, { column: recipeSteps.position, direction: "asc" }],
  } as const;
  const steps = new Map<UUID, Infer<typeof recipeStep>[]>();
  let cursor: string | undefined;
  do {
    const rows = await db.selectJoined({ ...selection, limit: stepReadLimit, ...(cursor === undefined ? {} : { cursor }) });
    for (const row of rows) steps.set(row.recipeId, [...steps.get(row.recipeId) ?? [], { ingredientId: row.ingredientId, ingredientName: row.ingredientName, targetPortions: row.targetPortions, targetCount: row.targetCount }]);
    const last = rows.length === stepReadLimit ? rows.at(-1) : undefined;
    cursor = last && db.cursorJoined({ ...selection, after: last });
  } while (cursor !== undefined);
  return steps;
}
// Headers and their steps are separate statements. A save committed between them can pair a
// header with newer steps; editing from that view then fails with VERSION_CONFLICT rather than
// overwriting, and the committed save triggers a refresh that shows the consistent result. A
// delete committed between them leaves a header without steps; omit it, since a recipe needs one.
handleQuery(listRecipes, async ({ input, db }) => {
  const orderBy = [{ field: "name", direction: "asc" }] as const;
  const headers = await db.select(recipes, { fields: ["id", "name", "version"], orderBy, limit: recipePageSize + 1, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
  const page = headers.slice(0, recipePageSize), last = page.at(-1);
  const steps = page.length ? await readSteps(db, page.map(header => header.id)) : new Map<UUID, Infer<typeof recipeStep>[]>();
  return {
    recipes: page.flatMap(header => { const rows = steps.get(header.id); return rows ? [{ ...header, steps: rows }] : []; }),
    ...(headers.length > recipePageSize && last ? { cursor: db.cursor(recipes, { orderBy, after: last }) } : {}),
  };
});
handleMutation(createRecipe, async ({ input, db }) => {
  const { id } = await db.insert(recipes, { values: { name: trimmedName(input.name) }, returning: ["id"] });
  await insertSteps(db, id, input.steps);
  return readRecipe(db, id);
});
async function replaceRecipe(db: WriteDb, input: Infer<typeof updateRecipe.input>) {
  // Lock and advance the aggregate version before reading or replacing steps. A competing
  // save waits on this row, then fails with VERSION_CONFLICT before it touches any step.
  await db.updateVersioned(recipes, { id: input.id, expectedVersion: input.expectedVersion, set: { name: trimmedName(input.name) }, returning: ["id"] });
  const existing = await db.select(recipeSteps, { fields: ["id", "version"], where: eq(recipeSteps.recipeId, input.id), limit: recipeStepLimit });
  for (const step of existing) await db.deleteVersioned(recipeSteps, { id: step.id, expectedVersion: step.version });
  await insertSteps(db, input.id, input.steps);
  return readRecipe(db, input.id);
}
handleMutation(updateRecipe, async ({ input, db }) => replaceRecipe(db, input));
handleMutation(deleteRecipe, async ({ input, db }) => db.deleteVersioned(recipes, input));
handleMutation(rejectRecipeOutput, async ({ input, db }) => {
  await replaceRecipe(db, input);
  return "server-private-canary" as unknown as boolean;
});

async function recipesView(cursor?: string) {
  const ingredientRows = await readQuery(listIngredients, {}), listing = await readQuery(listRecipes, cursor === undefined ? {} : { cursor });
  return <main><h1>Recipes</h1>
    <RecipeEditor key="new" ingredients={ingredientRows} />
    {listing.cursor !== undefined && <Link to={laterRecipesPage} params={{ cursor: listing.cursor }}>Later recipes</Link>}
    {listing.recipes.map(stored => <article key={stored.id}>
      <h2>{stored.name}</h2><p>Version {stored.version}</p>
      <ol>{stored.steps.map((step, index) => <li key={index}>{step.ingredientName}: {step.targetPortions} × {step.targetCount}</li>)}</ol>
      <RecipeEditor key={stored.id} ingredients={ingredientRows} recipe={stored} />
    </article>)}
  </main>;
}
registerPage(recipesPage, { component: () => recipesView() });
registerPage(laterRecipesPage, { component: ({ params }) => recipesView(params.cursor) });

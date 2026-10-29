# Atomic mutations

Declare browser-safe contracts in `shared/`, handlers and tables in `server/`, and forms in `client/`. `defineMutation`, `handleMutation` and `useMutation` infer input and output types from the same strict schemas. Export contracts to assign stable identities; explicit names must be unique across queries and mutations.

```ts
// shared/ingredients.ts
import { defineMutation, schema } from "fleur/schema";
export const renameIngredient = defineMutation({
  name: "ingredients.rename",
  input: schema.object({
    id: schema.uuid(), expectedVersion: schema.safeInteger(), name: schema.string(),
  }),
  output: schema.object({
    id: schema.uuid(), name: schema.string().min(1).max(100), version: schema.safeInteger(),
  }),
});

// server/ingredients.ts
import { column, defineTable } from "fleur/database";
import { handleMutation, inputError } from "fleur/server";
import { renameIngredient } from "../shared/ingredients";
export const ingredients = defineTable("ingredients", { columns: {
  id: column.uuid().primaryKey().generated(),
  name: column.string().max(100).unique({ caseFold: true }),
} });
handleMutation(renameIngredient, async ({ input, db }) => {
  const name = input.name.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 100) throw inputError({ name: "Use 1–100 characters after trimming." });
  return db.updateVersioned(ingredients, {
    id: input.id, expectedVersion: input.expectedVersion, set: { name },
    returning: ["id", "name", "version"],
  });
});
```

Fleur validates input before the handler and output before commit. Every helper uses the same broker-owned Read Committed transaction. Any failed helper, handler or output validation rolls back preceding writes, even if the handler catches a failed helper. Await helpers; returning while a helper is outstanding cannot authorize commit. The five-second budget includes slot queueing, process preparation, pool queueing, worker execution and commit. The first slot's cold Docker startup precedes this budget; later on-demand slot creation consumes it. Cancellation and cleanup retain the verified read-runtime connection safeguards.

`insert(table, { values, returning })` returns the declared projection. Generated columns and the managed version cannot be supplied. Defaults may be omitted or explicitly supplied on insert. Defaulted columns remain editable. Updates cannot change primary keys, generated columns or the managed version. Versioned `updateVersioned` and `deleteVersioned` require `id` and a positive safe-integer `expectedVersion`. They lock the row and compare the version inside the owned transaction. An update increments the version. Missing records, stale versions and constraint conflicts return `NOT_FOUND`, `VERSION_CONFLICT` and `CONSTRAINT_CONFLICT`. No stronger isolation or automatic transaction retry is implied.

Explicit `versioned: false` declarations emit the warning that updates and deletes have no lost-update guarantee. Their `update(table, { id, set, returning })` and `delete(table, { id })` helpers reject versioned tables at type and runtime boundaries. Deletes return `{ deleted: true }`.

`unique()` declares ordinary database uniqueness. String `unique({ caseFold: true })` uses Unicode 17.0.0 default full case folding with C and F mappings. `caseFold` from `fleur/schema` exposes that same mapping for explicit application comparisons. PostgreSQL's immutable folding function and expression index use the pinned table, with C collation, independently of request validation. Display text retains its case. Case folding does not normalize accents or use Turkic locale rules. The table's source, checksum and license ship in `src/runtime/unicode/NOTICE.md`.

Declare non-unique indexes with the table's `indexes` option. Each index lists 1–32 of the table's own columns in order. A key is a field name, which sorts ascending, or `{ field, direction }`:

```ts
// Simplified from tests/runtime/fixtures/recipes/server/meals.tsx, which declares the same indexes.
export const meals = defineTable("meals", {
  columns: { id: column.uuid().primaryKey().generated(), date: column.localDate() },
  indexes: [{ fields: [{ field: "date", direction: "desc" }, "id"] }],
});
export const mealIngredients = defineTable("meal_ingredients", {
  columns: { id: column.uuid().primaryKey().generated(), mealId: column.uuid().references(meals.id, { onDelete: "cascade" }), position: column.safeInteger() },
  indexes: [{ fields: ["mealId", "position"] }],
});
// A newest-first history page reads in the first index's order, with no sort. Fleur appends
// the primary key in ascending order as the tie-breaker, which the index's final "id" key covers.
handleQuery(listMeals, async ({ db }) => db.select(meals, {
  fields: ["id", "date", "version"],
  orderBy: [{ field: "date", direction: "desc" }], limit: 20,
}));
```

PostgreSQL does not index foreign keys. Without an index that starts with the reference column, reading a parent's children, cascading a parent delete and checking a `restrict` reference each scan the whole child table. For an ordered list, put the equality-filtered columns first, then the `orderBy` fields with the same directions. Fleur sorts nulls last in both directions, and so do its descending index keys, so the index returns rows already in order. When `orderBy` omits the primary key, Fleur appends it in ascending order as the final tie-breaker. End the index with the primary key to cover that tie-breaker too. A table admits at most 32 indexes. Fleur rejects:

- a single ascending key on the primary key or on a plain unique column, which is already indexed. A single descending key is allowed: the existing index read backwards sorts nulls first, not last, so it cannot serve Fleur's descending order
- a repeated column within an index, or a repeated index
- the managed version column as a key

Indexes are B-tree and non-unique over whole columns. Partial, expression, covering and composite unique indexes are not available. Indexes reach the database only through reviewed migrations. Adding or removing one changes no rows and needs no approval. Drift detection compares each declared index's keys, directions and null ordering.

The trusted schema compiler produces the fixture's table constraints and index. It does not apply schema changes during application startup or introduce a migration command. Existing databases need matching schema through the later migration workflow; the internal verification fixture creates its schema only in an owned disposable database.

In an island, call `const save = useMutation(renameIngredient)` and `await save.run(input)`. State exposes `idle`, `pending`, `success`, `failure` and `outcome-unknown`, with `pending` and optional validated `data` or safe `error`. Outcomes resolve to a tagged union for ordinary operation/transport failures:

- `success` includes validated data and means the transaction committed.
- `failure` includes an error code and `delivery: "not-sent" | "submitted"`. Invalid input and offline refusal before dispatch establish not-sent. Concurrent calls while the same hook is pending return `ALREADY_PENDING` without sending.
- `outcome-unknown` means submission may have committed. A lost response, invalid response, or unacknowledged COMMIT cannot establish rollback. Refresh stored data before deciding whether to try again.

Fleur never automatically replays a mutation and does not promise exactly-once effects. A confirmed commit remains success even if later delivery fails; the disconnected client then reports unknown. Input/output, helper results and transport bodies remain bounded. Unexpected errors expose no SQL, stack or internal exception text. Keep secrets out of explicitly declared public error details.

The production browser entry captures Fleur's transport before application modules evaluate and rejects direct browser transport APIs. Application code cannot open fresh browser realms through popups, embedded documents or arbitrary HTML parsing. Build admission, server HTML validation and browser enforcement cover those paths; ordinary Preact node rendering remains supported. The internal POST adapter accepts only same-origin JSON requests with Fleur's request header, bounds request streams, and dispatches registered operations. Application code cannot register arbitrary endpoints.

`tests/runtime/fixtures/saves` demonstrates create, rename and delete with invalid-input, conflict and unknown-outcome messages. It disables a mutation after uncertainty until the page is refreshed. Browser tests lose a response after commit and reconcile through a fresh server page without replay. Separate PostgreSQL tests lose the database's COMMIT acknowledgement and verify the saved row remains present once.

## Ordered child collections

A record that owns an ordered list, such as a recipe and its steps, is one aggregate. Version the parent; its version covers the header and every child. Declare children with a parent reference and a position, and reference other records with the delete action you need:

```ts
// server/recipes.tsx: imports come from fleur/database, fleur/server and the shared contracts,
// where updateRecipe outputs { id, name, version }. The fixture also returns the saved steps.
export const recipeSteps = defineTable("recipe_steps", { columns: {
  id: column.uuid().primaryKey().generated(),
  recipeId: column.uuid().references(recipes.id, { onDelete: "cascade" }),
  position: column.safeInteger(),
  ingredientId: column.uuid().references(ingredients.id, { onDelete: "restrict" }),
  targetPortions: column.safeInteger(), targetCount: column.safeInteger(),
}, indexes: [{ fields: ["recipeId", "position"] }, { fields: ["ingredientId"] }] });
handleMutation(updateRecipe, async ({ input, db }) => {
  const name = input.name.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 100) throw inputError({ name: "Use 1–100 characters after trimming." });
  // First lock and advance the aggregate version, then replace the children.
  const { version } = await db.updateVersioned(recipes, { id: input.id, expectedVersion: input.expectedVersion, set: { name }, returning: ["version"] });
  const existing = await db.select(recipeSteps, { fields: ["id", "version"], where: eq(recipeSteps.recipeId, input.id), limit: recipeStepLimit });
  for (const step of existing) await db.deleteVersioned(recipeSteps, { id: step.id, expectedVersion: step.version });
  for (const [position, step] of input.steps.entries()) await db.insert(recipeSteps, { values: { recipeId: input.id, position, ...step }, returning: ["id"] });
  return { id: input.id, name, version };
});
```

The save sends the whole ordered list with the expected parent version. Any header, child or order edit advances the parent version exactly once. Update the parent before touching children. A competing save then waits on the parent row and fails with `VERSION_CONFLICT` before it changes anything. If you replace children first, the loser instead reports `NOT_FOUND` for a child the winner removed. Await each helper in turn. A failed child write or invalid output rolls back the header and every child. `defineTable` declares no composite uniqueness or check constraints. The operation therefore enforces unique positions, by writing them from the list order, and positive targets, through its input schema; PostgreSQL does not.

Read one aggregate with one `selectJoined` statement ordered by child position, so header and children share a snapshot. Bound the child count in the input schema so that read returns the whole aggregate. A list pages its parents with a continuation cursor. It then reads their children through repeated reads of at most 500 rows, continued with `cursorJoined`. Choose a page size whose largest possible page fits the 1 MiB result limit. A list never splits an aggregate across pages. Parents and children are then separate statements: a save between them can pair a header with newer children. Editing from such a view fails with `VERSION_CONFLICT` instead of overwriting. A delete between them leaves a parent with no children: omit that parent rather than returning it, because the output schema requires at least one child and the whole list would fail. Child batches are separate statements too, so a commit between two batches can show one aggregate's children partly from before it and partly from after it. Every such commit refreshes the view.

Report input errors under the input path of the offending field, such as `name`, `ingredients.1.name` or `ingredients.0.portions.1.amount`, so a form can show the error beside that field. Pass the path to `inputError` from the handler's own validation.

Recovery:

- `VERSION_CONFLICT`: another view saved first. Nothing from the rejected save was written. Keep the draft and show the stored version, which refreshes automatically. Offer an explicit action that rebases the kept draft onto the stored version, then save again. Never move a draft's base version, or copy newer data into it, silently.
- `CONSTRAINT_CONFLICT` while saving: a referenced record, such as an ingredient, no longer exists. Nothing was written. Choose a current record.
- `CONSTRAINT_CONFLICT` while deleting a referenced record: a `restrict` reference still uses it. First remove it from every current aggregate, then delete it.
- `NOT_FOUND`: the aggregate was deleted.
- `outcome-unknown`: reload stored data before deciding whether to save again.

`tests/runtime/fixtures/recipes` demonstrates this with a catalog of ingredients and recipes of ordered steps. Ingredient names are trimmed, 1–100 code points and unique under case folding. Each recipe has a trimmed name of 1–100 code points, need not be unique, and holds 1–100 ordered steps. Steps may repeat an ingredient and have positive safe-integer target portions and counts. `recipe.delete` takes the expected version and removes every step. The listing shows 10 recipes per page with a link to later pages; its cursors last for the broker's lifetime. PostgreSQL tests cover position-ordered reads, paging past one bounded read, saves and reorders, malformed input, child and output rollback, two writers released together from a held row lock, restricted ingredient deletion, and a delete committed between the listing's header and step reads, released from a held table lock, which the listing omits. Its tables declare indexes for the name-ordered ingredient and recipe listings, step reads by recipe in position order, and the ingredient reference. A PostgreSQL test generates and applies the fixture's migration through the reviewed flow. At 500 ingredients and 100 recipes of 100 steps, it shows that step reads, recipe cascades and ingredient restrict checks use those indexes. A two-view browser test shows server content following each commit. Unsaved drafts and focus survive those refreshes. A stale draft reports a conflict without losing its edits, and is then deliberately reapplied and saved.

## Recorded snapshots

A record that must keep its history copies the values it shows instead of referencing records that can change. The fixture records meals as a three-level aggregate of meal, ingredients and portions. Its only references point to each row's own parent, with `cascade`:

```ts
// server/meals.tsx: the meal header carries the aggregate version.
export const meals = defineTable("meals", { columns: {
  id: column.uuid().primaryKey().generated(),
  date: column.localDate(),
  recipeName: column.string().max(100).nullable(),
}, indexes: [{ fields: [{ field: "date", direction: "desc" }, "id"] }] });
export const mealPortions = defineTable("meal_portions", { columns: {
  id: column.uuid().primaryKey().generated(),
  mealIngredientId: column.uuid().references(mealIngredients.id, { onDelete: "cascade" }),
  position: column.safeInteger(), count: column.safeInteger(),
  amount: column.decimal({ precision: 7, scale: 2 }).nullable(), unit: column.string().max(2).nullable(),
}, indexes: [{ fields: ["mealIngredientId", "position"] }] });
// shared/meals.ts: an amount always carries its unit, and omitting it omits both.
export const amount = schema.object({ value: schema.decimal({ maxScale: 2, nonnegative: true }), unit: schema.enum(["g", "ml"]) });
```

Each meal has a `LocalDate`, an optional source-recipe name and 1–50 ingredients of 1–50 portions each, with at most 50 portions in total, so one bounded joined read returns it whole. Ingredient and recipe names are copied as trimmed text of 1–100 code points. They are snapshot text supplied by the client, which offers catalog and recipe names; the server does not check them against the catalog, so a meal may name an ingredient the catalog never held. Renaming, editing or deleting an ingredient or recipe leaves recorded meals unchanged, and meals never restrict those deletions. A meal can still be edited after its ingredients are gone. A `LocalDate` is a calendar date in a `date` column: it has no time zone and does not shift with the server's or database's zone. Take it from the person's own calendar, for example a date input, never from a UTC instant.

Amount values are exact decimal text, never JavaScript numbers. Validation rejects `0.1 + 0.2` artefacts, exponents, signs, nonfinite text and a third decimal place instead of rounding them. The handler removes leading and trailing zeroes from the text without numeric conversion, so `080.50` becomes `80.5` and `0.00` remains an explicit `0`. It rejects values above the column's 99999.99 with `INPUT_INVALID`. Units never convert. PostgreSQL does not enforce that amount and unit are both present or both absent: the operation writes them together from one validated amount.

Meal saves and deletes follow the ordered-collection rules above, with the same recovery. An update replaces the date, recipe name and every ingredient and portion under one expected version. A delete takes the same version and removes every child. When an edit and a delete compete, the loser reports `VERSION_CONFLICT` if the edit won, or `NOT_FOUND` if the delete won. The history lists 20 whole meals per page, newest date first, and reads their portions in bounded batches of 500 rows. Its tables index the history order and each child table's parent reference in position order. A new meal can start from a recipe on the first listing page: its steps become that many portions of the target count, which the person can then change. PostgreSQL tests cover exact and normalized amounts, dates under a database time zone 14 hours ahead of UTC, position-ordered reads, paging, malformed input, child and output rollback, two writers and an edit racing a delete released from a held row lock, unchanged meals after ingredient and recipe edits and deletion, input errors that name the offending field path, and a delete committed between the history's header and portion reads, which the history omits. A two-view browser test covers client- and server-side rejection with unchanged drafts, refreshes that keep drafts and focus, a conflict that is deliberately reapplied, and deletion.

Run `bun run types`, `bun run lint`, `bun run build:reference` and `bun run test`. Database/browser tests use the same owned PostgreSQL, native isolation and explicit Playwright prerequisites described in [read pages](read-pages.md). Lifecycle commands, reactive subscriptions and migrations remain later slices.

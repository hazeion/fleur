# Atomic mutations

Declare browser-safe contracts in `shared/`, handlers and tables in `server/`, and forms in `client/`. `defineMutation`, `handleMutation` and `useMutation` infer input and output types from the same strict schemas. Export contracts to assign stable identities; explicit names must be unique across queries and mutations.

```ts
// shared/exercises.ts
import { defineMutation, schema } from "fleur/schema";
export const renameExercise = defineMutation({
  name: "exercises.rename",
  input: schema.object({
    id: schema.uuid(), expectedVersion: schema.safeInteger(), name: schema.string(),
  }),
  output: schema.object({
    id: schema.uuid(), name: schema.string().min(1).max(100), version: schema.safeInteger(),
  }),
});

// server/exercises.ts
import { column, defineTable } from "fleur/database";
import { handleMutation, inputError } from "fleur/server";
import { renameExercise } from "../shared/exercises";
export const exercises = defineTable("exercises", { columns: {
  id: column.uuid().primaryKey().generated(),
  name: column.string().max(100).unique({ caseFold: true }),
} });
handleMutation(renameExercise, async ({ input, db }) => {
  const name = input.name.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 100) throw inputError({ name: "Use 1–100 characters after trimming." });
  return db.updateVersioned(exercises, {
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
export const sessions = defineTable("workout_sessions", {
  columns: { id: column.uuid().primaryKey().generated(), date: column.localDate() },
  indexes: [{ fields: [{ field: "date", direction: "desc" }, { field: "id", direction: "desc" }] }],
});
export const sets = defineTable("workout_session_sets", {
  columns: { id: column.uuid().primaryKey().generated(), sessionId: column.uuid().references(sessions.id, { onDelete: "cascade" }), position: column.safeInteger() },
  indexes: [{ fields: ["sessionId", "position"] }],
});
// A newest-first history page reads in the first index's order, with no sort.
handleQuery(listSessions, async ({ db }) => db.select(sessions, {
  fields: ["id", "date", "version"],
  orderBy: [{ field: "date", direction: "desc" }, { field: "id", direction: "desc" }], limit: 20,
}));
```

PostgreSQL does not index foreign keys. Without an index that starts with the reference column, reading a parent's children, cascading a parent delete and checking a `restrict` reference each scan the whole child table. For an ordered list, put the equality-filtered columns first, then the `orderBy` fields with the same directions. Fleur sorts nulls last in both directions, and so do its descending index keys, so the index returns rows already in order. When `orderBy` omits the primary key, Fleur appends it in ascending order as the final tie-breaker. End the index with the primary key to cover that tie-breaker too. A table admits at most 32 indexes. Fleur rejects:

- a single ascending key on the primary key or on a plain unique column, which is already indexed. A single descending key is allowed: the existing index read backwards sorts nulls first, not last, so it cannot serve Fleur's descending order
- a repeated column within an index, or a repeated index
- the managed version column as a key

Indexes are B-tree and non-unique over whole columns. Partial, expression, covering and composite unique indexes are not available. Indexes reach the database only through reviewed migrations. Adding or removing one changes no rows and needs no approval. Drift detection compares each declared index's keys, directions and null ordering.

The trusted schema compiler produces the fixture's table constraints and index. It does not apply schema changes during application startup or introduce a migration command. Existing databases need matching schema through the later migration workflow; the internal verification fixture creates its schema only in an owned disposable database.

In an island, call `const save = useMutation(renameExercise)` and `await save.run(input)`. State exposes `idle`, `pending`, `success`, `failure` and `outcome-unknown`, with `pending` and optional validated `data` or safe `error`. Outcomes resolve to a tagged union for ordinary operation/transport failures:

- `success` includes validated data and means the transaction committed.
- `failure` includes an error code and `delivery: "not-sent" | "submitted"`. Invalid input and offline refusal before dispatch establish not-sent. Concurrent calls while the same hook is pending return `ALREADY_PENDING` without sending.
- `outcome-unknown` means submission may have committed. A lost response, invalid response, or unacknowledged COMMIT cannot establish rollback. Refresh stored data before deciding whether to try again.

Fleur never automatically replays a mutation and does not promise exactly-once effects. A confirmed commit remains success even if later delivery fails; the disconnected client then reports unknown. Input/output, helper results and transport bodies remain bounded. Unexpected errors expose no SQL, stack or internal exception text. Keep secrets out of explicitly declared public error details.

The production browser entry captures Fleur's transport before application modules evaluate and rejects direct browser transport APIs. Application code cannot open fresh browser realms through popups, embedded documents or arbitrary HTML parsing. Build admission, server HTML validation and browser enforcement cover those paths; ordinary Preact node rendering remains supported. The internal POST adapter accepts only same-origin JSON requests with Fleur's request header, bounds request streams, and dispatches registered operations. Application code cannot register arbitrary endpoints.

`tests/runtime/fixtures/saves` demonstrates create, rename and delete with invalid-input, conflict and unknown-outcome messages. It disables a mutation after uncertainty until the page is refreshed. Browser tests lose a response after commit and reconcile through a fresh server page without replay. Separate PostgreSQL tests lose the database's COMMIT acknowledgement and verify the saved row remains present once.

## Ordered child collections

A record that owns an ordered list, such as a workout template and its exercise entries, is one aggregate. Version the parent; its version covers the header and every child. Declare children with a parent reference and a position, and reference other records with the delete action you need:

```ts
// server/workouts.tsx: imports come from fleur/database, fleur/server and the shared contracts,
// where updateTemplate outputs { id, name, version }. The fixture also returns the saved entries.
export const templateEntries = defineTable("workout_template_entries", { columns: {
  id: column.uuid().primaryKey().generated(),
  templateId: column.uuid().references(templates.id, { onDelete: "cascade" }),
  position: column.safeInteger(),
  exerciseId: column.uuid().references(exercises.id, { onDelete: "restrict" }),
  targetSets: column.safeInteger(), targetRepetitions: column.safeInteger(),
} });
handleMutation(updateTemplate, async ({ input, db }) => {
  const name = input.name.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 100) throw inputError({ name: "Use 1–100 characters after trimming." });
  // First lock and advance the aggregate version, then replace the children.
  const { version } = await db.updateVersioned(templates, { id: input.id, expectedVersion: input.expectedVersion, set: { name }, returning: ["version"] });
  const existing = await db.select(templateEntries, { fields: ["id", "version"], where: eq(templateEntries.templateId, input.id), limit: templateEntryLimit });
  for (const entry of existing) await db.deleteVersioned(templateEntries, { id: entry.id, expectedVersion: entry.version });
  for (const [position, entry] of input.entries.entries()) await db.insert(templateEntries, { values: { templateId: input.id, position, ...entry }, returning: ["id"] });
  return { id: input.id, name, version };
});
```

The save sends the whole ordered list with the expected parent version. Any header, child or order edit advances the parent version exactly once. Update the parent before touching children. A competing save then waits on the parent row and fails with `VERSION_CONFLICT` before it changes anything. If you replace children first, the loser instead reports `NOT_FOUND` for a child the winner removed. Await each helper in turn. A failed child write or invalid output rolls back the header and every child. `defineTable` declares no composite uniqueness or check constraints. The operation therefore enforces unique positions, by writing them from the list order, and positive targets, through its input schema; PostgreSQL does not.

Read one aggregate with one `selectJoined` statement ordered by child position, so header and children share a snapshot. Bound the child count in the input schema so that read returns the whole aggregate. A list pages its parents with a continuation cursor. It then reads their children through repeated reads of at most 500 rows, continued with `cursorJoined`. Choose a page size whose largest possible page fits the 1 MiB result limit. A list never shows a partial aggregate. Parents and children are then separate statements: a save between them can pair a header with newer children. Editing from such a view fails with `VERSION_CONFLICT` instead of overwriting, and the committed save refreshes the view.

Recovery:

- `VERSION_CONFLICT`: another view saved first. Nothing from the rejected save was written. Keep the draft and show the stored version, which refreshes automatically. Offer an explicit action that rebases the kept draft onto the stored version, then save again. Never move a draft's base version, or copy newer data into it, silently.
- `CONSTRAINT_CONFLICT` while saving: a referenced record, such as an exercise, no longer exists. Nothing was written. Choose a current record.
- `CONSTRAINT_CONFLICT` while deleting a referenced record: a `restrict` reference still uses it. First remove it from every current aggregate, then delete it.
- `NOT_FOUND`: the aggregate was deleted.
- `outcome-unknown`: reload stored data before deciding whether to save again.

`tests/runtime/fixtures/workouts` demonstrates this for workout templates. Each has a trimmed name of 1–100 code points, need not be unique, and holds 1–100 ordered entries. Entries may repeat an exercise and have positive safe-integer target sets and repetitions. The listing shows 10 templates per page with a link to later pages; its cursors last for the broker's lifetime. PostgreSQL tests cover position-ordered reads, paging past one bounded read, saves and reorders, malformed input, child and output rollback, two writers released together from a held row lock, and restricted exercise deletion. Its tables declare indexes for the name-ordered exercise and template listings, entry reads by template in position order, and the exercise reference. A PostgreSQL test generates and applies the fixture's migration through the reviewed flow. At 500 exercises and 100 templates of 100 entries, it shows that entry reads, template cascades and exercise restrict checks use those indexes. A two-view browser test shows server content following each commit. Unsaved drafts and focus survive those refreshes. A stale draft reports a conflict without losing its edits, and is then deliberately reapplied and saved.

Run `bun run types`, `bun run lint`, `bun run build:reference` and `bun run test`. Database/browser tests use the same owned PostgreSQL, native isolation and explicit Playwright prerequisites described in [read pages](read-pages.md). Lifecycle commands, reactive subscriptions, migrations and the full workout proof remain later slices.

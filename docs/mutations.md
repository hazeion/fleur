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

`tests/runtime/fixtures/workouts` demonstrates this for workout templates. Each has a trimmed name of 1–100 code points, need not be unique, and holds 1–100 ordered entries. Entries may repeat an exercise and have positive safe-integer target sets and repetitions. The listing shows 10 templates per page with a link to later pages; its cursors last for the broker's lifetime. PostgreSQL tests cover position-ordered reads, paging past one bounded read, saves and reorders, malformed input, child and output rollback, two writers released together from a held row lock, and restricted exercise deletion. A two-view browser test shows server content following each commit. Unsaved drafts and focus survive those refreshes. A stale draft reports a conflict without losing its edits, and is then deliberately reapplied and saved.

## Recorded snapshots

A record that must keep its history copies the values it shows instead of referencing records that can change. The fixture records workout sessions as a three-level aggregate of session, exercises and sets. Its only references point to each row's own parent, with `cascade`:

```ts
// server/sessions.tsx: the session header carries the aggregate version.
export const sessions = defineTable("workout_sessions", { columns: {
  id: column.uuid().primaryKey().generated(),
  date: column.localDate(),
  templateName: column.string().max(100).nullable(),
} });
export const sessionSets = defineTable("workout_session_sets", { columns: {
  id: column.uuid().primaryKey().generated(),
  sessionExerciseId: column.uuid().references(sessionExercises.id, { onDelete: "cascade" }),
  position: column.safeInteger(), repetitions: column.safeInteger(),
  weight: column.decimal({ precision: 7, scale: 2 }).nullable(), unit: column.string().max(2).nullable(),
} });
// shared/sessions.ts: a weight always carries its unit, and omitting it omits both.
export const weight = schema.object({ value: schema.decimal({ maxScale: 2, nonnegative: true }), unit: schema.enum(["kg", "lb"]) });
```

Each session has a `LocalDate`, an optional source-template name and 1–50 exercises of 1–50 sets each, with at most 50 sets in total, so one bounded joined read returns it whole. Exercise and template names are copied as trimmed text of 1–100 code points. Renaming, editing or deleting an exercise or template, including through `template.delete`, leaves recorded sessions unchanged, and sessions never restrict those deletions. A session can still be edited after its exercises are gone. A `LocalDate` is a calendar date in a `date` column: it has no time zone and does not shift with the server's or database's zone. Take it from the person's own calendar, for example a date input, never from a UTC instant.

Weight values are exact decimal text, never JavaScript numbers. Validation rejects `0.1 + 0.2` artefacts, exponents, signs, nonfinite text and a third decimal place instead of rounding them. The handler removes leading and trailing zeroes from the text without numeric conversion, so `080.50` becomes `80.5` and `0.00` remains an explicit `0`. It rejects values above the column's 99999.99 with `INPUT_INVALID`. Units never convert. PostgreSQL does not enforce that weight and unit are both present or both absent: the operation writes them together from one validated weight.

Session saves and deletes follow the ordered-collection rules above, with the same recovery. An update replaces the date, template name and every exercise and set under one expected version. A delete takes the same version and removes every child. When an edit and a delete compete, the loser reports `VERSION_CONFLICT` if the edit won, or `NOT_FOUND` if the delete won. The history lists 20 whole sessions per page, newest date first, and reads their sets in bounded batches of 500 rows. A new session can start from a template on the first listing page: its entries become that many sets of the target repetitions, which the person can then change. PostgreSQL tests cover exact and normalized weights, dates under a database time zone 14 hours ahead of UTC, position-ordered reads, paging, malformed input, child and output rollback, two writers and an edit racing a delete released from a held row lock, and unchanged sessions after exercise and template edits and deletion. A two-view browser test covers client- and server-side rejection with unchanged drafts, refreshes that keep drafts and focus, a conflict that is deliberately reapplied, and deletion.

Run `bun run types`, `bun run lint`, `bun run build:reference` and `bun run test`. Database/browser tests use the same owned PostgreSQL, native isolation and explicit Playwright prerequisites described in [read pages](read-pages.md). Lifecycle commands, reactive subscriptions, migrations and the full workout proof remain later slices.

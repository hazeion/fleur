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

Fleur validates input before the handler and output before commit. Every helper uses the same broker-owned Read Committed transaction. Any failed helper, handler or output validation rolls back preceding writes, even if the handler catches a failed helper. Await helpers; returning while a helper is outstanding cannot authorize commit. The five-second database budget includes pool queueing, worker execution and commit. Cold Docker startup precedes this budget. Cancellation and cleanup retain the verified read-runtime connection safeguards.

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

Run `bun run types`, `bun run lint`, `bun run build:reference` and `bun run test`. Database/browser tests use the same owned PostgreSQL, native isolation and explicit Playwright prerequisites described in [read pages](read-pages.md). Lifecycle commands, reactive subscriptions, migrations and the full workout proof remain later slices.

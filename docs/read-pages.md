# Read pages and islands

The read slice exposes `fleur/schema`, `fleur/database`, `fleur/server`,
`fleur/client` and `fleur/routing`. The generated declaration reference is shipped
under `dist/reference/`; regenerate it with `bun run build:reference`. The
compiler fixtures in `tests/runtime/contracts.types.ts` cover inferred inputs,
outputs, rows, inserts, filters, joins, relation references, routes and island
props, including rejected examples.

Put browser-safe schemas and page contracts in `shared/`, table and handler
registrations in `server/`, and interactive Preact islands in `client/`. Export
contracts and islands so registration can assign stable identities. Explicit
query names are optional but must be unique. Application imports are limited to
the Fleur entry points and approved Preact entry points. Client/shared modules
cannot import server modules, `fleur/server` or `fleur/database`.

```ts
// shared/ingredients.ts
import { defineQuery, schema } from "fleur/schema";
export const listIngredients = defineQuery({
  name: "ingredients.list",
  input: schema.object({}),
  output: schema.array(schema.object({ id: schema.uuid(), name: schema.string() })),
});

// server/ingredients.ts
import { column, defineTable } from "fleur/database";
import { handleQuery } from "fleur/server";
import { listIngredients } from "../shared/ingredients";
export const ingredients = defineTable("ingredients", { columns: {
  id: column.uuid().primaryKey(), name: column.string().max(100),
} });
handleQuery(listIngredients, async ({ db }) => db.select(ingredients, {
  fields: ["id", "name"], orderBy: [{ field: "name", direction: "asc" }],
}));
```

`tests/runtime/fixtures/ingredients` is the complete list/detail page and counter
island example. `registerPage` infers route parameters; `readQuery` is available
only inside the server render. `defineIsland` validates props during server
rendering and again before hydration. Direct navigation produces server HTML;
the browser attaches interaction only to exported, validated island boundaries. Nested islands remain in their outer island's component tree, validate their own props, and hydrate once with that parent. `Link` and
`navigate` validate and encode route parameters. Invalid routes return safe
errors without internal exception text.

Schemas are strict JSON contracts. Optional fields permit omission, nullable
fields permit null, and explicit undefined is rejected. Dates, UTC timestamps,
UUIDs and decimal strings have distinct inferred types. String limits count
Unicode code points. Unexpected output becomes an internal failure;
`inputError` and `publicError` carry bounded declared details. Do not put secrets,
SQL or stacks in those details.

Read handlers receive `select`, `selectJoined`, `cursor` and `cursorJoined`.
They receive no writes, transactions, raw SQL, connections or render dispatch.
Each select uses one PostgreSQL statement under Read Committed. Separate reads
may see newer committed data. Results default to 100 rows, permit at most 500,
and fail if encoded public JSON exceeds 1 MiB. The five-second database budget
includes slot queueing, process preparation and pool queueing; the first slot's cold Docker startup precedes that budget, while later on-demand slot creation consumes it. Cancellation
starts at expiry, and cleanup verifies transaction state before reusing a
connection. If cleanup and backend termination cannot be confirmed, the reserved
connection is closed and discarded; it is never returned for reuse.

For pagination, declare a root `cursor: schema.string().optional()` input. This
field is reserved for continuation. Return a token from
`db.cursor(table, { orderBy, where, after: lastRow })`, then pass it as
`db.select(table, { fields, orderBy, where, limit, cursor: input.cursor })`
when present. Tokens bind the query identity, every other validated input,
filters and ordering. Nested fields named cursor remain ordinary bound inputs.
Stable ordering adds each table's primary key; joined pagination includes the
joined keys, including null for unmatched left joins. `cursorJoined` takes the
same joined selection plus `after`, whose projection must include its ordering
keys. Tokens are encrypted, versioned, and local to the broker lifetime.

Application code is bundled from an admitted source snapshot and evaluated only
after native restrictions cover every worker thread. The worker receives no
host filesystem, credentials or network access. A separate trusted broker owns
PostgreSQL access. An independent guard enforces worker deadlines even if the
controller disappears. Recovery journals bind immutable resource identities and
the original local Docker endpoint; unknown ownership fails closed. If a controller disappears while a create request may still be pending, an absent name preserves the journal and reports recovery required. Test fixtures dispose their owned image tags after worker retirement; image cleanup refuses changed ownership or live container references.

The internal renderer has a separate five-second wall-clock guard. Nested query
worker startup and cleanup consume that render allowance, so a slow or overloaded
host can return a timeout even when its database work is fast. This slice does
not establish the full application's reference performance targets. This slice's
verification runs sequentially to avoid unrelated builds or installs, following
the specification's requirement to exclude unrelated heavy work.

The [development lifecycle](development.md) supplies `dev`, `stop`, `status`
and bounded `logs` through the shared restricted runtime. Its startup initializer
applies the reviewed chain and seeds only to a provably new binding, never on
reload or for an existing/adopted database. Production `build`/`start` remain
separate work. Creating a project does not start an app. Source admission and
the Fleur-owned Tailwind compiler enforce the approved styling policy. [Atomic mutations](mutations.md) supply
validated writes and client mutation outcomes. [Reactive views](reactivity.md)
refresh server regions and island queries after managed commits while preserving
keyed local state.

Run `bun run types`, `bun run lint`, `bun run build:reference`, and `bun run test`.
Tests require local Docker and create uniquely owned disposable PostgreSQL
containers. Browser verification explicitly requires Playwright's Chromium and
its browser-driver runtime; CI installs these before tests. Install them
explicitly with `bun node_modules/@playwright/test/cli.js install chromium` when
needed. Ordinary application execution uses Bun; it does not install a browser
or Node. Timing-sensitive checks repeat twice and CI retains existing platform
gates; ARM component checks do not establish full platform qualification.

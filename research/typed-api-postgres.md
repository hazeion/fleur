# Typed API and PostgreSQL foundations for Fleur

Research restarted on October 12, 2026 for [Research type-safe API and PostgreSQL foundations for Fleur](https://github.com/hazeion/fleur/issues/3). This is evidence for the remaining human decisions, not an approved implementation specification. It follows the [v1 scope](../docs/planning/V1-SCOPE.md) and [Wayfinder map](https://github.com/hazeion/fleur/issues/1).

## Recommendation to discuss

Use Zod for runtime schemas, tRPC's Fetch adapter and framework-independent client internally for request transport, and Drizzle with Bun SQL for PostgreSQL access. Use Drizzle Kit to generate SQL migrations that can be reviewed before application. Keep the application-facing contract in Fleur-owned APIs.

This is my provisional recommendation. These libraries cover documented validation, inference, transactions, and migration generation without requiring Fleur to invent each mechanism. Their documentation does not prove that the combined stack meets Fleur's contracts. No packages were installed, integration code written, database started, or executable compatibility tests run for this report.

## What type safety must mean

There are separate guarantees to design and verify:

- The TypeScript compiler infers request inputs, handler inputs, response types, database inserts, and query results from their definitions.
- The running server parses every untrusted request and validates every public response before serialization.
- PostgreSQL enforces constraints and commits related writes atomically.
- The browser receives only supported values and public fields. Server modules and credentials cannot enter its bundle.

One guarantee cannot substitute for the others. Zod's `parse` validates values at runtime, while `z.infer` extracts a static type. Transforms can make `z.input` and `z.output` differ, and asynchronous refinements require asynchronous parsing. Fleur therefore needs an explicit policy for transforms and async validation. [Zod basic usage](https://zod.dev/basics).

Public operation schemas should describe public data rather than automatically exposing entire database rows. The proof application needs domain constraints such as valid repetitions and ordered exercises in addition to storage types. PostgreSQL supports check, not-null, unique, primary-key, and foreign-key constraints; violations raise errors even for writes outside Fleur's API. [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html).

## Runtime validation and transport

| Candidate | Documented capability | Consequence for Fleur |
| --- | --- | --- |
| Zod | Parsing with validation errors, inferred types, distinct transform input/output types | Suitable schema engine. Decide whether Fleur exposes Zod directly, wraps a supported subset, or accepts an adapter contract. |
| tRPC internally | Input and output validators; inferred procedure contracts | Requires Fleur to make validators mandatory. Automatic return-type inference alone does not satisfy runtime output validation. |
| Fleur transport built directly on Fetch | Fleur would own dispatch, validation, serialization, errors, cancellation, and the client | Offers full control, but adds contract and maintenance work. There is no existing Fleur implementation to compare. |

tRPC procedures explicitly attach `.input()` and `.output()` validators. Its documented output-validation failure returns an internal server error. That establishes a useful mechanism, while Fleur still needs its own stable error vocabulary and redaction policy. [tRPC validators](https://trpc.io/docs/server/validators).

tRPC documents a Fetch adapter built around standard Request/Response APIs and a client that works without a UI framework. This permits a design in which Fleur's Preact bindings call an internal client without adopting React-specific hooks. It is a compatibility inference, not a tested Fleur integration. [Fetch adapter](https://trpc.io/docs/server/adapters/fetch), [framework-independent client](https://trpc.io/docs/client/vanilla).

Preact's official setup supports Vite through its preset. That does not establish compatibility with every React integration package. Start with the framework-independent client and define Fleur's hooks separately. [Preact setup](https://preactjs.com/guide/v10/getting-started/).

Prefer an explicitly limited wire format initially. Human decisions must settle date-only workout dates, timestamps, optional versus null fields, numeric precision, large integers, unknown fields, and transform behavior. Do not approve a serializer merely because a TypeScript return type compiles.

## PostgreSQL choices

| Candidate | Evidence | Tradeoff for Fleur |
| --- | --- | --- |
| Drizzle with Bun SQL | Official Bun SQL connection guide; TypeScript table models; inferred insert/select types; SQL migration generation | Best documented match for schema-first inference. Fleur must decide how much of the query/schema API applications may use. |
| Kysely with a supported PostgreSQL driver | Typed query builder; table interfaces; migration runner | Good alternative if explicit SQL-oriented queries matter more than deriving types from table declarations. Requires a separate schema-to-type strategy or maintained interfaces. |
| Bun SQL alone | Built-in PostgreSQL client, parameterized templates, pool, transaction callbacks | Small driver choice, but the reviewed docs do not establish schema-derived query inference or a migration generator. Fleur would need those mechanisms separately. |

Drizzle documents connecting through `drizzle-orm/bun-sql`, and deriving select and insert types from table declarations. This supports choosing Bun SQL as the driver behind a higher-level schema library. Pin exact compatible versions before any prototype. [Bun SQL connection](https://orm.drizzle.team/docs/connect-bun-sql), [Drizzle type helpers](https://orm.drizzle.team/docs/goodies).

Drizzle's `sql<T>` is explicitly a compile-time helper with no runtime mapping. Parameterized templates separate values from SQL, while `sql.raw` bypasses that processing. Fleur should decide whether application APIs permit raw expressions and require public output validation regardless. [Drizzle SQL](https://orm.drizzle.team/docs/sql).

Kysely explicitly leaves runtime data types to its driver; declaring a column type does not convert or validate returned values. Its documentation points to separate type generators. This makes it a viable query builder, but not a complete schema-validation foundation by itself. [Kysely data types](https://kysely.dev/docs/recipes/data-types).

Bun SQL documents parameterized tagged queries, pooling, and transaction callbacks. For PostgreSQL, `begin` reserves a connection; errors roll back and successful callbacks commit. It also documents savepoints. Use the transaction handle for every participating query. [Bun SQL](https://bun.sh/docs/runtime/sql).

Drizzle documents transaction callbacks, nested savepoints, and PostgreSQL isolation configuration. The generic transaction documentation is not proof that every driver/version combination supports every option identically. Verify the selected Bun SQL adapter against the exact contract. [Drizzle transactions](https://orm.drizzle.team/docs/transactions).

Atomic multi-row saves do not decide concurrent-update semantics. PostgreSQL defaults to Read Committed, and stronger isolation can require retrying complete transactions after serialization failures. Fleur must choose lost-update detection, retry ownership, and the behavior of a disconnected client whose save may have committed. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

## Reviewable migrations

Drizzle distinguishes direct schema push from generated SQL migration workflows. Prefer a proposed sequence of generate, inspect, commit, and explicitly apply. Direct push bypasses the tracked migration artifact Fleur needs for review. [Drizzle migration workflows](https://orm.drizzle.team/docs/migrations), [Drizzle Kit generate](https://orm.drizzle.team/docs/drizzle-kit-generate).

Generated SQL is review material, not evidence that a change preserves data. Resolve rename handling, destructive-change approval, backfills, history modification detection, concurrent migration runners, crash recovery, and operations that cannot run in a normal transaction. Inspect the pinned runner implementation before promising any of these guarantees.

Kysely's migration documentation explicitly describes database-level locking and serialized concurrent runs, with locks released after a crash or connection failure. That is evidence in its favor if migration concurrency becomes decisive. It still needs a Fleur command contract and recovery tests. [Kysely migrations](https://kysely.dev/docs/migrations).

## Application imports and server boundaries

The recommendation concerns Fleur's internal dependencies. It does not approve direct application imports of tRPC, Drizzle, Bun SQL, or a new schema package. Human decision tickets must define supported Fleur client, server, schema, and database entry points, and decide whether any underlying library is an approved dependency.

Shared modules should contain browser-safe contracts. Browser imports must not execute server registrations or database initialization. Type-only references can supply inference, but Fleur also needs enforced import restrictions and bundle inspection.

Vite exposes prefixed environment variables to browser code and warns that their values enter the built source. It also documents Bun's automatic environment loading interacting with Vite's precedence. Prefix conventions alone cannot enforce a server-only module boundary. Keep database credentials server-side and test development and production bundle behavior. [Vite environment variables](https://vite.dev/guide/env-and-mode).

## Evidence gaps and next decision work

These are proposed checks for the verification and contract decisions, not tests performed during research:

1. Select and pin Bun, PostgreSQL, Vite, Preact, Zod, tRPC, Drizzle ORM, and Drizzle Kit versions. Record the supported combination rather than assuming current docs describe all releases.
2. Compare small API sketches behind Fleur imports. Test inference for transformed inputs, nullable joins, optional insert defaults, and rejected client calls. Avoid installing application dependencies to demonstrate internal choices.
3. Against disposable PostgreSQL, exercise invalid request rejection, invalid public output, numeric/date mapping, rollback after an intermediate write, concurrent saves, and connection failure during a transaction.
4. Verify generated migration review, empty-database replay, upgrade with existing data, interrupted application, competing runners, and destructive-change handling.
5. Build a Preact/Vite browser client and Bun server using the proposed internal transport. Check actual browser behavior and inspect the production bundle for server code and credentials.
6. Resolve reactive query semantics separately. Request transport and database transactions do not specify invalidation scope, post-commit publication, ordering, reconnect catch-up, or stale query responses.

The next discussion should settle the public API and wire contract before choosing internal transport details. Database syntax, migrations, concurrency, and reactive behavior still require their own explicit decisions. This report can complete the evidence-gathering ticket without resolving those human tickets.

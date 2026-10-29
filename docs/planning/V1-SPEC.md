# Fleur v1 specification

Approved after live human review under [Assemble and review the build-ready Fleur v1 specification](https://github.com/hazeion/fleur/issues/12). This specification defines Fleur's first implementation and its acceptance gates. Approval does not authorize implementation, claim that a runtime exists, or report unexecuted compatibility checks as passes. The mandatory initial compatibility gate must pass before dependent implementation proceeds.

## Product and scope

Fleur prepares a predictable environment for an existing coding agent to build a small full-stack browser application. Fleur owns application contracts, validation, browser routing, database authority, reactive delivery, prerequisite setup, lifecycle and verification commands. It never launches or manages coding agents.

Use TypeScript, Bun, Preact, Vite, Tailwind and PostgreSQL. Server functions and components are the default; explicitly admitted client islands handle interaction, browser APIs and local state. Docker manages development PostgreSQL and restricted application execution. Production uses the same execution boundary against separately configured PostgreSQL; it does not provision a production database container.

Authentication, hosted deployment, Windows, arbitrary application packages, application-authored stylesheets, external writes/payments/email, agent orchestration and workout coaching/social/analytics features are outside v1. Approved external data retrieval and CDN presentation assets are in scope.

## Decision authority

The agreed scope and linked resolution comments are authoritative. This specification supplies technical detail without changing their observable behavior. The following later agreements explicitly revise earlier ones:

- [Application surface](https://github.com/hazeion/fleur/issues/6#issuecomment-6140495358) replaces the blanket server network ban and client-only page assumption in [application contracts](https://github.com/hazeion/fleur/issues/4#issuecomment-6138339319).
- [Rendering and runtime boundary](https://github.com/hazeion/fleur/issues/21#issuecomment-6142339814) retains Bun/Preact, adds production Docker isolation, and defines the supported grant trust boundary. It revises the Bun-plus-PostgreSQL-only prerequisite in [lifecycle](https://github.com/hazeion/fleur/issues/9#issuecomment-6141277739).
- [Verification](https://github.com/hazeion/fleur/issues/11#issuecomment-6142000930) selects oxlint plus remaining ESLint checks and an opt-in experimental Rust compiler. [Performance](https://github.com/hazeion/fleur/issues/17#issuecomment-6142062428) supplies quantitative limits; they are chosen targets, not measured results.
- [Platform scope amendment, October 24](https://github.com/hazeion/fleur/issues/5#issuecomment-6385377944) narrows required native targets to Intel macOS, Ubuntu 24.04/26.04 amd64 and Debian 13 amd64. Apple Silicon, other ARM64 targets and Arch are deferred. Existing tests and scoped evidence remain; required-target safety and verification contracts are unchanged.

Other governing resolutions: [setup](https://github.com/hazeion/fleur/issues/5#issuecomment-6138727595), [compatibility](https://github.com/hazeion/fleur/issues/16#issuecomment-6136471253), [migrations](https://github.com/hazeion/fleur/issues/7#issuecomment-6140996588), [reactivity](https://github.com/hazeion/fleur/issues/8#issuecomment-6141104247), [commands](https://github.com/hazeion/fleur/issues/10#issuecomment-6141388129), and [documentation](https://github.com/hazeion/fleur/issues/18#issuecomment-6142126729).

## Project layout and approved imports

```text
client/                 Browser-safe interactive islands
server/                 Page components, handlers, tables and server helpers
shared/                 Browser-safe schemas and operation/page contracts
assets/                 Local presentation assets, without executable scripts
tests/                  Unit, type, database and browser fixtures
migrations/             Reviewed generated migration artifacts
seeds/                  Declarative seed data and stable ownership keys
.agents/skills/fleur-tdd/SKILL.md
AGENTS.md
CLAUDE.md
fleur.json              Fleur-owned version, tooling and public configuration
package.json            Fleur-owned dependencies
bun.lock                Fleur-owned lockfile
.fleur/                 Ignored generated/runtime state
```

Application agents edit application source, tests, presentation assets and reviewable migration/seed content through the supported workflow. They do not independently change manifests, locks, build configuration, generated styles or runtime files. Tracked configuration contains no secrets, grants, machine paths, runtime identities or personal data. User instruction content remains separate from marked generated sections.

Approved application imports are `fleur/schema`, `fleur/database`, `fleur/server`, `fleur/client`, `fleur/routing`, `preact`, `preact/hooks`, and compiler-managed Preact JSX entry points. Admit local modules only within their graph's authority. Client/shared graphs cannot reach server code or secrets. A server import of a client island is a compiled reference, not authority to expose its server dependencies. Underlying Zod, tRPC, Drizzle, Bun SQL, raw SQL, Node/Bun built-ins and arbitrary package subpaths are not application imports.

Fixed dependencies are release-owned. Additional packages are suggestions describing the need and available Fleur alternatives; project-specific approval does not install them in v1. Resolve direct/transitive imports and aliases before admission. Runtime-supplied module paths, remote/data/blob code, eval/Function, workers/subprocesses and unregistered executable assets cannot bypass the admitted graph. Statically named local lazy islands use the same graph checks and manifest registration.

## Styling and presentation assets

Use complete Tailwind utility strings, variants, arbitrary values, inline styles and inline custom properties. Selecting between complete utility strings is allowed; assembling incomplete utility fragments does not establish generated CSS. Fleur owns the default Tailwind stylesheet/theme.

Reject application CSS files/modules, style elements, stylesheet injection, external stylesheets and custom authored CSS through `@theme`, `@utility` or `@apply`. Do not impose a static-versus-dynamic inline-style distinction. Permitted inline declarations are supplied as JSX style values; serialized HTML and script injection are not alternative styling APIs.

Allow images, fonts, audio and video through local assets or HTTPS CDN presentation URLs. External fonts cannot require a provider stylesheet. Do not treat iframe documents, script-bearing embeds or active SVG documents as presentation exceptions. Resource loading must not become executable remote code. Browser application data requests use Fleur transport only; reject direct fetch/XHR/socket/beacon/worker data transport bypasses. Static admission, CSP and runtime transport controls are separate checks; CSP cannot by itself distinguish manual calls to an allowed Fleur endpoint.

## Application values and operations

Declare named queries, mutations and retrievals through mandatory input/output schemas. Infer client arguments, results, handler context and database types; do not duplicate them by hand. Use strict objects: reject undeclared fields. Validate input before invoking a handler and public output before serialization. Mutation output validation precedes commit.

Public values are validated JSON-compatible values. Optional fields travel by omission; explicit `undefined` is rejected. Nullable fields permit `null` and do not imply omission. Reject Date objects, BigInt and nonfinite numbers. Integers fit JavaScript's safe range. Exact decimals and larger integers use validated strings. `LocalDate` is a distinct calendar-valid YYYY-MM-DD string. `Timestamp` is a distinct valid UTC ISO instant. Neither is interchangeable with arbitrary strings or the other date type.

Schemas have no arbitrary transform or asynchronous callbacks. Handlers normalize inputs and perform database checks explicitly. Output schemas select public fields, never expose entire table rows implicitly. Stack traces, SQL and internal details remain server-only.

Queries are read-only at type and runtime boundaries. Preserve the agreed Read Committed isolation. A single typed database read, including joined/related values, is one SQL statement and supplies one PostgreSQL statement snapshot. A Fleur query needing mutually consistent values must express that read as one statement; multiple reads inside a handler and separate page queries do not acquire an automatic shared snapshot. Queries cannot open independent/nested transactions or obtain writable helpers. Stronger isolation is deferred rather than silently introduced.

Mutations receive one Fleur-owned Read Committed transaction. All database helpers use its authority. Handlers cannot commit, create nested transactions or obtain raw connections. A handler/database failure or invalid output rolls back every write. Commit precedes success delivery. No serializable multi-record business-rule guarantee or automatic retry is promised.

Tables are versioned by default. Updates/deletes require an expected version; compare-and-change occurs atomically. Successful updates increment the version. Stale versions, missing records and constraint conflicts are distinct typed failures. The framework owns the version field. Explicit unversioned tables are permitted with the no-lost-update-guarantee warning.

Typed database operations include filtering, sorting, pagination, joins, inserts, updates and deletes. Declare primary keys, foreign keys, uniqueness, nullability and referential actions. Stable pagination includes a unique tie-breaker. The caller supplies row bounds through typed query parameters; default list page size is 100, maximum 500. Result payloads also obey the 1 MiB limit.

### Authoring examples

These are target API signatures to implement and verify, not existing runtime code. Preserve the accepted `schema`, `defineQuery`, `defineMutation`, table/column and handler shapes from the application-contract resolution.

```ts
// shared/exercises.ts
import { schema, defineQuery, defineMutation } from "fleur/schema";

export const listExercises = defineQuery({
  name: "exercises.list",
  input: schema.object({}),
  output: schema.array(schema.object({
    id: schema.uuid(), name: schema.string().min(1).max(100),
    version: schema.safeInteger(),
  })),
});

export const renameExercise = defineMutation({
  name: "exercises.rename",
  input: schema.object({
    id: schema.uuid(), expectedVersion: schema.safeInteger(),
    name: schema.string(),
  }),
  output: schema.object({
    id: schema.uuid(), name: schema.string().min(1).max(100), version: schema.safeInteger(),
  }),
});

// server/operations.ts
import { handleQuery, handleMutation, inputError } from "fleur/server";
import { listExercises, renameExercise } from "../shared/exercises";
import { exercises } from "./tables";

handleQuery(listExercises, async ({ db }) => db.select(exercises, {
  fields: ["id", "name", "version"],
  orderBy: [{ field: "id", direction: "asc" }], limit: 100,
}));
handleMutation(renameExercise, async ({ input, db }) => {
  const name = input.name.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 100) {
    throw inputError({ name: "Use 1–100 characters after trimming." });
  }
  return db.updateVersioned(exercises, {
    id: input.id, expectedVersion: input.expectedVersion,
    set: { name }, returning: ["id", "name", "version"],
  });
});
```

Explicit stable operation names are metadata, not arbitrary URL registration. Duplicate names fail admission. Internal HTTP paths are Fleur-owned; application agents cannot add public endpoints/webhooks or arbitrary response formats.

### States and errors

Query state exposes `status: loading | success | error`, optional validated data, `stale`, `refreshing`, and safe error detail. Runtime connection state exposes connected, reconnecting and maintenance separately from query success. Do not describe stale successful data as current. No previous data means loading/error with no fabricated result.

Mutation state exposes idle, pending, success, failure and outcome-unknown. Safe failure codes distinguish invalid input, missing records, constraint conflicts, concurrent edits, unsupported capabilities, limits and internal failure. Invalid output is internal failure. Disconnect after submission may be unknown; disconnect before dispatch can establish not-sent. Never retry an unknown mutation automatically or claim exactly-once effects.

### Reference API families

The following TypeScript notation defines the target reference. These declarations are documentation, not compiled proof. `Infer`, `Row`, `Insert`, `Selected`, `Versioned` and component contextual types must be supplied by Fleur's type implementation and positive/negative fixtures before application code relies on them. Runtime validation must match the same contract.

| API | Reference signature and required semantics |
| --- | --- |
| Schema values | `schema.string(): StringSchema`; `boolean(): Schema<boolean>`; `number(): NumberSchema`; `safeInteger(): NumberSchema`; `uuid(): Schema<UUID>`; `localDate(): Schema<LocalDate>`; `timestamp(): Schema<Timestamp>`; `decimal({maxScale, nonnegative}): Schema<DecimalString>`; `enum<const V extends readonly string[]>(values: V): Schema<V[number]>` |
| Schema composition | `object<const S extends SchemaShape>(shape: S): Schema<ObjectInfer<S>>`; `array<S extends Schema>(item: S): ArraySchema<Infer<S>>`; `S.optional()` permits omission; `S.nullable()` permits null. String min/max count Unicode code points; array min/max count entries; numeric bounds validate finite values. No transformation callback. |
| Named operations | `defineQuery<I,O>({name?: string,input: Schema<I>,output: Schema<O>}): Query<I,O>`; `defineMutation<I,O>(...): Mutation<I,O>`; `defineRetrieval<I,O>(...): Retrieval<I,O>`. Name omitted means a stable registered export-derived name; duplicates fail. |
| Columns | `column.uuid()/string()/boolean()/safeInteger()/decimal({precision,scale})/localDate()/timestamp()` create nonnullable columns. `.nullable()` adds null; `.primaryKey()` requires uniqueness/non-null; `.generated()` or `.default(value)` makes insert omission permitted; timestamp `.defaultNow()` is a database default. String `.max(n)` bounds code points. |
| Tables | `defineTable<const C extends ColumnShape, V extends boolean = true>(name, {columns:C,versioned?:V}): Table<C,V>`. Expose typed column references as `table.field`. `Row<T>` maps stored types; `Insert<T>` requires only nondefault/non-generated fields. Fleur's version field is select-only and cannot be user-set. `column.references(target,{onDelete:"restrict"|"cascade"|"set null"})` requires compatible types and nullable source for set-null. |
| Relations | `defineRelations<T,R>(table:T, build:({one,many})=>R): Relations<T,R>`. `one(target,{fields:[source columns],references:[target columns]})` checks matching arity/types and infers nullable joins. `many(target)` pairs with a declared foreign-key relation. Relation registration never exposes data publicly by itself. |
| Read selection | `db.select<T,F extends readonly (keyof Row<T>)[]>(table:T,{fields:F,where?:Filter<Row<T>>,orderBy?:readonly Order<Row<T>>[],limit?:number,cursor?:Cursor<T>}): Promise<Selected<Row<T>,F>[]>`. Filter is a typed expression over column references, using `eq`, `ne`, comparisons, `in`, `isNull`, `and`, `or`; RHS values have the column's type. No SQL strings or interpolated identifiers. |
| Single-statement joins | `db.selectJoined({from,joins,fields,where,orderBy,limit,cursor})` uses table aliases and typed column-reference projection. Join entries specify inner/left type, table/alias and typed predicate. Return type follows the projection; left-side absent joined fields are nullable. Related projections are one SQL statement, not hidden N+1 reads. Pagination requires deterministic unique tie-breaking. |
| Writes | `db.insert<T>(table:T,{values:Insert<T>,returning:F}): Promise<Selected<Row<T>,F>>`; `updateVersioned(table,{id,expectedVersion,set,returning})` and `deleteVersioned(table,{id,expectedVersion})` require versioned tables, primary-key types, and exclude managed/generated columns from set. Unversioned tables use `update/delete` with the declared warning and no version guarantee. All use the handler-bound authority. |
| Handler registration | `handleQuery<Q>(q:Q,handler:(ctx:{input:Input<Q>,db:ReadDb,log:SafeLog})=>Promise<Output<Q>>): void`; mutation substitutes WriteDb; retrieval substitutes `external: ExternalCapability` and no database writes. No handler receives setup, arbitrary filesystem or raw connection authority. |
| Public failures | `inputError(fields:Record<string,string>): PublicOperationError`; `publicError(code:DeclaredErrorCode,details?:PublicValue): PublicOperationError`. Unexpected exceptions map to safe internal failure. Declared errors cannot expose stack/SQL/secrets. |
| Server reads | `readQuery<Q>(q:Q,input:Input<Q>): Promise<Output<Q>>`; `readRetrieval<R>(r:R,input:Input<R>): Promise<Output<R>>`. Callable only in an admitted server render context, registering dependencies/cache entries. Query/mutation handlers cannot acquire render-context dispatch authority. Helpers inside handlers use the provided db instead. |
| Client queries | `useQuery<Q>(q:Q,input:Input<Q>): QueryState<Output<Q>>`. State contains status, optional data/error, stale, refreshing; `refresh(): Promise<QueryRefreshResult>` is read-only. Initial errors/refresh failures never fabricate data. |
| Client mutations | `useMutation<M>(m:M): MutationState<Input<M>,Output<M>>` includes status, `pending`, optional data/error and `run(input): Promise<MutationOutcome<Output<M>>>`. Outcomes are tagged success, failure, outcome-unknown; ordinary public/transport failures resolve to this union rather than unhandled rejected promises. Unexpected programmer failures remain errors. Calling run never authorizes automatic replay. |
| Retrieval refresh | Server `readRetrieval` obtains cached current-input values during DB rerenders. A Fleur client `refreshRetrieval(contract,input)` explicitly asks for retrieval refresh through validated transport; it does not make a direct external request or grant external authority. |
| Routing | `definePage<P>({path,params:Schema<P>}): Page<P>`; server `registerPage(page,{component:(props:{params:P})=>VNode|Promise<VNode>})` contextually infers P. Client `Link({to:Page<P>,params:P,children})` and `navigate(page,params)` validate/encode parameters. Declared path parameters must correspond to the schema. |
| Islands | `defineIsland<P>({props:Schema<P>,component:(props:P)=>VNode}): Island<P>` checks props at type/runtime boundaries. Server rendering creates immutable typed references and validated descriptors, not arbitrary callable function payloads. |
| Seeds | `defineSeed<T>({key:string,table:T,rows:readonly {ownerKey:string,values:Insert<T>}[]}): Seed<T>` declares ownership and values. Database-dependent dependency ordering is a declared seed graph; seed declarations cannot commit, reset or run raw SQL. |

Filters, ordering, joined projections, relation references and cursors are structural Fleur-owned types, with operator arity/value checks and runtime validation of every broker request. Cursors are opaque versioned encodings bound to query ordering/inputs, not trusted arbitrary SQL. The implementation must publish full generated `.d.ts` reference and fixtures for every family; the signatures here constrain that work rather than allowing inference to be replaced with hand-written `any`.

Required negative fixtures include wrong operation input, omitted required nullable field, unsafe numeric/date interchange, query write, cross-table invalid reference, wrong filter value, unversioned/versioned API mismatch, missing link parameter, incorrect island props and nested secret/unsupported prop rejection. Server-only authority never appears in client-inferred types.

## Server pages and interactive islands

Page contracts remain browser-safe in shared/. Server page registration replaces the earlier client-only `registerPage` example; existing query/mutation/table contracts remain intact.

```tsx
// shared/pages.ts
import { definePage } from "fleur/routing";
import { schema } from "fleur/schema";
export const exercisesPage = definePage({
  path: "/exercises", params: schema.object({}),
});

// server/pages.tsx
import { registerPage, readQuery } from "fleur/server";
import { exercisesPage } from "../shared/pages";
import { listExercises } from "../shared/exercises";
import RenameForm from "../client/RenameForm";

registerPage(exercisesPage, {
  component: async ({ params }) => {
    const rows = await readQuery(listExercises, {});
    return <main><h1>Exercises</h1>{rows.map(row =>
      <section key={row.id}><p>{row.name}</p>
        <RenameForm id={row.id} version={row.version} />
      </section>)}</main>;
  },
});

// client/RenameForm.tsx
import { useState } from "preact/hooks";
import { defineIsland, useMutation } from "fleur/client";
import { schema } from "fleur/schema";
import { renameExercise } from "../shared/exercises";
export default defineIsland({
 props: schema.object({ id: schema.uuid(), version: schema.safeInteger() }),
 component: props => {
  const [name, setName] = useState("");
  const rename = useMutation(renameExercise);
  return <form onSubmit={event => {
    event.preventDefault();
    if (rename.pending) return;
    void rename.run({ id: props.id, expectedVersion: props.version, name });
  }}><label>Name<input value={name} onInput={event =>
      setName(event.currentTarget.value)} /></label>
    <button disabled={rename.pending}>Save</button>
    {rename.status === "outcome-unknown" && <p role="alert">
      Save outcome unknown. Refresh and reconcile before retrying.
    </p>}
  </form>;
 }
});
```

The client directory is the explicit island boundary. `defineIsland({ props, component })` returns a Preact component whose required props and contextual component parameter derive from its mandatory schema. Validate public props before server HTML delivery, before initial hydration and before reactive prop updates. Reject undeclared/unsupported values using the operation value rules. Fleur builds a manifest of admitted client exports and their module dependencies. Server compilation replaces island imports with typed references and HTML/hydration descriptors. Code required only by server pages never enters browser chunks or source maps. No credentials, authority handles, unregistered functions or database rows outside selected public schemas cross the boundary. The compiler infers and checks component props; runtime boundary validation remains independent.

Initial navigation/direct load renders server HTML and initial validated query results. Hydrate only client islands, preserving server content. Register page parameter schemas and infer component/link types contextually. Invalid URLs produce a safe routing error. `Link` and navigation go through Fleur routing; arbitrary router imports are not approved.

Each server-rendered region tracks its query dependencies and a stable identity derived from page, keyed component path and operation/arguments. Updates reconcile only the affected region and retain existing keyed client islands. Preserve local draft values, focus and component state unless the application's own navigation/key/removal deliberately changes identity. A failing region exposes its error/stale state without stopping healthy siblings. Initial server rendering must not evaluate client effects or expose browser-only APIs to server code.

## Reactive delivery

After every committed managed mutation, invalidate all active database queries. Publish no rolled-back data. Deliver complete validated results, not application-maintained row events. Success means committed, not that all subscribers refreshed.

Advance a durable database revision in the same transaction as managed writes. Notifications are wakeups, not the source of truth. Probe revision at least once per second while active views exist so missed publications recover within the five-second budget. A database epoch changes after replacement/maintenance resumption. A trusted maintenance record outside the replaceable database ensures restoring an old backup cannot reuse an old epoch as current.

Every response is associated with epoch, page/navigation identity, connection generation, request sequence and revision. Discard responses from obsolete identities/epochs/generations and responses superseded by a newer request. If invalidation arrives during a refresh, coalesce it but perform a trailing refresh until the current revision is observed. Duplicate wakeups never repeat mutations. Do not assume query timing alone establishes currency.

Initial render captures revision and establishes subscription with a second authoritative revision check, closing the gap between reading and subscribing. Reconnect refreshes all active queries before they become current. Failed refresh keeps old data explicitly stale/error. Maintenance marks views paused/reconnecting and invalidates pre-maintenance results before access resumes.

Count each active logical query key, including server-region dependencies, toward connection/project limits. Identical operation plus canonical validated arguments in one connection share one logical subscription; they do not share mutable application objects. Dispose subscribers on navigation/unmount/disconnect, with a bounded stale-connection expiry of 30 seconds. Reject additional subscriptions rather than evicting healthy ones. One timed-out/oversized query must not stall siblings.

External retrieval is not a database subscription. Cache validated external results/failures per view epoch, retrieval name and canonical inputs. Database-driven rerenders reuse those entries. New inputs, first load or explicit external refresh obtain a new result. Do not present a cached failure as empty success. Navigation/new view has its own initial load; no cross-user/global secret-bearing cache is implied.

## External server capability

Define retrieval contracts with the same mandatory validated input/output convention as other operations. Register a server-only retrieval handler receiving a Fleur-owned `external` capability. Database queries/mutations do not receive this network authority. Retrieval cannot perform database writes. Saving retrieved data uses a subsequent atomic mutation which revalidates and applies business rules; data returned through the browser is never trusted merely because it originated on the server.

Declared destinations bind scheme, hostname, port and allowed path prefix/template. Support GET/HEAD only. HTTPS is required except explicitly declared local test/development services. Reject URL credentials and application-selected arbitrary origins. Resolve DNS and verify the actual connection address; reject private, loopback, link-local and metadata destinations unless the exact local-service exception admits them. Keep DNS/address checks bound to the connection rather than a preliminary string check. Never follow redirects; map them to an explicit typed failure.

Credentials are supplied by the trusted broker from startup environment. An application names a configured credential binding; it cannot read the secret or attach it to another destination. Redact authorization/cookie headers and sensitive URL query values. Response schemas select only public data.

Defaults are a whole-operation ten-second deadline and 1 MiB decoded-body limit. Server configuration may raise these to at most 30 seconds and 10 MiB. Queueing, DNS, connection and body read all consume the deadline. Enforce decoded streaming bytes before parse; Content-Length alone is insufficient. HEAD returns declared metadata without a body. HTTP failures, redirects, destination denial, timeout, transport failure, excessive size and invalid output have distinct safe codes. No automatic external-write or integration effect is supported.

## Runtime isolation and production feasibility gate

Application execution containers have no host secrets, Docker socket, database credentials, ambient outbound networking or writable host mounts. They receive an admitted immutable bundle and a narrow inherited broker channel. The trusted host broker owns database connections/transactions, network destination credentials, logs and resource lifecycle. Broker requests reference registered operations/table handles, never arbitrary SQL, URLs, paths or shell commands.

Container settings include an unprivileged UID, read-only root, no capabilities, no-new-privileges, explicit PID/memory limits and isolated network. These settings protect the host but do not alone enforce the handler filesystem/network prohibition.

The initial compatibility profile uses worker limits of one CPU, 512 MiB memory and 64 PIDs, with separate trusted broker resources. These are initial engineering settings to measure, not an additional performance promise. Verify cgroup enforcement and record accepted tuning alongside the reference profile before dependent work. Broker deadlines cancel query work and roll back/release its connection; do not reuse a connection until cancellation/transaction state is verified. CPU-bound or stuck application execution is terminated at its operation deadline, isolated from healthy workers. Killing a mutation worker cannot imply rollback if the broker already committed; retain the outcome evidence rules.

The selected implementation candidate adds irreversible Linux seccomp restrictions after trusted bootstrap prepares the fully bundled code and before application evaluation. Close unrelated descriptors. Deny filesystem opening/mutation, new sockets/connects, process spawning, namespace changes, debugging and privilege changes while admitting only the runtime calls needed for execution and reads/writes on inherited broker/log channels. Apply restrictions to all threads and future execution. No application module evaluates during an unrestricted phase. Bundle loading and dynamic runtime module access must not reopen authority.

This candidate is not verified with Bun's lazy I/O, thread model or JIT. The first implementation prerequisite must prove it with real negative tests and admitted Preact/database-proxy operations. Do not implement dependent features, ship, or describe the boundary as secure until that gate passes. If it cannot satisfy the contract, return to live human discussion for another mechanism; never replace it with lint or silently add Node/another application runtime. See [the foundation research](../../research/server-rendering-capabilities.md).

Query brokers expose read-only database authority, with a snapshot per database statement and no implicit multi-read snapshot. Mutation brokers bind all calls to one transaction and reject cross-operation/nested authority. Outputs validate before commit. Retrieval authority is separate: server pages invoke registered retrieval operations through `readRetrieval`, but never receive the raw external capability. Query/mutation handlers cannot invoke retrieval or acquire its authority by passing a handle. Setup grants and host control channels are not reachable from application containers.

The grant trust boundary protects supported Fleur operations. Human confirmation is required to create/broaden setup grants; action/method/target scope and destructive-plan checksums are checked on every use. It does not contain a same-user agent that modifies Fleur/grant storage or unrestricted host files. Host permissions remain external to the product.

## Database migrations, seeds and recovery

Generate a migration from server table declarations and the last committed schema snapshot. Generation does not mutate the database. Review SQL and a structured plan showing removals, incompatibilities and backfills. Apply only PostgreSQL transaction-compatible plans. Defer concurrent indexes and other nontransactional operations. Record the migration checksum/history in the same transaction as its schema/data changes. Applied files are immutable.

Normalize and compare actual catalog schema, constraints, indexes, type/default definitions and migration checksums/order against the expected state, excluding documented Fleur-owned metadata. Snapshot generation alone is not drift detection. Drift blocks normal access/migration until an explicit repair plan reconciles it; no silent push/reset/history repair.

Acquire a database maintenance lock before migration/seed/reset/restore. Hold a session-level advisory lock on a direct connection to a configured control database in the same PostgreSQL cluster, defaulting to the existing `postgres` database; do not create or write user tables there. Derive its namespaced key from the verified cluster/project target identity. Never hold the reset lock inside the database being dropped, and never use a transaction-pooled connection for this lock. Competing commands return contention without modifying anything. Startup and broker admission check the same maintenance state/lock so they cannot race reset/restore. The external durable stage marker remains after a lock owner's crash; reacquiring the released lock does not prove recovery completed.

Stop new application database operations and drain/verify connections before backup or destructive maintenance. Scope authorization to the verified database identity and exact plan checksum. Changed contents invalidate approval. If the required control connection is unavailable, maintenance and affected startup fail before changes rather than falling back to an unsafe lock. Test concurrent reset/start, reset/restore, interrupted reset/recreation and restored old epochs.

Before migration/reset, create a consistent backup and restore it into a uniquely owned disposable verification database. Verify identity, complete restore, expected schema/history and integrity before proceeding. A failed prerequisite with verified unchanged original state may release maintenance. Retain verified backups until deliberately deleted; never silently overwrite post-backup changes during recovery.

Persist maintenance stage, target identity, backup reference and plan checksum outside the database being replaced. Stages distinguish preparing, backup verified, applying, committed, rollback verified and recovery required. After crash/interruption inspect actual catalog/history before classifying the result. Never automatically repeat destructive work or clear an uncertain marker. Read-only status/logs remain available.

Development reset requires target-specific approval; it verifies backup, recreates the database and applies current migrations, leaving empty data unless seed is explicitly requested. Production reset is unavailable. Restore requires target/backup-specific confirmation and reports that it replaces current data. Verify resulting compatibility/history before reopening and advance the maintenance epoch.

Development storage identity combines repository project metadata with machine-local checkout identity; a copied checkout must request a new binding or explicit adoption rather than reuse the source volume. Real paths are machine state, never tracked configuration. Every test/backup-verification database has a unique run identity and role; reject development/production URLs before test writes. Cleanup checks identity labels and never targets another project.

### Seed ownership

Seeds declare stable ownership keys and desired validated row values; no arbitrary shell/SQL scripts. Ownership is record-level. Store last seed-applied public row/version fingerprints in Fleur metadata. Managed mutation deletes and database cascades update seed ownership/tombstone metadata in the same transaction, using Fleur-managed deletion triggers for seeded rows. Before each seed, reconcile missing rows under the maintenance lock; an absent formerly owned row becomes a tombstone. Delete/recreate cannot erase ownership history. An unchanged owned row may update through an atomic expected-version write; a user-edited row is skipped and reported. For unversioned rows use stored canonical public-row fingerprints and locked compare-and-write inside the seed transaction. Internal seed metadata changes do not count as user edits. Ambiguous collisions, invalid data or foreign-key conflicts fail and roll back the entire seed run.

User-deleted seed records retain an ownership tombstone and are not silently recreated by repetition. Recreated records with conflicting identity are ownership conflicts. Removing a seed declaration does not delete its existing row. A skipped parent does not authorize child writes that violate integrity; fail atomically when the declared seed graph cannot be satisfied. Explicit reset followed by requested seed creates a fresh ownership state.

## Database tooling for application agents

This section consolidates the database rules above for agent-facing tooling and guidance. The [database agent tooling amendment](https://github.com/hazeion/fleur/issues/61) is open; only its resolved tickets change this behavior.

Fleur owns database orchestration, including:

- development PostgreSQL and storage identity
- maintenance locking
- migration generation, review and application
- seed reconciliation
- inspection, backup, restore, reset and recovery

Applications own their table and relation declarations, reviewed migration and seed content, operations and business rules. They express these only through `fleur/schema`, `fleur/database` and `fleur/server`. Drizzle, Bun SQL and raw SQL remain non-application imports. Fleur's database tooling reads PostgreSQL catalogs and Fleur metadata, not an ORM's model, so an internal library choice cannot change tooling behavior. Applications run on Fleur's pinned runtime; the October 26, 2026 review kept a Fleur-independent application runtime and an application-selected ORM outside v1.

Each database capability is one named operation in Fleur's shared core. The CLI exposes it through the operation catalog with JSON version 1 output, stable error codes and exit categories. A later interface, such as an MCP adapter, must invoke the same operations. It cannot add authority, skip grants or bypass bounds. Do not introduce a second database-management mechanism.

Safety is enforced by code and PostgreSQL authority, never by instructions alone:

- Typed operations bind values and never accept SQL strings or interpolated identifiers.
- Inspection is read-only and bounded.
- Persistent schema changes go only through reviewed, immutable migrations.
- Destructive operations require target- and content-bound human approval.
- Credentials stay in the trusted host and never appear in output, logs, workers or browser bundles.
- Development data persists across stop and restart.
- Production targets admit fewer operations than development: production reset is unavailable, and production startup refuses pending migrations.

### New development database initialization

The [fresh-database resolution](https://github.com/hazeion/fleur/issues/66#issuecomment-6426073167) adds one exception to "startup never applies migrations implicitly". A `fleur dev` startup initializes a **new development database**: a database Fleur created for a storage binding that has provably never been initialized. Every other database keeps the explicit `db migration apply` and `db seed` flow.

- **Newness proof.** Fleur writes a durable private creation record, bound to cluster and database identity, before creating the database. At initialization the catalog must show that identity, no application relations and no Fleur migration history. Emptiness alone never qualifies.
- **Contents.** Initialization applies the whole plan-validated committed migration chain, including removals, then runs the declared seeds. Migrations, history and seeds commit in one transaction.
- **Authority.** No backup or human approval is required. The maintenance lock is held, and the expected catalog is recorded for drift detection.
- **Empty chain.** Initialization waits for a non-empty committed migration chain and runs only at startup, never during reload.
- **Failure.** Failure rolls back, reports failed with an action and never reports ready. Later startups may retry while the database remains provably uninitialized.
- **Boundaries.** Adopted volumes are never new. A copied checkout's new binding is new and copies no data. Reset, production `start` and test databases are unchanged.
- **Reporting.** `dev` reports initialization in human output and JSON: migrations applied, seed rows applied and the resulting migration status.

Acceptance:

- A new binding becomes ready with the chain and seeds applied.
- An empty-but-previously-initialized database and an adopted volume are not initialized automatically.
- A failing seed or migration leaves the database new and blocked.
- A retry succeeds after the cause is corrected.
- An empty chain leaves the database new.

### Schema inspection and database health

The [inspection and health resolution](https://github.com/hazeion/fleur/issues/65#issuecomment-6427697170) extends existing operations and adds no new command.

- **Schema overview.** `db inspect` without `--table` returns a schema overview of application tables, with no rows:
  - columns with PostgreSQL type, Fleur column kind, nullability and default
  - primary key
  - foreign keys with `onDelete` actions
  - unique constraints and indexes
  - whether the table is versioned

  Fleur-owned metadata tables are excluded, and Fleur-managed columns are marked as managed. The overview paginates by table with `--limit` and `--cursor`, enforces the encoded byte cap and reports truncation. `--table <name>` returns that table's structure plus a bounded page of rows.
- **One owner of migration state.** `db migration status` alone computes applied, pending and drift state. It reports drift as a bounded list of differences, each with the object, expected definition and actual definition. `db inspect` and `status` embed a migration summary from that same operation.
- **Health in `status`.** Whether or not the app is running, `status` reports a `database` object: connectivity, target kind, database name, server version, target fingerprint, maintenance or recovery stage, and the migration summary. `doctor` never connects to the database, and `status` never re-runs prerequisite probes; a prerequisite-caused reason carries an action that points to `doctor`.
- **Findings are data.** A diagnostic that can produce its result reports drift, pending migrations, maintenance, recovery state and an unreachable database as data with exit 0. Exits 4 and 5 apply only when the command cannot produce its result. Drift and active maintenance do not block read-only inspection; output carries the stage.
- **Probe deadline.** The `status` database probe has its own 5-second default deadline, adjusted by `--timeout`. A timeout or refusal reports `unreachable` with a reason.
- **Reasons and codes.** Readiness reasons use a stable vocabulary: `DATABASE_UNAVAILABLE`, `MIGRATION_PENDING`, `SCHEMA_DRIFT`, `MAINTENANCE_ACTIVE`, `RECOVERY_REQUIRED` and `PREREQUISITE_UNAVAILABLE`. Each carries one structured action. `DATABASE_UNAVAILABLE` is also the exit-4 error when a command needs data from a database it cannot reach.
- **Identity.** Output identifies the target by kind, database name, server version and a non-reversible fingerprint of the verified target identity. It never shows host, port, user or URL.
- **Production.** `status` and `db inspect` default to the development target and select production through one shared option that reads the configuration `start` uses. The schema overview and health are available against production with explicit credentials; otherwise they return `CONFIGURATION_MISSING`. Neither adds production authority. Against production, `status` reports app state only when a production `start` for that artifact is registered on the machine.

Acceptance:

- The overview reports every listed structural element for the workout fixture and never returns rows.
- An overview larger than one page reports truncation and resumes from its cursor.
- Drift, a pending migration and an active maintenance stage appear in `db inspect`, `status` and `db migration status` with the same summary.
- `status` against a stopped or unreachable database exits 0 within its probe deadline and reports the reason and action.
- `db inspect --table` against an unreachable database returns `DATABASE_UNAVAILABLE` with exit 4.
- A production target without explicit credentials returns `CONFIGURATION_MISSING`.
- No host, port, user or URL appears in either output.

### Inspection authority

The [inspection authority resolution](https://github.com/hazeion/fleur/issues/63#issuecomment-6428012384) draws the PostgreSQL privilege boundary by who authored the SQL.

- **Fleur-generated SQL.** `db inspect`, the schema overview, `status` database health and `db migration status` execute only Fleur-generated statements. They use the configured database credential inside a host-opened `READ ONLY` transaction, which cannot become read-write after its first query. No dedicated role is provisioned for them.
- **Agent-authored SQL.** Any operation that executes SQL written by an agent must run under a Fleur-provisioned, verified PostgreSQL role without write privileges, in addition to a host-opened read-only transaction, a fresh connection per request and a host-owned deadline.
- **Minimum-privilege profile.** Read-only operations need `CONNECT` on the application and control databases, `USAGE` and `SELECT` on `public` and `fleur_internal`, `EXECUTE` on `pg_control_system()` in the application and control databases, and the advisory lock functions on the control database: session advisory locks for the maintenance lease and the transaction-level `pg_advisory_xact_lock` for inspection. Backup, migration apply, restore and reset need more, including role and database creation and write authority. Operators may supply a credential limited to this profile; Fleur does not reject broader credentials.
- **Insufficient authority.** A command whose credential lacks the authority it needs detects this before changing anything and returns `DATABASE_PRIVILEGE_INSUFFICIENT` with exit 4, outside any maintenance stage. The error names the missing capability category and points to the documented profile. It never names the role, host, port or URL.

Acceptance:

- The schema overview, `db inspect --table` and `status` health succeed under a credential limited to the profile, against a disposable PostgreSQL database.
- `db backup` and `db migration apply` under that credential return `DATABASE_PRIVILEGE_INSUFFICIENT` with exit 4, change nothing and leave no maintenance stage.
- Neither output names the role, host, port or URL.

### Development read-only SQL

The [development SQL resolution](https://github.com/hazeion/fleur/issues/64) adds one named operation, `db query`, that runs a single read-only SQL statement written by an agent against the development database. It is a development diagnostic only. Application code still cannot import or send SQL, and every other inspection operation still accepts no SQL.

- **Target.** `db query` connects only to the PostgreSQL cluster owned by the project's `fleur dev` instance. It accepts no URL, credential or production-target option and never reads production configuration; the shared production-target option returns `ARGUMENT_INVALID` (exit 2). Before connecting, Fleur verifies the cluster and database identity recorded for the development storage binding. If development PostgreSQL is not running, it returns `DATABASE_UNAVAILABLE` (exit 4); it never starts PostgreSQL.
- **Input.** `--sql <text>` or `--sql-file <path>`, at most 64 KiB, plus repeatable `--param <text>` values bound in order as `$1…$n`. Every parameter is sent as text; casts belong in the SQL. There is no null parameter, and parameters are never interpolated into SQL text.
- **Accepted statements.** Fleur wraps the statement as a subquery with a bound row limit and always sends it through the extended protocol with at least one bound parameter. Only one `SELECT`, `WITH` without data-modifying parts, `VALUES` or `TABLE` statement can execute. `EXPLAIN` is unavailable in v1.
- **Execution.** Each request uses a fresh connection under the agent query role and a host-opened `READ ONLY` transaction with `SET LOCAL` `statement_timeout`, `lock_timeout = 1s`, `row_security = off` and a fixed `search_path`. It always ends with `ROLLBACK` and closes the connection.
- **Output.** Columns carry names, in order and including duplicates, and PostgreSQL type names. Values are exact text strings, with `null` for SQL null. `--limit` defaults to 100 rows and allows at most 500; encoded output shares the `db inspect` byte cap. Exceeding either bound returns the rows that fit with `truncated: true` and exit 0. There is no cursor. Output includes the migration summary from `db migration status`.
- **Deadline.** The default statement deadline is 5 seconds, adjustable by `--timeout` up to 30 seconds. On expiry, the host closes the connection and returns `QUERY_TIMEOUT`. Role-level timeouts are defense in depth only.
- **Errors.** PostgreSQL errors return `DATABASE_QUERY_REJECTED` (exit 1) with SQLSTATE, message and, when present, position, detail and hint. Its action states the accepted statement form. This covers permission, read-only, syntax and cast errors. Error output never names the role, host, port or URL. `DATABASE_PRIVILEGE_INSUFFICIENT` remains reserved for Fleur's own credential.
- **Maintenance.** While a maintenance stage or recovery is active, `db query` returns `MAINTENANCE_BUSY` (exit 5). Pending migrations and drift do not block it.

**Agent query role.** Fleur provisions one login role in its development cluster:

- `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, `CONNECTION LIMIT 4`, and a superuser-set `temp_file_limit` the role cannot override.
- A random password kept only in trusted host private state and regenerated at every development PostgreSQL start.
- Explicit grants only: `USAGE` on `public`, `SELECT` on its tables, and default privileges from the role that owns migrated tables. No `pg_read_all_data`, `fleur_internal` access or sequence privileges.
- `PUBLIC` loses `CONNECT` and `TEMP` on the application, control, `template1` and verification databases, with explicit re-grants to Fleur's own roles, so the role cannot reach the control database or Fleur's maintenance locks. Advisory-lock functions stay executable in the application database; no Fleur lock may live there.
- Before every request, Fleur verifies the role's attributes and grants and re-applies anything missing with its administrative credential, so restore, reset and new-database initialization end verified. A verification that still fails returns `DATABASE_PRIVILEGE_INSUFFICIENT`.
- Supported and tested on PostgreSQL 18, the pinned development image.

Accepted residual risks, bounded by the deadline and per-request connection: catalog metadata is readable, advisory locks in the application database, CPU and memory use, and one agent query cancelling another under the same role.

Acceptance:

- `INSERT`, `UPDATE`, `DELETE`, DDL, data-modifying `WITH`, multiple statements, `SET`, `SET TRANSACTION READ WRITE`, `SELECT … FOR UPDATE`, `nextval` and temporary table creation are each rejected with `DATABASE_QUERY_REJECTED`, and the database is unchanged.
- Reads of `fleur_internal`, connections to the control database and attempts to raise `temp_file_limit` fail.
- Bound parameters round-trip exactly, and a parameter containing SQL is treated as data.
- Row and byte bounds report truncation with exit 0; a statement past its deadline returns `QUERY_TIMEOUT` and leaves no session behind.
- A table with row-level security enabled returns an error rather than zero rows.
- The production-target option returns `ARGUMENT_INVALID`, and a stopped development database returns `DATABASE_UNAVAILABLE`.
- An active maintenance stage returns `MAINTENANCE_BUSY`.
- After restore, reset and new-database initialization, `db query` succeeds with the role verified.
- Backup verification and restore still pass with the `PUBLIC` revocations in place.
- No output names the role, password, host, port or URL.

### Generated database guidance

Generated AGENTS.md has a dedicated database section, referenced from CLAUDE.md, covering:

- tables, relations, versioning and the typed query and mutation APIs as the only data access path
- `db query` as a development-only diagnostic, never a data access path for application code
- why raw SQL and ORM imports are unavailable, and how to suggest a missing capability by describing the need and existing alternatives
- the generate, plan review, apply and status workflow for migrations, including immutability of applied files
- declarative seeds, and reset only with approval
- inferred types and runtime validation at every boundary
- credential, disposable-test-data and destructive-authority rules
- the checks to run after a schema change: types, database tests against disposable PostgreSQL, migration status free of drift or pending entries, and persistence across restart

The guidance names only operations present in the pinned release and marks later ones unavailable.

### Database tooling acceptance

Release evidence must show each of the following:

- Typed operations reject invalid filter values and query writes at compile time and runtime.
- Migration generation leaves the database unchanged.
- Apply commits schema and history together, and a failed apply leaves verified rollback with readiness blocked.
- Drift and pending migrations block readiness and production start.
- Inspection cannot write and stays within its row and byte bounds.
- No credential appears in any command output or log.
- Development data survives stop and restart.
- A generated project passes types, lint and tests with only its pinned dependencies.

Accepted amendment tickets add their own acceptance criteria here.

## Setup and compatibility

Entry is `bunx fleur`, with Bun installed beforehand. The package executable must actually run through Bun without hidden Node; merely using bunx on a Node shebang is insufficient. Honor the project's exact Fleur pin. Missing pins stop with an explicit action, never latest fallback.

Require native Intel macOS, Ubuntu 24.04/26.04 amd64 and Debian 13 amd64. Apple Silicon, other ARM64 targets and Arch are deferred under the approved platform amendment and do not block #24 or v1 acceptance. Their full native installation/runtime support remains unqualified; existing exact measured component/readiness records and ARM/Arch tests retain their original limited scope. No additional hardware acquisition or future qualification is required by this release. Future full support needs a separate scope decision and genuine executed evidence. Native architecture detection still distinguishes Rosetta. Reject remote Docker endpoints without altering global context. Publish exact verified OS/Bun/Docker/Compose/image support for each release. Unknown tuples and unqualified installers still refuse.

Reuse compatible local Docker. Required-target assisted setup uses verified official Docker Desktop on Intel macOS and Docker's apt repository on Ubuntu/Debian amd64. The retained Arch pacman adapter is deferred and unqualified. Installation, starting/enabling services, access privilege changes, configuration/profile changes and legal agreement acceptance are separate actions. Humans grant once or per-user remembered action/method permission; agents cannot broaden it through supported APIs. Revocation/inspection are explicit. Human OS/password/legal actions return promptly with resumable status.

Doctor separately checks CLI/version, effective endpoint, daemon access, Compose and a disposable smoke container. An image pull must be part of the applicable plan. Readiness is not executable presence. Serialize setup, preserve usable tools, reprobe after interruption and do not blindly repeat successful steps. Never remove conflicts or reconfigure/upgrade existing installations automatically.

Compatibility checks include pin, runtime/contract metadata, selected compiler and migration state. Patch/minor versions preserve contracts within a major; pre-1.0 breaking changes require minor releases and explicit instructions. Upgrades are explicit documented paths with reviewable application diffs and rollback of files/pin on failure. Never apply database migrations during upgrade; changing a version pin does not undo schema changes.

## Lifecycle and artifacts

One dev instance owns its application supervisor/containers and development PostgreSQL. `dev` is foreground unless `--background`; terminal close stops foreground-owned resources, not a background instance. Repeated invocation reports the existing instance. Multiple project instances are independent. Validate process start identity/ownership rather than trusting PID alone.

Readiness requires database connectivity/schema compatibility, admitted source, server rendering, browser assets and reactive transport. States are starting, ready, maintenance and failed. Default to loopback; broader application binding is explicit and warns that v1 has no auth. PostgreSQL and inspection bind locally. Auto-select development ports; explicit occupied ports fail. Production never silently changes its configured/default port.

Invalid reload retains the last valid application and diagnostics. Changed incompatible schema blocks affected database authority. Server replacement/ordinary stop stops new work and drains for 30 seconds; report unknown submitted outcomes, never replay. Crashed processes require explicit restart with logs retained, not infinite restart. Stop dev PostgreSQL too; preserve its volume/backups. Cleanup removes only owned disposable files/containers unless data/backup deletion is separately authorized.

Build emits immutable server/client bundles, island/route manifests, schema/migration metadata, exact runtime dependency contents, local documentation and execution-container metadata. Include no secrets, machine configuration, development volumes/logs or external caches. Startup performs no package install/image build; required execution images must be preflighted/pinned and any missing acquisition explicitly reported rather than hidden.

For each supported target architecture, the artifact contains the restricted execution OCI image archive and its digest, plus the Bun supervisor entrypoint/dependencies. Start verifies the local archive and imports/reuses only that exact owned image through Docker; no network image pull, package installation or image build is required. Missing/corrupt/unsupported archives fail before application execution. The developer supplies compatible Bun and Docker themselves; those machine tools are not embedded in the application artifact. PostgreSQL remains separately configured.

Production `start` requires compatible Bun, local Docker isolation readiness and configured PostgreSQL. It may own app execution containers, not the production database. Check pin/artifact compatibility, drift, pending migrations and uncertain maintenance before ready. Secrets enter only the trusted server broker via startup environment; required missing values block readiness. Explicit public configuration alone enters browser output.

Exclude dev inspection HTTP endpoints from production. Health exposes availability only; logs are server-side and redacted. CLI database inspection requires explicit configured credentials. Production default application port is 3000, bind 127.0.0.1 unless specified. Development starts allocation at 3000 and reports actual address. Database credentials/ports are local runtime state, not tracked defaults.

## Command and machine-output contract

The following grammar is the target catalog, not an existing CLI. Common options are `--project <dir>`, `--json`, `--timeout <seconds>`, and `--help`. Reject unknown flags/commands with exit 2; do not execute arbitrary shell arguments.

| Operation | Grammar and essential options |
| --- | --- |
| Creation | `new <dir> [--compiler microsoft|rust-experimental] [--no-git]`; `init [--compiler ...] [--no-git]` |
| Description | `explain`; `docs [<topic>]`; `docs refresh [--preview]` |
| Prerequisites | `doctor`; `setup [--grant <id>]`; `setup grants list`; `setup grants revoke <id>` |
| Development | `dev [--background] [--host <address>] [--port <number>]` |
| Runtime | `stop`; `status`; `logs [--limit 200] [--cursor <token>] [--follow]` |
| Inspection/export | `db inspect [--table <name>] [--limit 100] [--cursor <token>] [--export <file>]` |
| Development SQL | `db query (--sql <text> | --sql-file <path>) [--param <text>]... [--limit 100]` |
| Seed/backup | `db seed`; `db backup --out <file>` |
| Restore/reset | `db restore --from <file> [--grant <id>]`; `db reset [--seed] [--grant <id>]` |
| Migrations | `db migration generate`; `db migration plan`; `db migration apply [--grant <id>]`; `db migration status` |
| Recovery | `db recover --inspect`; explicit reviewed rollback/restore follows the corresponding operation rather than a force-clear flag |
| Verification | `test [--suite unit|database|browser] [--filter <name-or-path>]`; `types`; `lint`; `build`; `verify` |
| Production | `start --artifact <dir> [--host <address>] [--port <number>]` |
| Compatibility | `upgrade --to <exact-version> [--preview]` |

Inspect/export are read-only named operations; never arbitrary SQL. The only exception is the development-only `db query` (see Development read-only SQL). `db inspect` without `--table` returns the schema overview, and `status` includes database health (see Schema inspection and database health). `db recover --inspect` reports actual state/actions but does not silently clear a maintenance marker. Grants are established through an interactive human confirmation workflow, never generic `--yes`. Destructive approval identifies target and migration/restore contents. Public CLI options cannot manufacture or broaden grants noninteractively.

Noninteractive commands return promptly if authority/human action is missing. Default readiness timeout is 60 seconds; explicit options adjust waits. Snapshot logs/inspection are bounded and expose truncation/cursors; follow is opt-in. Exports write to an explicit destination with completion/integrity metadata, not unbounded stdout. Project creation preflights collisions, preserves README/LICENSE/hidden files/user instructions, marks generated sections and never nests Git or commits automatically. Roll back only newly created files and modified generated guidance on partial failure; report incomplete restoration.

### JSON version 1

Ordinary results are one stdout JSON object. Diagnostic logs use stderr. Finite commands always include `formatVersion`, `command`, `ok`, `data`, `error`, and `truncated`. Error is null on success; otherwise it has stable `code`, safe `message`, optional field errors, expected/actual details and structured `actions`. Data is null on failure unless explicitly documented diagnostic partial data is present. Do not place secrets in actions or URLs.

```json
{"formatVersion":1,"command":"status","ok":true,
 "data":{"state":"failed","ready":false},"error":null,"truncated":false}
```

Long-running commands emit newline-delimited events with `formatVersion: 1`, `command`, monotonic `sequence`, `event`, and `data`. Events include starting, ready, state, log-result, human-action-required and completed. A final completed event includes the result/exit category; external termination is distinguishable from successful completion. Streaming diagnostic logs still use stderr. Machine log-result events are explicitly requested, bounded/redacted payloads.

Exit codes: 0 command succeeded; 1 failed; 2 invalid invocation; 3 human authority/action required; 4 environment unavailable/incompatible/not ready; 5 contention/drift/recovery blocking. Successful inspection of a failed app is exit 0. Graceful user stop is completion, not application failure; unexpected crash is failure. Preserve standard signal-derived exit status when force-terminated.

Stable code families include `ARGUMENT_INVALID`, `AUTHORITY_REQUIRED`, `HUMAN_ACTION_REQUIRED`, `VERSION_MISMATCH`, `PREREQUISITE_UNAVAILABLE`, `DATABASE_UNAVAILABLE`, `DATABASE_PRIVILEGE_INSUFFICIENT`, `DATABASE_QUERY_REJECTED`, `READINESS_TIMEOUT`, `MAINTENANCE_BUSY`, `SCHEMA_DRIFT`, `RECOVERY_REQUIRED`, `SOURCE_REJECTED`, `CONFIGURATION_MISSING`, `QUERY_LIMIT`, `QUERY_TIMEOUT`, `RESULT_TOO_LARGE`, `RETRIEVAL_DESTINATION_DENIED`, `RETRIEVAL_REDIRECT_DENIED`, `RETRIEVAL_TIMEOUT`, `RETRIEVAL_HTTP_FAILURE`, `RETRIEVAL_INVALID_OUTPUT`, `INTERNAL_FAILURE`. Application validation/record/version errors follow the operation schemas. Release code catalogs must map each to its exit and recovery action.

Breaking machine format changes require a new formatVersion. Compatible new fields are allowed; consumers ignore unknown fields and reject unsupported versions. Human text may change without changing stable semantics.

## Documentation and generated skill

One versioned operation catalog generates help, machine schemas and local docs. Check separately authored examples against it. Every behavior change updates docs, examples and generated guidance in the same PR. Pinned-version core docs work offline.

`docs refresh` updates unchanged generated sections and Fleur-owned skill content for the pin, preserving user content. Edited generated content requires preview and explicit replacement choice. Doctor reports mismatch; verification fails until resolved while read-only diagnostics remain available. Refresh never changes the pin or installs packages. The [Fleur TDD reference](../../.agents/skills/fleur-tdd/SKILL.md) is copied/tailored to configured project tooling and referenced by both instruction files.

Recovery examples must state symptom, diagnostic, needed authority, recovery operation and resulting-state proof. Use synthetic redacted fixtures and real disposable environments. Test setup interruption via doctor/setup grants/setup, lifecycle via status/logs and explicit dev/start, invalid reload via source correction, database recovery via migration status/inspection/confirmed restore, and reactive failures through stale/reconnect/unknown state. Never invent automatic replay or treat an exit code alone as proof.

## Workout acceptance fixture

Exercise names trim surrounding whitespace, have 1–100 Unicode code points, preserve display case, and use a stored normalized uniqueness key generated by a release-pinned Unicode case-folding implementation. Use the identical function in server normalization and database uniqueness checks; do not depend on the host's locale. Current template foreign-key references restrict exercise deletion. Historical snapshots are independent.

Templates have a trimmed 1–100-code-point name and at least one ordered exercise entry. Names need not be unique unless an application explicitly declares that rule. Entries may repeat exercises; target sets/repetitions are positive safe integers. The aggregate template version advances atomically for header or child/order edits so competing saves cannot overwrite children silently.

Sessions have a validated LocalDate, at least one snapshotted exercise and at least one completed set per exercise. They may differ from or omit a source template. Snapshot names/order/sets/repetitions/weight/unit. Later exercise/template edits or deletion cannot rewrite history. Session updates/deletes use an aggregate expected version and atomic child writes.

Weight is omitted or supplied as an exact nonnegative decimal string plus `kg`/`lb`, at most two decimal places. Omission requires unit omission; a supplied weight requires a supported unit. Zero is explicit data. Reject negative/exponent/nonfinite/excess-precision input instead of rounding; normalize leading/trailing decimal zeroes without numeric conversion, preserving the unit. Units never convert automatically.

Proof covers valid saves, malformed fields/dates/precision/undeclared fields, atomic rollback from child/output failure, two writers with one winning expected version, referential conflicts, unchanged snapshots after edits/deletion, two-view/server-content updates, draft/focus preservation, reconnect/out-of-order/missed-publication recovery, unknown mutation outcomes with no replay, persistent data after restart and full production artifact operation.

## Verification and reference performance

Use Bun tests, real disposable PostgreSQL, Playwright, oxlint and remaining ESLint rules, and positive/negative type fixtures. Microsoft TypeScript is the default. Experimental tsc-rs requires exact package/upstream pins and equivalence gates before it is offered as supported. No silent compiler fallback. Linter type engines are separate; TypeScript 7 compatibility cannot be inferred from a TypeScript 6-based ESLint analyzer.

`test` runs the whole applicable suite unless a subset is explicit. `verify` runs tests/types/full lint/build. Release/CI also starts the packed CLI and the production artifact in isolated environments, without relying on source dependencies/caches. Runtime checks cover required Intel macOS and Ubuntu 24.04/26.04 amd64 and Debian 13 amd64 targets; main Chromium two-view tests use Linux and a smaller macOS smoke suite. Verify each claimed exact tuple before platform claims. Existing GitHub ARM checks, useful Arch/ARM fixtures and historical reports remain coverage; their results do not require full deferred-platform qualification or imply full support. Preserve all assertions, isolation, authority, resource enforcement, preservation, recovery, repeats, deadlines and disposal requirements for required targets. Required CI checks must still pass. If browser testing requires Node, doctor/docs report it; ordinary runtime remains Bun-only. No silent Node/browser dependency installation.

TDD is the default for meaningful testable behavior and mandatory for critical contracts/regressions. Demonstrate intended red failure before implementation, minimal green behavior, and verification after refactoring. Never edit a UI component/test in one tool execution step. Timing/network-sensitive tests run at least twice. Proportionate checks apply to documentation/purely visual/exploratory work. Independent review is mandatory for substantial features, database/security contracts and major refactoring; it may add independent tests but never silently changes production code or accepted assertions. Fix and verify its defects before merge.

### Reference performance procedure

Use 500 exercises, 100 templates and 10,000 sessions with up to 50 sets each; five views with ten logical queries each. Reference queries are five 100-row ordered/indexed catalog/history lists and five indexed detail queries per view, with distinct keys chosen by the fixture. Stable indexes and fixture SQL are versioned with the benchmark. One commit/second sustained and ten submitted mutations/second bursts include valid competing-version failures as separate correctness scenarios, not falsely counted as successful commits.

Reference machine has at least four CPU cores, 16 GiB RAM and SSD. Freeze and report the actual OS/CPU, Docker allocation, image digest, browser and runtime/compiler/tool pins. Use local PostgreSQL and a production build without unrelated heavy work; document warmup and cache state. Minimum specs alone are not a universal guarantee for every machine.

| Warm operation | p95 target |
| --- | --- |
| Query request until validated current content is rendered | 500 ms |
| Mutation submission until confirmed commit response | 500 ms |
| Commit until another view renders current content | 1 second |
| Connection restored until all active content is current | 2 seconds |
| Dropped notification's commit until current rendered recovery | 5 seconds |

After a ten-commit burst all subscribed views show final state within two seconds of the last commit. Each scenario runs three times, with at least 100 samples/run. Use nearest-rank p95; record errors/timeouts as failures and infinite latency rather than removing them. Any correctness failure fails the scenario; any unexpected operation failure fails its run even if p95 could tolerate it. Each run must independently pass. No averaging away failures/outliers.

Correlate server commit and browser observations through test-controlled identifiers and monotonic clocks, documenting clock synchronization/measurement error; do not subtract unrelated wall clocks. Query deadlines include scheduling/queueing and execution. Enforce result cap on encoded UTF-8 public JSON before delivery, not row count alone. Isolate a deliberately slow/oversized query from healthy subscriptions. Measure external retrieval separately against a controlled local fixture, respecting explicit local-service allowance; exclude real provider latency, downloads and Docker startup from these warm database budgets. Report cold startup separately.

## Foundation pins and implementation sequence

[Verification research](../../research/verification-tooling.md) records exact candidate package versions and inspected entrypoints. They are not a tested lockfile or verified release matrix. [Rendering research](../../research/server-rendering-capabilities.md) records the chosen direction and seccomp/broker feasibility obligation.

1. **Authorized disposable compatibility experiments first.** Prove Bun/Preact rendering/islands/draft-preserving refresh, restricted execution plus broker IPC, internal Zod/tRPC/Drizzle/Bun SQL compatibility, compiler/lint engines, Playwright launch and supported platforms. Obtain immutable artifact/image pins and record failures. If a required mechanism cannot satisfy the contract, stop dependent work and return the affected decision to live discussion. Do not silently weaken requirements.
2. **Contract types and validators.** Implement schemas/wire values, typed table/operation/page references and compiler fixtures with requirements-first tests.
3. **Restricted operations and database integrity.** Build trusted broker, query snapshots, mutation atomicity/version checks, secret boundaries and negative capability tests.
4. **Persistent lifecycle and maintenance.** Implement project identity, setup/readiness, explicit backup/migration/seed/reset/recovery and crash/concurrency tests against disposable PostgreSQL.
5. **Server pages, islands and reactive delivery.** Implement manifests, rendering/hydration, dependency tracking, revision probes/epochs, stale/error/unknown states and two-view tests.
6. **External retrieval and assets.** Implement destination/address/credential policy, cache scope and limits with controlled fixtures and forbidden-browser transport tests.
7. **Commands, packaging and documentation.** Supply catalog/JSON/exits, generated TDD guidance, protected-file checks, artifact startup and recovery examples.
8. **Workout proof and release review.** Verify complete acceptance fixture, performance reference runs, platform/packed CLI/production gates, independent review and human release evidence.

Each substantial slice defines acceptance/failure tests before implementation and receives independent review. Gates report actual executed results and limitations. Selecting a candidate pin or writing a specification is never evidence that a compatibility gate passed.

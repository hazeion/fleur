# Inspecting data and verifying backups

Fleur supplies named inspection, backup, migration and recovery operations. They require the exact project pin and explicit private PostgreSQL configuration. They never accept SQL or shell arguments.

```sh
fleur status --json
fleur db inspect --json
fleur db inspect --table exercises --limit 100 --json
fleur db inspect --table exercises --cursor <cursor> --export exercises-page.json --json
fleur db backup --out before-migration.dump --json
fleur db recover --inspect --json
```

Set `FLEUR_PRIVATE_DATABASE_URL` in the trusted supervisor environment. `FLEUR_PRIVATE_CONTROL_DATABASE_URL` selects an existing control database in the same cluster, defaulting to `postgres` on the same endpoint. The control database must differ from the application database. Configure direct PostgreSQL server endpoints only. Transaction-pooling proxies are unsupported. Fleur verifies the server system identifier, database identity, backend address/port, session nonce across a transaction boundary, backend PID and exact session advisory lock. These checks detect switching or lost sessions; SQL observations cannot prove that an arbitrary intermediary is absent.

The authority the configured credentials need is described in [credential authority](#credential-authority). These credentials stay in the trusted host and PostgreSQL tool environment. Application workers and browser bundles never receive them. All Fleur supervisors and commands managing a target must share the same private durable state root. `FLEUR_PRIVATE_STATE_ROOT` explicitly selects it; the default is the user's local Fleur state directory. Keep this directory outside the replaceable database and preserve it across restarts. Do not delete it to bypass recovery.

The namespace binds the verified PostgreSQL cluster system identifier and project database name. The marker also binds database OID and owner, so replacing the database cannot silently reopen an older binding. Changing the control database or state root while a target is in use is unsupported configuration, not a recovery operation.

## Credential authority

Fleur uses the configured credential for every operation and never rejects a broader one. Operators may instead supply a credential limited to the **minimum-privilege profile**, which is enough for the read-only operations: the schema overview and `db inspect --table`, `db migration status` and `status` database health. Fleur-generated inspection SQL always runs inside a host-opened `READ ONLY` transaction, whatever the credential allows.

| Capability | Privileges | Needed by |
| --- | --- | --- |
| `database connect` | `CONNECT` on the application and control databases | every database operation |
| `identity inspection` | `EXECUTE` on `pg_control_system()` in the application and control databases | every database operation |
| `maintenance locks` | `EXECUTE` on PostgreSQL's advisory lock functions in the control and application databases | every database operation |
| `schema read` | `USAGE` on `public` and `fleur_internal` and `SELECT` on their tables; backup, apply, seed, restore and reset also read every user schema, table and sequence | every database operation |
| `role and database creation` | superuser, or `CREATEROLE` and `CREATEDB` with `createrole_self_grant` including `set` and `inherit`, so Fleur can create, verify and remove its disposable backup verification role and database | `db backup`, `db migration apply`, `db restore`, `db reset` |
| `schema write` | `CREATE` on the application database and on its `public` and `fleur_internal` schemas, and ownership of their tables and functions | `db migration apply`, `db seed`, `db restore`, `db reset` |
| `database replacement` | ownership of the application database and its schemas | `db restore`, `db reset` |

The first four rows are the profile. A minimal profile grant, run by the database owner or a superuser, looks like this; replace the placeholders with your role and database names. The schema statements need `fleur_internal` to exist, so run them after the first `db migration apply`:

```sql
GRANT CONNECT ON DATABASE <application_database>, <control_database> TO <role>;
-- In the application database:
GRANT USAGE ON SCHEMA public, fleur_internal TO <role>;
GRANT SELECT ON ALL TABLES IN SCHEMA public, fleur_internal TO <role>;
ALTER DEFAULT PRIVILEGES FOR ROLE <migrating_role> IN SCHEMA public, fleur_internal GRANT SELECT ON TABLES TO <role>;
```

PostgreSQL grants `PUBLIC` `CONNECT` on databases and `EXECUTE` on `pg_control_system()` and the advisory lock functions by default. If those defaults were revoked, grant them to the role explicitly, in each database for the functions. The default privileges keep tables created by later migrations readable.

A command whose credential lacks a capability it needs returns `DATABASE_PRIVILEGE_INSUFFICIENT` with exit 4 before it changes anything. Backup, apply, seed, restore and reset check their extra authority through PostgreSQL's privilege functions before any approval prompt, backup, maintenance stage or schema change, so the refusal leaves nothing to recover. The error's `expected.capability` names the missing category from the table above, and its action points here. It never names the role, host, port or URL. Under the minimum-privilege profile, `db backup`, `db migration apply`, `db restore` and `db reset` report `role and database creation`, and `db seed` reports `schema write`; `db migration apply` with nothing pending needs no extra authority and reports no applied migrations.

## Schema overview and database health

`db inspect` without `--table` returns the schema overview of application base tables in `public`, ordered by name. It never returns rows. Each table reports:

- columns with PostgreSQL type, Fleur column kind, nullability, default and identity
- primary key
- foreign keys with their `onDelete` actions
- unique constraints, and the remaining indexes with their key columns; Fleur's case-folded uniqueness indexes are marked `caseFolded`, and declared non-unique indexes report `unique: false` with each key's direction in their definition
- whether the table is versioned

Fleur column kinds, versioning and managed columns, such as the version field and generated identifiers, come from the declarations recorded with the last applied migration. Tables outside those declarations report `null` for kind and versioning. Fleur's own metadata lives in `fleur_internal` and is excluded. The overview pages by table: `--limit` defaults to 100 and admits 1–500. The encoded page also stays below the byte cap shared with row pages. A page that stops early reports `truncated` and an opaque cursor that resumes after its last table. `--table <name>` adds that table's structure, in the same form, to its page of rows.

`db migration status` is the one computation of migration state. It reports applied and pending migration IDs, drift and the maintenance stage. Drift is a list of at most 100 differences and at most 768 KiB encoded, each with the object, the expected definition and the actual definition. `differencesTruncated` and the envelope's `truncated` report a list cut at either bound; `differenceCount` in the summary always counts every difference. Expected definitions come from the recorded declarations and history. Column types, collations, nullability and identity, primary and foreign keys, unique indexes, declared indexes with their key order, directions and null ordering, Fleur's check constraints, unexpected tables, constraints and indexes, migration checksums and the external maintenance record are compared individually. Any other catalog change, such as a changed default, trigger or function, appears as one catalog fingerprint difference. `db inspect` and `status` embed the same summary: `compatible`, `applied`, `pending`, `drift`, `differenceCount` and `maintenance` with its `state` (`idle`, `active` or `recovery required`) and recorded `stage`.

`status` reports application state, readiness reasons and a `database` object whether or not the application is running. The object has `connectivity` (`connected`, `unreachable` with `failure` of `refused`, `rejected` or `timeout`, or `unknown` when a local prerequisite stopped the probe), the target, the `maintenance` state and stage from Fleur's control record, and the migration summary. When the target is unreachable but the control record shows active maintenance or interrupted recovery, for example while a restore or reset has replaced the database, the reason is `MAINTENANCE_ACTIVE` or `RECOVERY_REQUIRED` rather than `DATABASE_UNAVAILABLE`. A local prerequisite failure, such as an unusable private state directory, is the `PREREQUISITE_UNAVAILABLE` reason with an action that points to `doctor`. A control database that identifies a different cluster than the target is `CONFIGURATION_MISSING` with exit 4. The development lifecycle is not in this release, so the development `state` is `stopped`. Production `state` is `null` because no production `start` can be registered yet. The database probe has its own 5-second deadline, replaced by an explicit `--timeout`. At the deadline, Fleur cancels the probe's statement in progress and reports `unreachable`. A statement that exceeds its 5-second statement timeout is the same timeout finding; `db inspect` and `db migration status` return it as `DATABASE_UNAVAILABLE`. `status` never runs prerequisite probes, and `doctor` never connects to the database.

Every result identifies the target by kind (`development` or `production`), database name, PostgreSQL server version and a non-reversible fingerprint of the verified cluster and database identity. No output from these commands shows the host, port, user or URL.

These diagnostics report drift, pending migrations, active maintenance, recovery state and an unreachable database as data with exit 0. Drift and maintenance never block them. `db inspect` and `db migration status` cannot produce a result from an unreachable database and return `DATABASE_UNAVAILABLE` with exit 4. A failed `db inspect --export` never publishes its file; Fleur publishes only after the inspection succeeds. Unreadable private maintenance state still returns `RECOVERY_REQUIRED`, exit 5, from those commands; `status` reports it as a reason. Normal application admission, startup, apply, seed and reset still refuse drift and pending migrations.

`status`, `db inspect` and `db migration status` default to the development target. `--production` selects the production target and adds no authority. Both targets read the explicit `FLEUR_PRIVATE_DATABASE_URL` configuration that the runtime broker uses. When the trusted lifecycle environment supplies a development binding through `FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL`, that binding is never a production target, and a different configured database is not the development target. Missing or mismatched configuration returns `CONFIGURATION_MISSING` with exit 4. Until `fleur dev` supplies the binding, the configured database counts as the development target unless `--production` is given.

All three run only Fleur-generated statements in a host-opened `REPEATABLE READ READ ONLY` transaction on the target. PostgreSQL itself refuses writes in that transaction (SQLSTATE 25006) and refuses to make it read-write after its first query. Before reading, they verify that the target connection reaches the cluster, database and endpoint identified through the control database.

## Inspection and export

`--table` selects a base table with a primary key. Inspection uses a read-only transaction, defaults to 100 rows and permits 1–500. Overview pages and rows return an opaque authenticated cursor when truncated. Row cursors bind target identity, table and column metadata. Cursor contents are compressed before authenticated encryption. Decoding bounds expansion to 1 MiB; tokens are limited to 16 KiB. A continuation that cannot fit fails explicitly with RESULT_TOO_LARGE rather than returning an unusable cursor. Tampered or incompatible cursors fail. Rows use native primary-key ordering and return column values as exact strings or null, preserving PostgreSQL numeric precision. Each invocation reads one consistent snapshot. A cursor continues a live listing in a later invocation; it is not a historical snapshot across invocations.

The complete encoded page is bounded below 1 MiB, including column metadata and cursor. A row that cannot fit fails with `RESULT_TOO_LARGE`; Fleur does not print a partial row. Uniquely named application columns remain ordinary data.

`--export` writes that bounded page to the explicit destination, including its continuation cursor and truncation state. It returns an empty stdout row array, or an empty table array for the overview, plus destination, byte count, SHA-256 and completion metadata. Continue using the returned cursor for additional pages. Existing files and symlinks are never overwritten. Export is data inspection, not a recoverable PostgreSQL backup.

## Maintenance ownership and verification

Application admission holds a shared session advisory lock on the independent control database. Maintenance uses the exclusive counterpart. It waits up to four seconds for in-flight application operations to drain; while it waits, new application admissions are refused and active views report maintenance. Competing maintenance, or application work that does not drain in time, returns `MAINTENANCE_BUSY`, exit 5, before changing data. Application transactions also hold a shared transaction fence in their own database. Backup holds the exclusive target fence until its durable completion stage. This supplemental fence prevents a lost control socket from admitting overlapping writes. It is not the replacement/reset ownership lock.

Startup, server rendering, reads and mutations check the same control authority and external maintenance marker. Backup excludes new operations, verifies active connections and prepared transactions have drained, and captures a repeatable-read snapshot. Idle unrelated SQL sessions are not terminated. As agreed in the [maintenance contract](https://github.com/hazeion/fleur/issues/7#issuecomment-6140996588), coordination covers Fleur operations, not arbitrary external SQL clients. External writers must be stopped separately.

`db backup` requires host `pg_dump` and `pg_restore` compatible with the target server. Missing tools fail without installing anything. `FLEUR_PRIVATE_PG_TOOLS` can select a trusted private tool directory; it is not an application capability. PostgreSQL's [dump](https://www.postgresql.org/docs/18/app-pgdump.html) and [restore](https://www.postgresql.org/docs/18/app-pgrestore.html) tools define the archive format and restoration options.

Fleur creates a custom PostgreSQL archive from the exported snapshot. It restores the archive completely, with error-stop and one transaction, into a new uniquely named database owned by a new unprivileged login role. Source development/production targets are never accepted as verification destinations. The generated destination is checked against the source and its expected database OID, role and privileges before restore. The archive retains source ownership/ACL metadata; verification restores under the disposable owner without replaying source ownership or grants.

Verification compares normalized schema dumps, every table's complete row multiset, sequence values and called state, large objects and Fleur metadata/history. Duplicate rows count. Schema comparison includes constraints, indexes and definitions. Foreign tables are rejected because their external contents cannot be verified as local database data. Unsupported privileged restore objects fail rather than gaining superuser authority. A fresh post-backup check verifies the original schema/data remained unchanged. Archive bytes are hashed before and after restoration.

Cleanup checks cluster-scoped database/role identities and ownership tags before non-force deletion, then proves absence. It never targets an unrelated project. Only after verification and cleanup does Fleur publish the archive and its `.manifest.json`, with SHA-256, byte count, schema/data digests, plan checksum and completion evidence. Publication refuses collisions and preserves both unrelated files and retained evidence. Verified backups remain until deliberately deleted.

## Interrupted work

Fleur fsyncs external stages and the state directory. Records include target identity, exact backup reference, plan checksum, epoch and disposable verification identity. Stages distinguish preparing, backup verified, applying, committed, rollback verified and recovery required. Migration and restore also use applying and rollback verified, with recorded before/after catalog, data and history evidence.

If verification or cleanup fails after preparation, normal admission remains blocked. Closing or killing the owner releases its advisory lock but never clears the durable marker. `db recover --inspect` remains read-only, including while another owner holds maintenance. It reports the target, current marker, up to 200 durable stage log entries with explicit log truncation, and live contention without replaying work or force-clearing state. Browser navigation reports maintenance with HTTP 503; mutations return a structured maintenance error without automatic retry.

For an interrupted backup, inspect the recorded exact archive reference and disposable identities. Preserve those files and the marker. A successful status result proves only that inspection succeeded. Use the reviewed reconciliation and restore procedures below; inspection cannot claim that an uncertain database is ready.

## Result and exit contracts

All commands use the version 1 JSON envelope and global `--timeout`, `--project`, `--help` and `--json` options. `truncated` appears in both the inspection page and envelope. Invalid grammar/cursors use exit 2. Missing configuration, tools or control authority use exit 4, as do `DATABASE_UNAVAILABLE` when inspection cannot reach the database and `DATABASE_PRIVILEGE_INSUFFICIENT` when the credential lacks a [capability](#credential-authority) the command needs. Maintenance contention or uncertain recovery uses exit 5. Oversized inspection results, restore/integrity failures and destination collisions fail with exit 1. Failures never return a success manifest or expose connection credentials.

## Reviewed migrations

```sh
fleur db migration generate --json
fleur db migration plan --json
fleur db migration status --json
fleur db migration apply --json
fleur db restore --from before-change.dump
```

Generation compiles admitted server table declarations and registers them inside the restricted worker. It needs Bun and Docker for that explicit compilation step, but no database configuration or connection. It writes numbered `migrations/0001.json` artifacts containing SQL, the declaration snapshot, the preceding checksum and structured removal, incompatibility and required-backfill lists. Review and commit these files with the application. Generation uses the preceding saved snapshot and never changes the target database. An unchanged snapshot produces no new file.

Plans admit only SQL emitted by Fleur's declaration compiler. Altered SQL, reordered history, changed checksums and nontransactional additions such as concurrent indexes are rejected. Additions with nullable columns or declared defaults preserve existing rows. Adding or removing a declared index changes no rows and needs no approval. Any snapshot change, including adding one index, drops and recreates every table's constraints and indexes in the migration's transaction, so at the reference scale a small declaration change rebuilds every index and revalidates every foreign key. Supported decimal widening preserves scale; unsupported type/identity/versioning changes and additions that need an explicit backfill are reported and refused. Resolve these declarations in an unapplied plan before proceeding. Do not remove or edit an applied file. Removing columns or tables requires separate human approval.

`db migration plan` reads the complete artifact chain offline. `db migration status` compares it with actual history and normalized PostgreSQL catalogs and reports differences as data; see [schema overview and database health](#schema-overview-and-database-health). Comparison includes relations, columns, constraints, indexes, functions, enum/domain/range types, defaults, collations, sequence definitions, triggers and policies. The `fleur_internal` schema contains Fleur's migration metadata and is excluded from application catalog fingerprints. History checksums/order are verified separately. The external maintenance record also retains the expected catalog/history, so erasing database metadata does not bypass drift checks. Normal admission rejects drift; there is no push, automatic reset or history rewrite.

Apply holds exclusive control-database ownership and the target fence through draining, backup verification and the schema transaction. SQL and ordered history commit together. The verified backup remains in private state. Applied SQL must match the reviewed artifact chain. A confirmed rollback requires proof that original schema and data remain unchanged. An uncertain commit keeps normal access blocked. Every completed maintenance resumption receives a new external epoch.

## Approval and restore

Destructive apply and restore require a human at an interactive terminal. The prompt identifies the verified cluster/database and exact plan checksum. Restore also identifies the backup and says that it replaces current data. JSON invocation returns `AUTHORITY_REQUIRED`, exit 3, without creating authority. There is no generic `--yes`. `--grant <id>` can consume only an existing unconsumed private grant matching the exact operation, target and observed database state. Human approval creates a single-use receipt. Changed plans, changed data, consumed receipts and unknown IDs cannot reuse approval. These grants are host maintenance authority, never application capabilities.

Restore additionally requires a compatible host `psql`, alongside `pg_dump` and `pg_restore`. Missing tools fail without installation. Fleur freezes the selected archive bytes, checks its private manifest and re-verifies restoration into a new unprivileged disposable database. It retains another verified backup of the current target before replacement, including post-backup changes. Earlier format-version-1 manifests remain usable: Fleur derives missing catalog/history metadata through the disposable restore and verifies the original schema, complete data and archive hashes. Before replacing a prior interrupted marker, it also verifies cleanup of that marker's owned disposable database and role. Unsafe or active resources keep recovery blocked. PostgreSQL executes schema removal and archive restoration in one transaction through `psql`, with error-stop and no user startup file. Extra current objects disappear only after explicit replacement approval. Schema, complete data and history must match before the external marker becomes committed. An older restored schema reports pending migrations; application declarations must match before access resumes.

## Recovering an interrupted migration or restore

If an operation ends without a confirmed result, preserve its marker, backups and verification identities. Run `fleur db recover --inspect --json`. Inspection reports actual catalog/data fingerprints and ordered history, plus `committed`, `rollback verified`, `uncertain` or `in-progress`. It never clears the marker or repeats work. A missing target or unreadable history remains uncertain.

After reviewing that evidence, rerun the corresponding `db migration apply` or `db restore --from <file>` interactively. For an uncertain recorded operation, that invocation requests fresh approval to reconcile the observed result. It only records a proven commit or rollback and advances the epoch; it does not replay the migration or restoration in that invocation. A later explicit apply can execute still-pending migrations. Cleanup of interrupted verification resources checks ownership tags and identities and never force-removes another database or role. If actual schema, data or history matches neither recorded outcome, recovery stays blocked. Choose an explicitly confirmed retained backup or investigate the discrepancy; do not delete the state directory.

For example, an interrupted apply whose transaction rolled back still reports `applying` in the durable marker. Inspection proves the original schema/data/history. Approved reconciliation records `rollback verified`, and a fresh inspection plus migration status proves that the original data remains and the migration is pending. An interrupted commit can instead match the complete new history and catalog. Reconciliation records that existing commit without running its SQL again. An inspection exit code alone is not proof of either outcome.

`SCHEMA_DRIFT`, `MIGRATION_EDITED`, `MIGRATIONS_PENDING` and uncertain recovery block apply, seed, reset and application admission with exit 5. `db migration status`, `db inspect` and `status` report the same conditions as exit-0 data. `MIGRATION_INCOMPATIBLE` reports an unsupported/backfill-requiring plan with exit 1. Approval uses exit 3; unavailable configuration/tools use exit 4. Other verification failures use exit 1. All results retain the version 1 JSON envelope and safe recovery actions.

## Owned seeds and development reset

`fleur db seed` reads exported `defineSeed` declarations from `seeds/` and server
modules through the restricted registration worker. Seed modules have server
import authority. They cannot execute shell commands, supply SQL, acquire database
credentials or receive a database connection. The trusted broker validates the
serialized declarations again before applying them.

```ts
import { defineSeed } from "fleur/database";
import { exercises } from "../server/tables";

export const catalog = defineSeed({
  key: "exercise-catalog",
  table: exercises,
  rows: [{ ownerKey: "squat", values: { id: 1, name: "Squat" } }],
});
```

Keys start with an ASCII letter or digit and contain up to 128 letters, digits,
periods, underscores, colons or hyphens. Row ownership keys are unique within a
seed. Values use the table's inferred insert type and runtime validation.
Generated identifiers may be omitted and are retained in ownership metadata.
`dependsOn: [parentSeed]` declares ordering when another seeded table supplies a
foreign-key parent. Export every dependency. Missing dependencies, cycles and
ambiguous ownership fail the whole run.

A successful result reports `inserted`, `updated` and `skipped` rows. An unchanged
owned row can update. A user-edited row is skipped with reason `user-edited`.
Versioned tables compare the last applied public row and version before an
expected-version write. Unversioned tables compare canonical public-row
fingerprints under locks. Repeating unchanged declarations does not advance a
row's version. Removing a declaration does not delete data.

Fleur stores ownership in `fleur_internal.seed_ownership` and installs
`public.fleur_seed_deleted_v1` with `fleur_seed_delete_v1` deletion triggers on
seeded tables. These are Fleur-owned maintenance objects. Their public catalog
definitions enter the stored catalog fingerprint. Managed deletes and foreign-key
cascades record tombstones in the same transaction. Missing rows are reconciled
before seeding. A deleted row is skipped with reason `deleted`; a recreated row
with that identity is a conflict. Seed metadata updates do not mark public rows
as edited. A later ownership or foreign-key failure rolls back all seed writes.

`fleur db reset [--seed] [--grant <id>]` is available only when the trusted
lifecycle environment explicitly supplies
`FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL` matching `FLEUR_PRIVATE_DATABASE_URL`.
Production database configuration must never supply that development binding.
The command accepts no public target override. An absent or different binding
returns authority category 3 before changing the target.

Reset requires human target/plan-specific approval and a retained backup that has
passed disposable restoration and integrity verification. Approval covers current
migration checksums, optional seed declarations and the current target state.
Changed migration contents invalidate it. JSON output never grants destructive
authority. The control-database lock remains held while the original database is
dropped and recreated with current migrations. Application admission and competing
maintenance remain blocked throughout. Reset leaves application tables empty
unless `--seed` is explicit. Requested seeding starts with fresh ownership.

If reset stops after replacement starts, read `db recover --inspect` and retain
the marker and backup. A repeated reset cannot clear the uncertainty or silently
repeat recreation. Inspect the actual database and backup before an explicitly
approved `db restore --from <retained-backup>`. Never delete the marker to force
startup. A missing replacement database remains fenced. Explicit restore can reconstruct
it only when the durable reset record binds that exact retained archive and the
original cluster, database and owner. It re-verifies the archive in a disposable
database before recreating the missing target.

## New development database initialization

`fleur dev` is not in this release. The shared-core startup step it will call
already exists, and this section describes the behavior that `dev` startup
gets from it. Until `dev` ships, apply migrations and seeds explicitly.

A **new development database** is one that Fleur created for a storage binding
and that has provably never been initialized. Before creating the database,
Fleur writes a durable private creation record in its state directory. The
record is bound to the cluster, database name, owner and storage binding, and
to the database OID once the database exists. At startup, initialization holds
the maintenance lock and proves newness again. The creation record must match
the database, and the catalog must contain no application relations, functions
or types and no `fleur_internal` metadata. Emptiness alone never qualifies.

A new development database receives the whole committed migration chain in one
transaction, followed by the declared seeds. The chain must pass the same
validation as `db migration plan`. A chain that contains removals is included,
because there is no data to remove. Initialization takes no backup and needs no
human approval. It records the expected catalog in the migration history and in
the maintenance record for drift detection. Startup then reports migrations
applied, seed rows applied and the resulting migration summary in human output
and JSON.

- **Failure.** A failing migration or seed rolls the whole transaction back.
  Startup reports `failed` with the error code, an exit category and one action,
  and never reports ready. The database stays new, so the next startup retries
  after the cause is corrected. If the outcome of the commit itself cannot be
  confirmed, startup reports `RECOVERY_REQUIRED` with `fleur dev` as its
  action. The next startup reads the outcome of the recorded transaction from
  PostgreSQL and never applies the chain twice.
- **Empty chain.** A new database stays new until a startup finds at least one
  committed migration. Initialization runs only at startup, never during reload.
- **Never new again.** After a successful initialization, the creation record
  is retired, so later migrations use `db migration apply` and later seeds use
  `db seed`. The record is also retired when startup finds that something else,
  such as an explicit apply, changed the database first. A database emptied
  afterwards is not new. If such a database disappears, startup creates an
  empty replacement that is not new and reports its readiness reasons, such as
  drift from Fleur's recorded catalog. A database that disappears before its
  first initialization is recreated as new.
- **Other databases.** Adopted volumes, another binding's database, a database
  Fleur did not create, a database that reset recreated, production targets and
  test or backup-verification databases have no matching creation record. They
  are never initialized automatically and keep the explicit flow. Reset keeps
  its approval, backup and `--seed` behavior. Production `start` never
  initializes.
- **Concurrency.** Two startups that race for the same binding serialize on the
  maintenance lock. One creates and initializes the database, and the other
  waits, finds it initialized and changes nothing. Startup also waits, within
  its deadline, for active maintenance to end before it reports readiness, and
  reports `maintenance` if it does not.

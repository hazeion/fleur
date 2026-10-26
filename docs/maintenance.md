# Inspecting data and verifying backups

Fleur supplies named inspection, backup, migration and recovery operations. They require the exact project pin and explicit private PostgreSQL configuration. They never accept SQL or shell arguments.

```sh
fleur db inspect --table exercises --limit 100 --json
fleur db inspect --table exercises --cursor <cursor> --export exercises-page.json --json
fleur db backup --out before-migration.dump --json
fleur db recover --inspect --json
```

Set `FLEUR_PRIVATE_DATABASE_URL` in the trusted supervisor environment. `FLEUR_PRIVATE_CONTROL_DATABASE_URL` selects an existing control database in the same cluster, defaulting to `postgres` on the same endpoint. The control database must differ from the application database. Configure direct PostgreSQL server endpoints only. Transaction-pooling proxies are unsupported. Fleur verifies the server system identifier, database identity, backend address/port, session nonce across a transaction boundary, backend PID and exact session advisory lock. These checks detect switching or lost sessions; SQL observations cannot prove that an arbitrary intermediary is absent.

The configured credentials need database identity inspection, including `pg_control_system()`. Backup authority additionally needs role/database creation and verified cleanup. These credentials stay in the trusted host and PostgreSQL tool environment. Application workers and browser bundles never receive them. All Fleur supervisors and commands managing a target must share the same private durable state root. `FLEUR_PRIVATE_STATE_ROOT` explicitly selects it; the default is the user's local Fleur state directory. Keep this directory outside the replaceable database and preserve it across restarts. Do not delete it to bypass recovery.

The namespace binds the verified PostgreSQL cluster system identifier and project database name. The marker also binds database OID and owner, so replacing the database cannot silently reopen an older binding. Changing the control database or state root while a target is in use is unsupported configuration, not a recovery operation.

## Inspection and export

`db inspect` lists application tables in `public`. `--table` selects a base table with a primary key. Inspection uses a read-only transaction, defaults to 100 rows and permits 1–500. Table lists and rows return an opaque authenticated cursor when truncated. Row cursors bind target identity, table and column metadata. Cursor contents are compressed before authenticated encryption. Decoding bounds expansion to 1 MiB; tokens are limited to 16 KiB. A continuation that cannot fit fails explicitly with RESULT_TOO_LARGE rather than returning an unusable cursor. Tampered or incompatible cursors fail. Rows use native primary-key ordering and return column values as exact strings or null, preserving PostgreSQL numeric precision. A cursor continues a live Read Committed listing; it is not a historical snapshot across invocations.

The complete encoded page is bounded below 1 MiB, including column metadata and cursor. A row that cannot fit fails with `RESULT_TOO_LARGE`; Fleur does not print a partial row. Uniquely named application columns remain ordinary data.

`--export` writes that bounded page to the explicit destination, including its continuation cursor and truncation state. It returns an empty stdout row array plus destination, byte count, SHA-256 and completion metadata. Continue using the returned cursor for additional pages. Existing files and symlinks are never overwritten. Export is data inspection, not a recoverable PostgreSQL backup.

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

All commands use the version 1 JSON envelope and global `--timeout`, `--project`, `--help` and `--json` options. `truncated` appears in both the inspection page and envelope. Invalid grammar/cursors use exit 2. Missing configuration, tools or control authority use exit 4. Maintenance contention or uncertain recovery uses exit 5. Oversized inspection results, restore/integrity failures and destination collisions fail with exit 1. Failures never return a success manifest or expose connection credentials.

## Reviewed migrations

```sh
fleur db migration generate --json
fleur db migration plan --json
fleur db migration status --json
fleur db migration apply --json
fleur db restore --from before-change.dump
```

Generation compiles admitted server table declarations and registers them inside the restricted worker. It needs Bun and Docker for that explicit compilation step, but no database configuration or connection. It writes numbered `migrations/0001.json` artifacts containing SQL, the declaration snapshot, the preceding checksum and structured removal, incompatibility and required-backfill lists. Review and commit these files with the application. Generation uses the preceding saved snapshot and never changes the target database. An unchanged snapshot produces no new file.

Plans admit only SQL emitted by Fleur's declaration compiler. Altered SQL, reordered history, changed checksums and nontransactional additions such as concurrent indexes are rejected. Additions with nullable columns or declared defaults preserve existing rows. Supported decimal widening preserves scale; unsupported type/identity/versioning changes and additions that need an explicit backfill are reported and refused. Resolve these declarations in an unapplied plan before proceeding. Do not remove or edit an applied file. Removing columns or tables requires separate human approval.

`db migration plan` reads the complete artifact chain offline. `db migration status` compares it with actual history and normalized PostgreSQL catalogs. Comparison includes relations, columns, constraints, indexes, functions, enum/domain/range types, defaults, collations, sequence definitions, triggers and policies. The `fleur_internal` schema contains Fleur's migration metadata and is excluded from application catalog fingerprints. History checksums/order are verified separately. The external maintenance record also retains the expected catalog/history, so erasing database metadata does not bypass drift checks. Normal admission rejects drift; there is no push, automatic reset or history rewrite.

Apply holds exclusive control-database ownership and the target fence through draining, backup verification and the schema transaction. SQL and ordered history commit together. The verified backup remains in private state. Applied SQL must match the reviewed artifact chain. A confirmed rollback requires proof that original schema and data remain unchanged. An uncertain commit keeps normal access blocked. Every completed maintenance resumption receives a new external epoch.

## Approval and restore

Destructive apply and restore require a human at an interactive terminal. The prompt identifies the verified cluster/database and exact plan checksum. Restore also identifies the backup and says that it replaces current data. JSON invocation returns `AUTHORITY_REQUIRED`, exit 3, without creating authority. There is no generic `--yes`. `--grant <id>` can consume only an existing unconsumed private grant matching the exact operation, target and observed database state. Human approval creates a single-use receipt. Changed plans, changed data, consumed receipts and unknown IDs cannot reuse approval. These grants are host maintenance authority, never application capabilities.

Restore additionally requires a compatible host `psql`, alongside `pg_dump` and `pg_restore`. Missing tools fail without installation. Fleur freezes the selected archive bytes, checks its private manifest and re-verifies restoration into a new unprivileged disposable database. It retains another verified backup of the current target before replacement, including post-backup changes. Earlier format-version-1 manifests remain usable: Fleur derives missing catalog/history metadata through the disposable restore and verifies the original schema, complete data and archive hashes. Before replacing a prior interrupted marker, it also verifies cleanup of that marker's owned disposable database and role. Unsafe or active resources keep recovery blocked. PostgreSQL executes schema removal and archive restoration in one transaction through `psql`, with error-stop and no user startup file. Extra current objects disappear only after explicit replacement approval. Schema, complete data and history must match before the external marker becomes committed. An older restored schema reports pending migrations; application declarations must match before access resumes.

## Recovering an interrupted migration or restore

If an operation ends without a confirmed result, preserve its marker, backups and verification identities. Run `fleur db recover --inspect --json`. Inspection reports actual catalog/data fingerprints and ordered history, plus `committed`, `rollback verified`, `uncertain` or `in-progress`. It never clears the marker or repeats work. A missing target or unreadable history remains uncertain.

After reviewing that evidence, rerun the corresponding `db migration apply` or `db restore --from <file>` interactively. For an uncertain recorded operation, that invocation requests fresh approval to reconcile the observed result. It only records a proven commit or rollback and advances the epoch; it does not replay the migration or restoration in that invocation. A later explicit apply can execute still-pending migrations. Cleanup of interrupted verification resources checks ownership tags and identities and never force-removes another database or role. If actual schema, data or history matches neither recorded outcome, recovery stays blocked. Choose an explicitly confirmed retained backup or investigate the discrepancy; do not delete the state directory.

For example, an interrupted apply whose transaction rolled back still reports `applying` in the durable marker. Inspection proves the original schema/data/history. Approved reconciliation records `rollback verified`, and a fresh inspection plus migration status proves that the original data remains and the migration is pending. An interrupted commit can instead match the complete new history and catalog. Reconciliation records that existing commit without running its SQL again. An inspection exit code alone is not proof of either outcome.

`SCHEMA_DRIFT`, `MIGRATION_EDITED`, `MIGRATIONS_PENDING` and uncertain recovery block with exit 5. `MIGRATION_INCOMPATIBLE` reports an unsupported/backfill-requiring plan with exit 1. Approval uses exit 3; unavailable configuration/tools use exit 4. Other verification failures use exit 1. All results retain the version 1 JSON envelope and safe recovery actions.

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

# Inspecting data and verifying backups

Fleur supplies three named database operations. They require the exact project pin and explicit private PostgreSQL configuration. They never accept SQL or shell arguments.

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

Application admission holds a shared session advisory lock on the independent control database. Maintenance uses the exclusive counterpart and competing maintenance returns `MAINTENANCE_BUSY`, exit 5, before changing data. Application transactions also hold a shared transaction fence in their own database. Backup holds the exclusive target fence until its durable completion stage. This supplemental fence prevents a lost control socket from admitting overlapping writes. It is not the replacement/reset ownership lock.

Startup, server rendering, reads and mutations check the same control authority and external maintenance marker. Backup excludes new operations, verifies active connections and prepared transactions have drained, and captures a repeatable-read snapshot. Idle unrelated SQL sessions are not terminated. As agreed in the [maintenance contract](https://github.com/hazeion/fleur/issues/7#issuecomment-6140996588), coordination covers Fleur operations, not arbitrary external SQL clients. External writers must be stopped separately.

`db backup` requires host `pg_dump` and `pg_restore` compatible with the target server. Missing tools fail without installing anything. `FLEUR_PRIVATE_PG_TOOLS` can select a trusted private tool directory; it is not an application capability. PostgreSQL's [dump](https://www.postgresql.org/docs/18/app-pgdump.html) and [restore](https://www.postgresql.org/docs/18/app-pgrestore.html) tools define the archive format and restoration options.

Fleur creates a custom PostgreSQL archive from the exported snapshot. It restores the archive completely, with error-stop and one transaction, into a new uniquely named database owned by a new unprivileged login role. Source development/production targets are never accepted as verification destinations. The generated destination is checked against the source and its expected database OID, role and privileges before restore. The archive retains source ownership/ACL metadata; verification restores under the disposable owner without replaying source ownership or grants.

Verification compares normalized schema dumps, every table's complete row multiset, sequence values and called state, large objects and Fleur metadata/history. Duplicate rows count. Schema comparison includes constraints, indexes and definitions. Foreign tables are rejected because their external contents cannot be verified as local database data. Unsupported privileged restore objects fail rather than gaining superuser authority. A fresh post-backup check verifies the original schema/data remained unchanged. Archive bytes are hashed before and after restoration.

Cleanup checks cluster-scoped database/role identities and ownership tags before non-force deletion, then proves absence. It never targets an unrelated project. Only after verification and cleanup does Fleur publish the archive and its `.manifest.json`, with SHA-256, byte count, schema/data digests, plan checksum and completion evidence. Publication refuses collisions and preserves both unrelated files and retained evidence. Verified backups remain until deliberately deleted.

## Interrupted work

Fleur fsyncs external stages and the state directory. Records include target identity, exact backup reference, plan checksum, epoch and disposable verification identity. Stages distinguish preparing, backup verified, applying, committed, rollback verified and recovery required. This slice writes preparing, backup verified, committed and recovery required; applying and rollback belong to later migration/recovery operations.

If verification or cleanup fails after preparation, normal admission remains blocked. Closing or killing the owner releases its advisory lock but never clears the durable marker. `db recover --inspect` remains read-only, including while another owner holds maintenance. It reports the target, current marker, up to 200 durable stage log entries with explicit log truncation, and live contention without replaying work or force-clearing state. Browser navigation reports maintenance with HTTP 503; mutations return a structured maintenance error without automatic retry.

For an interrupted backup, inspect the recorded exact archive reference and disposable identities. Preserve those files and the marker. A successful status result proves only that inspection succeeded. Explicit reviewed recovery and restore are supplied by the following migration/recovery slice; this command cannot claim that an uncertain database is ready.

## Result and exit contracts

All commands use the version 1 JSON envelope and global `--timeout`, `--project`, `--help` and `--json` options. `truncated` appears in both the inspection page and envelope. Invalid grammar/cursors use exit 2. Missing configuration, tools or control authority use exit 4. Maintenance contention or uncertain recovery uses exit 5. Oversized inspection results, restore/integrity failures and destination collisions fail with exit 1. Failures never return a success manifest or expose connection credentials.

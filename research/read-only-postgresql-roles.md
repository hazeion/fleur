# Least-privilege read-only PostgreSQL roles for agent database access

Research for [Research least-privilege read-only PostgreSQL roles for agent database access](https://github.com/hazeion/fleur/issues/62), 2026-10-26. Planning only. Feeds the human decision tickets [#63](https://github.com/hazeion/fleur/issues/63) and [#64](https://github.com/hazeion/fleur/issues/64); it makes neither decision.

Scope: CLI inspection (`db inspect`) and a possible development-only ad-hoc read-only SQL operation. The trusted host runs both. Fleur applications never receive raw SQL or database credentials ([V1 spec, runtime isolation](../docs/planning/V1-SPEC.md#runtime-isolation-and-production-feasibility-gate)).

## Method and versions

- **PostgreSQL version Fleur uses.** The disposable test database in `tests/runtime/owned-postgres.ts` pins `postgres@sha256:74935e72…4336`. Its image environment reports `PG_MAJOR=18` and `PG_VERSION=18.6-1.pgdg13+2`. [Verification research](verification-tooling.md) names 18.6 as the candidate.
- **Supported majors.** The [versioning policy](https://www.postgresql.org/support/versioning/) lists 18.6, 17.11, 16.15, 15.19 and 14.24 as current minors. PostgreSQL 14 reaches end of life on 2026-11-12. PostgreSQL 19 is at RC 1 and has no final release yet.
- **Sources.** PostgreSQL 18 documentation and the 15, 16 and 17 release notes.
- **Executed checks.** I ran the probes below against a disposable container from the pinned 18.6 digest. It used tmpfs storage and a loopback port, and was destroyed afterwards. One extra probe used the Bun SQL client. The local Bun is 1.4.4; the repository pins 1.4.3. Rows marked "verified 18.6" were run there. Nothing was executed on 14–17. Claims about those versions come from documentation and release notes only.

### Version differences that matter

| Feature | Versions | Source |
| --- | --- | --- |
| `pg_read_all_data` predefined role | 14+ | [Predefined roles](https://www.postgresql.org/docs/18/predefined-roles.html) |
| `idle_session_timeout` | 14+ | [Client connection defaults](https://www.postgresql.org/docs/18/runtime-config-client.html) |
| `PUBLIC` loses `CREATE` on schema `public` | 15+. Applies only to new clusters and new databases. Upgraded clusters and restored dumps keep the old grant. | [15.0 release notes](https://www.postgresql.org/docs/release/15.0/) |
| `GRANT … WITH INHERIT` / `WITH SET`. Inheritance is fixed per grant at grant time. | 16+. Before 16, `INHERIT` was a role-level attribute. | [16.0 release notes](https://www.postgresql.org/docs/release/16.0/), [CREATE ROLE](https://www.postgresql.org/docs/18/sql-createrole.html) |
| `CREATEROLE` restricted to roles held with `ADMIN OPTION` | 16+ | [16.0 release notes](https://www.postgresql.org/docs/release/16.0/) |
| `transaction_timeout` | 17+ | [17.0 release notes](https://www.postgresql.org/docs/release/17.0/) |
| `MAINTAIN` privilege and `pg_maintain` | 17+ | [17.0 release notes](https://www.postgresql.org/docs/release/17.0/) |

## What PostgreSQL itself enforces

### Privileges are the real boundary; read-only mode is not

- **`default_transaction_read_only` is only a session default.** Any role can change it with `SET` or `set_config` ([client defaults](https://www.postgresql.org/docs/18/runtime-config-client.html); [ALTER ROLE](https://www.postgresql.org/docs/18/sql-alterrole.html) calls role settings "session defaults" applied at login).
  - Verified 18.6: the role started with `default_transaction_read_only = on`. `SET default_transaction_read_only = off` succeeded. So did `BEGIN; SET TRANSACTION READ WRITE`. A `BEGIN READ WRITE` transaction also started.
- **Read-only mode cannot be reversed mid-transaction.** Read-write mode must be set before the first query. Verified 18.6: `BEGIN READ ONLY; SELECT 1; SET TRANSACTION READ WRITE` fails with `transaction read-write mode must be set before any query`. A transaction the trusted host opened as `READ ONLY` therefore stays read-only for every later statement in it.
- **What a read-only transaction blocks.** It disallows `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY FROM` to non-temporary tables, all `CREATE`/`ALTER`/`DROP`, `COMMENT`, `GRANT`, `REVOKE` and `TRUNCATE`. It also blocks `EXPLAIN ANALYZE` and `EXECUTE` of those commands. The documentation calls this "a high-level notion of read-only that does not prevent all writes to disk" ([SET TRANSACTION](https://www.postgresql.org/docs/18/sql-set-transaction.html)).
  - Verified 18.6, also blocked: `SELECT … FOR UPDATE/SHARE/KEY SHARE`, `lo_create()`, `CREATE TEMP TABLE`, and an `INSERT` inside a `SECURITY DEFINER` function owned by the table owner.
- **With read-only mode overridden, plain privileges still stopped every write.** Verified 18.6: with read-write enabled, `INSERT` failed with `permission denied for table exercises`. `nextval` failed with `permission denied for sequence counter`. `CREATE TEMP TABLE` failed once database `TEMP` was revoked from `PUBLIC`.
- **`SET ROLE` and `SET SESSION AUTHORIZATION` are closed.**
  - `SET ROLE` works only for roles the session has membership (and on 16+, `SET` option) for.
  - `SET SESSION AUTHORIZATION` requires a superuser session user.
  - Verified 18.6: both failed for `app_owner`. `SET ROLE pg_read_all_data` also failed when the role was not granted.
- **Server-file and program access is closed by default.** Verified 18.6:
  - `pg_read_file`, `pg_ls_dir`, server-side `lo_import` and `pg_stat_reset` carry ACLs that exclude `PUBLIC`.
  - `COPY … TO PROGRAM` was denied.
  - `pg_terminate_backend` against another role's backend was denied.
  - `LOCK TABLE … ACCESS EXCLUSIVE` was denied without write or `MAINTAIN` privilege.

### Default `PUBLIC` grants that a SELECT-only role still inherits

[Privileges](https://www.postgresql.org/docs/18/ddl-priv.html): PostgreSQL grants `PUBLIC` the following by default:

- `CONNECT` and `TEMPORARY` on databases
- `EXECUTE` on functions and procedures
- `USAGE` on languages and types

Privileges are additive, so a `PUBLIC` grant cannot be removed for one role only. The only option is to revoke it from `PUBLIC` and re-grant it to the roles that need it. Consequences:

| Capability | Status | Verified 18.6 / source |
| --- | --- | --- |
| Connect to every database whose `CONNECT` is still granted to `PUBLIC` (`postgres` control database, `template1`, disposable verification databases) | Open unless `CONNECT` is revoked from `PUBLIC` per database or `pg_hba.conf` restricts the role | Verified: connected to `postgres` and took a session advisory lock there |
| Temporary tables | Open by default; closed by revoking database `TEMP` from `PUBLIC` | Verified both states |
| `pg_advisory_lock*` (session and transaction, shared and exclusive) | Open (`EXECUTE` to `PUBLIC`), **including in read-only transactions** | Verified. `pg_locks` is readable, so the role can see other sessions' advisory keys, such as Fleur's fence and maintenance keys, and acquire or contend for them. A shared request against another session's exclusive key waited until `lock_timeout`. |
| `pg_sleep`, expensive joins, `generate_series`, recursive CTEs | Open; bounded only by timeouts | Verified `pg_sleep` |
| `pg_notify` / `LISTEN` | Open, including read-only | Verified. A notification is delivered only if the transaction commits. |
| `pg_current_xact_id()` | Open; assigns a transaction ID even in a read-only transaction | Verified |
| `set_config` / `SET` of user-context settings (`statement_timeout`, `lock_timeout`, `work_mem`, `transaction_timeout`, `default_transaction_read_only`, `row_security`) | Open | Verified for `statement_timeout`, `work_mem` and `default_transaction_read_only` |
| `pg_cancel_backend` / `pg_terminate_backend` on **same-role** sessions | Open: allowed when "the calling role is a member of the role whose backend is being" signaled ([admin functions](https://www.postgresql.org/docs/18/functions-admin.html)) | Verified: terminated a concurrent session of the same role |
| `pg_control_system()` | Open (`proacl` is null, so `PUBLIC` has `EXECUTE`) | Verified 18.6 only |
| `dblink`, `postgres_fdw` | Not present unless the extension is installed. If installed, non-superuser connections need password authentication to the remote server. | Not installed in the probe. Fleur migrations admit only compiler SQL. |

### Timeouts

[Client connection defaults](https://www.postgresql.org/docs/18/runtime-config-client.html):

- `statement_timeout` aborts a long statement.
- `lock_timeout` applies to each lock acquisition attempt.
- `idle_in_transaction_session_timeout` and `idle_session_timeout` terminate idle sessions.
- `transaction_timeout` (17+) terminates a session whose transaction runs too long. Prepared transactions are exempt.

All of these are user-settable, so a role default is only a starting value. Verified 18.6:

- **A same-statement change does not stop the running timer.** `SELECT set_config('statement_timeout','0',false), pg_sleep(7)` was still cancelled at the 5 s role default. The timer is armed when the statement starts.
- **A later statement can raise or disable it.** That later statement then runs without the limit.
- **Superuser-context settings cannot be overridden.** A superuser-issued `ALTER ROLE … SET temp_file_limit` could not be overridden: `SET temp_file_limit = -1` failed with `permission denied to set parameter`. A hard per-role bound on temporary disk use is therefore enforceable. Time and memory bounds are not enforceable this way.
- **Recommendation.** Treat role-level timeouts as defense in depth. Make the trusted host's own `SET LOCAL` plus a wall-clock cancel/close the authority. `inspection.ts` already does this with `SET LOCAL statement_timeout` and a timer that closes the connection.

### Connection limits

- **`CONNECTION LIMIT` works but has limits.** Verified 18.6: a third connection failed with `too many connections for role`. Per [CREATE ROLE](https://www.postgresql.org/docs/18/sql-createrole.html):
  - it is enforced only approximately,
  - superusers are exempt,
  - prepared transactions and background workers are not counted.
- **It reserves nothing.** It caps the role but does not protect `max_connections` for other roles. On 16+, `reserved_connections` with `pg_use_reserved_connections` can reserve slots for Fleur's own roles ([16.0 release notes](https://www.postgresql.org/docs/release/16.0/)).
- **A limit above 1 lets sessions of the same role signal one another.** See the same-role row in the table above.

### `pg_read_all_data` versus explicit grants

- **What it grants.** `pg_read_all_data` acts "as if having `SELECT` rights on those objects and `USAGE` rights on all schemas". It does not bypass RLS ([predefined roles](https://www.postgresql.org/docs/18/predefined-roles.html)). The membership is cluster-wide, so it applies in every database the role can connect to:
  - the control database
  - `fleur_internal`
  - disposable verification databases
  - any other project database on the same cluster
- **It reads Fleur metadata.** Verified 18.6: a role with inherited `pg_read_all_data` read `fleur_internal.history`.
- **`NOINHERIT` changes the effect.** Verified 18.6: with a plain `GRANT`, a `NOINHERIT` role received `inherit_option = f` and could not read anything until `SET ROLE`. `GRANT pg_read_all_data TO r WITH INHERIT TRUE, SET FALSE` (16+) gave inherited reads without `SET ROLE`.
- **Explicit grants are narrower.** Schema `USAGE` plus `SELECT ON ALL TABLES IN SCHEMA public` stays scoped to one database and one schema. `fleur_internal` and sequences stay unreadable. Verified: `currval` and `nextval` were both denied, because `ALL TABLES` does not cover sequences.
- **Future tables need default privileges for the right owner.** `ALTER DEFAULT PRIVILEGES FOR ROLE <creator>` covers only objects that role creates. Verified 18.6: a table created later by `app_owner` was readable. A table created by a different role (superuser) was not.

### Row-level security and catalogs

- **RLS without a policy returns zero rows silently.** Verified 18.6: a table with RLS enabled and no policy returned `count = 0` with no error. Setting `row_security = off` makes such queries fail instead of silently filtering. It is user-settable, so the trusted host would set it per transaction. Table owners and `BYPASSRLS` roles bypass RLS ([CREATE ROLE](https://www.postgresql.org/docs/18/sql-createrole.html)).
- **System catalogs are readable by every role.** Schema privileges do not hide catalog rows. Verified 18.6, without `USAGE` on `fleur_internal`, the role could read:
  - its table, index and column names, and `reltuples`, by joining `pg_class`/`pg_attribute`
  - every database name (`pg_database`)
  - every role name (`pg_roles`)
  - function source (`pg_proc.prosrc`)
  - 375 rows of `pg_settings`
  - `pg_locks`
- **`pg_stats` is privilege-filtered.** It returned no rows for the unreadable schema.
- **`pg_stat_activity` hides query text** for other roles' sessions without `pg_read_all_stats`. Verified: no other-role query text was visible.

## What needs Fleur-side code

PostgreSQL privileges do not provide these. The trusted host must.

1. **One statement per request (extended protocol).**
   - A simple-protocol query string runs several statements in one implicit transaction. An extended-protocol `Parse` "cannot include more than one SQL statement" ([protocol flow](https://www.postgresql.org/docs/18/protocol-flow.html)).
   - **Bun pitfall, verified on Bun 1.4.4.** `sql.unsafe(text)` and `sql.unsafe(text, [])` both used the simple protocol and accepted several statements. `sql.unsafe("SET default_transaction_read_only=off; BEGIN READ WRITE; …")` returned `transaction_read_only = off`. Only `sql.unsafe(text, [param])` with at least one parameter was rejected with `cannot insert multiple commands into a prepared statement`.
   - [Bun SQL docs](https://bun.com/docs/runtime/sql) state that multiple commands are allowed without parameters.
   - So "single statement" must be enforced by construction. One option is wrapping agent SQL in a parameterised outer query such as `… LIMIT $1`. This needs tests on the pinned Bun version.
2. **Wrap every request in a read-only transaction and always roll back.** Open `BEGIN … READ ONLY` before the agent statement, then always `ROLLBACK`. Because read-write mode cannot be set after the first query, this blocks the `SET TRANSACTION READ WRITE` override. Rolling back also discards `pg_notify` output. Fleur's reactive delivery may later use notifications, so this matters. `SET LOCAL` the timeouts, `row_security = off` and a fixed `search_path` inside the same transaction.
3. **A fresh, discarded connection per request.**
   - Session advisory locks, `LISTEN` registrations, session `SET`s and same-role signalling all live for the session. Closing the connection after each request bounds them to that request's deadline.
   - This matches the spec rule that brokers must not reuse a connection until cancellation and transaction state are verified ([V1 spec, runtime isolation](../docs/planning/V1-SPEC.md#runtime-isolation-and-production-feasibility-gate)).
   - Advisory-lock interference still lasts up to the statement deadline. Removing it entirely needs a `REVOKE EXECUTE … FROM PUBLIC` on the advisory functions in that database, with explicit re-grants to Fleur's own roles. That revocation interacts with backup and restore verification. See the open questions.
4. **A wall-clock deadline owned by the host.** On expiry, cancel or close the connection, as `inspectDatabase` already does. Role and `SET LOCAL` timeouts are defense in depth.
5. **Output bounds.**
   - PostgreSQL limits neither row count nor row width; a single field can approach 1 GB. Bun's documented client API exposes no maximum-rows execute (the docs pages read did not show cursor support).
   - Options:
     - wrap the statement as a subquery with `LIMIT $n+1` and server-side `octet_length` accounting, as `inspection.ts` does today;
     - use `DECLARE … CURSOR` plus `FETCH n` inside the read-only transaction.
   - Subquery wrapping also rejects non-`SELECT` statements and data-modifying CTEs, which must be top-level.
   - Either option needs RESULT_TOO_LARGE / truncation semantics consistent with the [JSON contract](../docs/planning/V1-SPEC.md#command-and-machine-output-contract).
6. **Credential custody.** The read-only role's password stays in trusted host state, under the same rules as other `FLEUR_PRIVATE_*` values in [maintenance](../docs/maintenance.md). It must never reach application workers or browser output.
7. **Development-only gating.** PostgreSQL cannot tell development from production. The trusted host must gate the operation, for example with the binding `db reset` uses (`FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL`).

## Implications of the existing `db inspect` credentials

- **One credential does everything today.** `db inspect` uses `FLEUR_PRIVATE_DATABASE_URL`, the same credential as maintenance. Per [maintenance](../docs/maintenance.md), that credential needs:
  - identity inspection,
  - control-database access for `MaintenanceLease` (session advisory locks on the control database),
  - for backup, role and database creation.
- **That credential cannot be shared with an agent-facing operation.** On 16+, a `CREATEROLE` holder can create roles and administer the ones it creates. `CREATEDB` can create databases. Session advisory locks on the control database are the maintenance ownership mechanism.
- **The read itself already runs in a read-only transaction.** Code in `src/runtime/database/inspection.ts`: `BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY`, `SET LOCAL statement_timeout='5s'`, `search_path=pg_catalog`. Its SQL is Fleur-generated, so the privilege breadth is not reachable by agent input today.
- **Separating authority would mean two connections.**
  - a lease connection with control-database authority, using the existing or a narrower control credential;
  - a data connection with only the read-only role.
- **Identity checks may not need elevated privileges.** On 18.6, `pg_control_system()` executed for an unprivileged role. Whether every check `MaintenanceLease` performs works for a narrow role was not tested here. That covers the backend address and port, database OID and owner. Behaviour on 14–17 is also unverified.

## Candidate minimal role recipe

This is an illustration for comparison, not a decision.

- **Who runs it.** A superuser, or a role with `CREATEROLE` that also owns the database. `temp_file_limit` must be set by a superuser.
- **Placeholders.**
  - `<app_db>` is the project database.
  - `<owner>` is the role that creates application tables through migrations.
  - `<broker_roles>` are Fleur's own runtime and maintenance roles.
- **Status.** Statements were executed on 18.6 except the control-database `REVOKE` and the advisory-function revocation.

```sql
-- Cluster-wide login role with no inherited powers.
CREATE ROLE fleur_agent_read LOGIN PASSWORD '<generated, stored in private state>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 1;

-- Session defaults: defense in depth only (user-overridable), except temp_file_limit.
ALTER ROLE fleur_agent_read IN DATABASE <app_db> SET default_transaction_read_only = on;
ALTER ROLE fleur_agent_read SET statement_timeout = '5s';
ALTER ROLE fleur_agent_read SET lock_timeout = '1s';
ALTER ROLE fleur_agent_read SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE fleur_agent_read SET idle_session_timeout = '60s';
ALTER ROLE fleur_agent_read SET transaction_timeout = '15s';        -- PostgreSQL 17+ only
ALTER ROLE fleur_agent_read SET temp_file_limit = '64MB';           -- superuser-issued; not overridable

-- Database: remove PUBLIC CONNECT/TEMP, re-grant explicitly.
REVOKE ALL ON DATABASE <app_db> FROM PUBLIC;
GRANT CONNECT ON DATABASE <app_db> TO <owner>, <broker_roles>, fleur_agent_read;
-- Other databases (control `postgres`, template1, verification DBs): either
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;  -- then re-grant to Fleur's control roles
-- or a pg_hba.conf rule limiting fleur_agent_read to <app_db> (cluster configuration).

-- Schema: no CREATE for anyone but the owner (needed explicitly on 14 and on upgraded clusters).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO fleur_agent_read;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fleur_agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
  GRANT SELECT ON TABLES TO fleur_agent_read;
-- No USAGE on fleur_internal; no sequence privileges; no pg_read_all_data.
-- Optional: REVOKE SELECT ON public.fleur_seed_deleted_v1 FROM fleur_agent_read;

-- Optional, closes advisory-lock interference entirely (affects all roles; untested here):
-- REVOKE EXECUTE ON FUNCTION pg_advisory_lock(bigint), ... FROM PUBLIC;  -- in <app_db>
-- GRANT  EXECUTE ON FUNCTION ... TO <broker_roles>;
```

Per-request wrapper the trusted host would run (Fleur-side, on a fresh connection):

```sql
BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL row_security = off;
SET LOCAL search_path = public, pg_catalog;
-- one agent statement, extended protocol, wrapped/bounded for output
ROLLBACK;
-- then close the connection
```

## Residual risks with the recipe

- **Catalog metadata disclosure.** Database names, role names, `fleur_internal` table and column names, function bodies, settings and lock keys stay readable. Hiding them would mean revoking catalog access, which PostgreSQL does not support as a normal configuration.
- **Resource use within the deadline.** CPU, memory up to the `work_mem`/`hash_mem` defaults, I/O and buffer-cache eviction remain possible. Temporary disk is capped by `temp_file_limit`.
- **Locks held within the deadline.**
  - `ACCESS SHARE` locks from reads can block a migration's `ACCESS EXCLUSIVE`. A queued exclusive lock then blocks later application work.
  - Advisory locks can contend with Fleur's fences unless the functions are revoked.
- **Transaction ID consumption** through `pg_current_xact_id()`.
- **Reads of everything in `public`.** That includes seed tombstones and any application data. It is the intended capability, but it is development data that may be personal.
- **Same-role signalling** if the connection limit is above 1 and requests run concurrently.
- **Assumed state.** The recipe assumes no extensions such as `dblink` or `postgres_fdw`, and no `PUBLIC`-executable `SECURITY DEFINER` functions that write outside the transaction. Read-only mode still blocks their writes inside the transaction (verified).

## Open questions for #63 and #64

1. **Should agents get ad-hoc SQL at all?** Or should development inspection stay limited to named, Fleur-generated queries, as today? If ad-hoc SQL is allowed, is it development-only, and how is development established (for example the reset binding)?
2. **Should `db inspect` move off the maintenance credential?** It could use a lease connection plus a separate read-only data role. Who creates and rotates that role, and with what authority? Fleur owns the development cluster but not production PostgreSQL.
3. **Explicit grants or `pg_read_all_data`?** `pg_read_all_data` is cluster-wide and reads `fleur_internal`. Explicit grants are scoped but depend on default privileges for the role that runs migrations. Which role owns migrated tables?
4. **Is cross-database `CONNECT` closed, and how?** The options are revoking `PUBLIC` `CONNECT` on the control and other databases, or `pg_hba.conf`. Either changes cluster configuration that maintenance and backup verification also rely on.
5. **Accept bounded advisory-lock interference, or revoke the advisory functions?** Revoking means `REVOKE EXECUTE … FROM PUBLIC` in the application database. Backups would capture those ACL changes, and Fleur's verification restores under an unprivileged owner without replaying grants. The interaction is untested.
6. **What output contract applies?** Row and byte limits, truncation versus `RESULT_TOO_LARGE`, value encoding (exact strings as in `db inspect`), and whether cursors or continuation are supported for ad-hoc results.
7. **Which deadlines?** Statement, transaction and wall-clock values, and their relation to the global `--timeout`.
8. **What does RLS do?** `row_security = off` to fail loudly, or default filtering.
9. **Which versions are supported?** PostgreSQL 14 reaches end of life on 2026-11-12. Supporting 14–16 loses `transaction_timeout` and, on 14, changes the `public` schema default and membership semantics. Which majors must the recipe be tested on before any implementation?
10. **Should the role's grants survive backup, restore and reset?** Role grants and default privileges appear in dumps. Restore and reset must recreate or re-grant them consistently.

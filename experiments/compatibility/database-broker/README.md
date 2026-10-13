# Disposable database and registered broker probe

This is issue #23 compatibility evidence, not the Fleur runtime. The trusted broker uses internal Drizzle 0.45.4 to construct parameterized PostgreSQL statements and Bun SQL 1.4.3 to execute them. Zod 4.6.7 validates the complete request and public response. The application request contains only a registered operation, bound token, registered action and structural input. SQL, connection URLs, filesystem paths, shell, setup, nested transactions and cross-operation authority are rejected.

Run with a verified Bun 1.4.3 executable and an already available Docker daemon:

```sh
python3 experiments/compatibility/database-broker/run.py --bun /path/to/verified/bun
```

The driver explicitly acquires immutable PostgreSQL 18.6 index `sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336`. Registry observation on 2026-10-13 resolved Linux amd64 `sha256:885953109528ad3dfc90362b1a6f50a78620b5315be19f187753d267e484dc5b` and arm64 `sha256:a63b24165ea0eacced7585766d790ac08bbaefe10a1841f87783a4505d29a69c`. These are acquired pins, not platform execution results.

No database URL argument exists. The driver creates a random container, ownership label, database and role with an ephemeral random credential. PostgreSQL storage is a container tmpfs, with no host bind mount or persistent data volume. The published port binds exclusively to loopback. Before writes the driver verifies container identity, image digest, PostgreSQL 18.6, database and role. Before removal it verifies ownership again. Cleanup failure fails the report. No development data is used.

The driver runs real SQL tests twice. They cover registered reads, invalid-output and child-constraint rollback, two expected-version writers with one winner, cancellation and verified rollback before connection reuse, queued reservation cancellation, isolation of healthy work, actual request-worker termination before commit, committed response loss without replay, and Read Committed statement snapshots with PostgreSQL read-only enforcement. Database tests observe stored state deliberately because committed versus rolled-back data is the contract being proved. Compiler, oxlint and Bun bundle checks also run. `skipLibCheck` remains false. A required strict compiler failure leaves the driver failed even when runtime tests pass.

The native worker IPC seam is `ipc.ts`. A trusted host launches `bun ipc.ts` with only the owned database environment created by `run.py`. It accepts JSON lines on stdin and returns `broker-response` JSON lines. An admitted fixture request is:

```json
{"kind":"broker-request","operation":"compat.query","token":"probe-query","action":"readExercise","input":{"id":1}}
```

Only a successful validated response for id 1 and name `Squat` authorizes the runtime probe's `registered:Squat` acknowledgement. The trusted host fixes the IPC process to a query Session. A perfectly valid known mutation request is still denied on that channel. Fixed tokens are fixture registration markers, not a production authentication design. This experiment does not implement worker lifecycle or seccomp itself. The separate runtime probe owns those restrictions. This broker does not expose the SQL connection or the trusted code to an application worker.

## Executed local evidence and limits

The request-denial test first failed because the initial admission stub accepted an undeclared `sql` field. Strict schema implementation then passed 13 assertions across the first two admission tests. A subsequent session-confusion regression failed before the trusted-session binding was added, then passed 14 assertions across three admission tests. The bundle built with Bun 1.4.3 and oxlint passed. Strict TypeScript 7.0.2 initially reproduced upstream Drizzle declarations errors. The independently diagnosed declaration repair now passes strict compilation, with exact gel 2.2.1 and mysql2 3.24.6 optional declaration peers. The checked-in `patches/provenance.json` and `patch.test.ts` verify repaired declarations against source maps and unchanged upstream runtime hashes. No runtime code or application dependency permission changed. Full ESLint also passes with its independently pinned TypeScript 6.0.3 engine. This macOS host has no Docker daemon, so database tests have not been executed here. The driver reports this as failure with no completed database checks. Hosted execution must supply real database evidence, not convert the missing prerequisite into a skip or success. An intended SQL red failure cannot be recorded without that prerequisite; SQL assertions are unverified until hosted execution.

The probe does not yet prove joined reads under a controlled concurrent commit, host response loss from process termination, admission queue limits or a full OS matrix. The response-loss test deliberately suppresses delivery after confirmed commit. It proves outcome semantics in this broker, not a complete transport failure model. No dependent product implementation is authorized by partial results.

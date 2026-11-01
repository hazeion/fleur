# CLI foundation

The release package runs on Bun at or above its release floor, currently 1.4.3. Its executable is `bin/fleur.ts`, with a Bun shebang. Node and npm are not bootstrap requirements. The initial package version is 0.1.0; project creation pins the release package version exactly. The catalog implements project creation and prerequisites, shared database operations, and `dev [--background] [--host <address>] [--port <number>]`, `stop`, `status` and `logs [--limit 200] [--cursor <token>] [--follow]`. Setup supports scoped authorized smoke-image acquisition. It does not install Docker packages or run applications.

Configuration comes only from the environment the command was started with. Every command declines the `.env` files Bun would otherwise load from the working directory, and so does every Bun process Fleur starts.

Run `bun bin/fleur.ts --help` for the available command catalog. Finite commands return one JSON version 1 object on stdout with `--json`. Foreground dev and opt-in log follow emit monotonic newline-delimited events ending with a completed result; see [development lifecycle](development.md). Diagnostic logs belong on stderr. Every finite result contains `formatVersion`, `command`, `ok`, `data`, `error` and `truncated`. Successful results have `error: null`; failures have structured recovery actions and null data unless diagnostic partial data is explicitly documented.

Common options are `--project <dir>`, `--json`, `--timeout <seconds>` and `--help`. Paths resolve from the invocation directory. The default timeout is 60 seconds; an explicit timeout must be finite and positive, at most 2,147,483 seconds. Duplicate, unknown and malformed options return exit 2. Commands are named operations; arbitrary shell arguments are rejected.

Exit categories are 0 success, 1 failure, 2 invalid invocation, 3 human authority or action required, 4 environment unavailable or incompatible, and 5 contention, drift or recovery blocking. Future command handlers return the same result contract through `runCli`; the executable owns stdout serialization. Human and JSON help are generated from the same catalog used by dispatch, including each implemented command's admitted flags. Asking for command help does not run that command.

Development checks are `bun test tests/cli`, `bun run types` and `bun run lint`. Packed tests create a real package archive, extract it outside the checkout and run its executable with a poisoned Node command and no package dependencies. The entry point is also exercised through actual `bunx --no-install fleur --help` after installing that owned archive into a temporary consumer project. Bun is on its isolated PATH and Node is poisoned. Nothing is published.


Project commands read `fleur.json` as bounded data and require an exact `fleurVersion`. A configured project with a missing, malformed or incompatible pin returns exit 4 with `VERSION_MISMATCH` before project writes. If `fleur.json` is missing, the application marker in `package.json` identifies the existing Fleur project and blocks descendant creation as well. That marker never supplies a fallback pin; ordinary manifests and the CLI package name alone do not identify a configured application. Fresh `new` and `init` outside configured projects use the package release version. An existing project with that same version needs no separate local install, but must declare format version 1, contract version 1 and the Microsoft compiler. Missing or unsupported metadata blocks project writes. Different exact releases are delegated before applying the current release's metadata rules. A different exact pin delegates only to the matching installed `node_modules/fleur` package, through Bun, after checking its package name, version and contained executable. Missing installations, escaped executable paths and delegation loops stop with an explicit recovery action. No latest-version or network fallback is used. Help remains available when metadata is broken.

Ordinary interruption of a delegated launcher forwards SIGINT, SIGTERM or SIGHUP to its owned child and waits for that child to exit. The caller receives the child's actual completion status. A graceful stop that finishes successfully returns 0; a child terminated by a signal returns that signal-derived status. A child that ignores interruption receives a 30-second grace period before forced termination and reaping, which returns 137 for SIGKILL. An uncatchable kill of the launcher cannot provide this cleanup guarantee. Help, prerequisite diagnosis and per-user grant inspection or revocation remain available independently of project pins.


The package includes this document, project creation guidance and prerequisite setup guidance for offline reading. `fleur docs` reads the pinned offline core reference; `docs catalog` returns versioned operation metadata and schemas. See [upgrades and guidance](upgrades.md) for refresh, mismatch checks, exact-version upgrade paths and `verify`. Generated projects contain working pinned test, type and lint tooling; this is separate from a Fleur application build or native installation proof. CI verifies the complete CLI suite and both compiler/lint graphs, then creates and checks a fresh packed project twice with separate dependency caches.

## Error catalog

| Code | Exit | Recovery |
| --- | --- | --- |
| `ARGUMENT_INVALID` | 2 for invalid invocation; 1 when a requested grant does not exist | Read help or list existing grants before retrying. |
| `INTERNAL_FAILURE` | 1 | Inspect the failed operation; no success is reported. |
| `PROJECT_CREATION_FAILED` | 1 | Correct the failure and retry after confirmed rollback. |
| `VERSION_MISMATCH` | 4 | Restore intended exact metadata or explicitly install the matching local release. |
| `PREREQUISITE_UNAVAILABLE` | 4 for unavailable or incompatible prerequisites; 1 for a failed authorized acquisition | Run doctor and inspect required setup actions. |
| `READINESS_TIMEOUT` | 4 | Recheck prerequisites before explicitly retrying. |
| `BROWSER_ASSET_CAPACITY` | 4 when startup cannot fit the bounded cache; a reload retains the current app | Explicitly stop and dev to clear disposable browser assets, preserving data and backups. |
| `AUTHORITY_REQUIRED` | 3 | Have a human inspect and authorize the exact proposed action. |
| `HUMAN_ACTION_REQUIRED` | 3 | Complete the documented manual prerequisite action, then rerun setup. |
| `PROJECT_COLLISION` | 5 | Choose an empty target or resolve reported protected files explicitly. |
| `MAINTENANCE_BUSY` | 5 | Wait for the current setup or database maintenance owner to finish, then explicitly retry. |
| `RECOVERY_REQUIRED` | 5 | Inspect reported incomplete restoration or unsafe state before retrying. |
| `CONFIGURATION_MISSING` | 4 | Supply the explicit private database configuration for the selected target. |
| `DATABASE_UNAVAILABLE` | 4 when a command needs data from a database it cannot reach | Start the PostgreSQL server or correct the private database configuration, then check `status`. |
| `DATABASE_PRIVILEGE_INSUFFICIENT` | 4 when the configured database credential lacks a capability the command needs; raised before anything changes | Grant the capability named in `expected.capability`, from the minimum-privilege profile or the additional authority in [credential authority](maintenance.md#credential-authority), then retry. |

### Readiness reasons

`status` reports readiness reasons from this stable vocabulary. Each carries one structured action. They are data in an exit-0 result, not errors.

| Reason | Meaning | Action |
| --- | --- | --- |
| `DATABASE_UNAVAILABLE` | The database refused the connection, rejected it or did not answer within the probe deadline. | `fleur status` after starting the server or correcting configuration |
| `MIGRATION_PENDING` | Committed migrations are not applied. | `fleur db migration plan`, then an explicit `fleur db migration apply` |
| `SCHEMA_DRIFT` | The schema or history differs from Fleur's record. | `fleur db migration status`; never reset or rewrite history |
| `MAINTENANCE_ACTIVE` | A maintenance operation holds the target. | `fleur db recover --inspect` and wait |
| `RECOVERY_REQUIRED` | Interrupted maintenance needs explicit recovery. | `fleur db recover --inspect` |
| `PREREQUISITE_UNAVAILABLE` | A local prerequisite, such as Fleur's private state directory, stopped the probe. | `fleur doctor` |

When the target is unreachable but Fleur's control record shows active maintenance or interrupted recovery, `status` reports `MAINTENANCE_ACTIVE` or `RECOVERY_REQUIRED` with the recorded stage instead of `DATABASE_UNAVAILABLE`, because a restore or reset can replace the target.

### Migration note: `db migration status` output

This pre-1.0 release changes the `db migration status` JSON version 1 data. Update consumers as follows:

- `compatible`, `applied` and `pending` moved from the top level of `data` to `data.migrations`, the same summary that `db inspect` and `status` embed.
- `busy` and the raw `maintenance` marker were removed, because the marker names the host, port and owner. Read `data.migrations.maintenance.state` (`idle`, `active` or `recovery required`) and `data.migrations.maintenance.stage` instead. `fleur db recover --inspect` still reports the full durable record.
- Drift is no longer `SCHEMA_DRIFT` with exit 5. It is `data.migrations.drift`, `data.migrations.differenceCount` and the `data.differences` list, with exit 0. `data.differencesTruncated` and the envelope's `truncated` report a list cut at its count or byte bound.
- `data.target` identifies the target. An unreachable database returns `DATABASE_UNAVAILABLE` with exit 4.

Doctor and setup may return documented partial diagnostic data on failure, including component states, resumable plans and completed setup actions. A nonzero readiness result never claims a verified native release profile. Per-user grant inspection and revocation do not install or remove software. Interrupted APT setup may propose a separately scoped once-only `recovery-inspect` action for a read-only privileged inspection of retained cache directories. JSON setup reports the plan without creating authority. See [setup recovery](setup.md) for its evidence, consent and preservation requirements.

### Doctor release admission

`doctor --json` reports `data.components.release` under the [version floors](setup.md#current-verified-scope). On success (`ok: true`, exit 0) it is `{ state: "verified", floor, admission, measuredRows, machineTools, evidence }`. `floor` is the per-target floor id (`darwin-x64-desktop`, `ubuntu-x64-engine`, `debian-x64-engine`); `admission` is `measured` when every machine tool equals a value measured on one row and `above-floor` when any tool is newer; `measuredRows` lists the measured row ids the floor derives from; `evidence` carries the sha256 records of the measured row that the host release and server build match exactly, else the target's first row. `machineTools` has one row per machine tool in report order, `release` (the operating-system release), `kernel`, `bun`, `desktop` (Docker Desktop targets only), `cli`, `engine`, `compose`, `containerd` and `runc`, each `{ tool, status, floor, detected, comparison }`. `status` is `verified` (equal to a measured value), `admitted` (newer than every measured value) or `unverified` (blocking); `comparison` is `equal`, `newer`, `older`, `pre-release` or `unparseable`. The earlier `release.profile` field is replaced by `floor` and `measuredRows`.

A floor refusal returns exit 4 and `PREREQUISITE_UNAVAILABLE` with `release` `{ state: "unverified", floor, machineTools }`, the blocking rows at `status: "unverified"`, `error.expected` `{ tool, floor }` and `error.actual` `{ tool, detected }`. The message names the first blocking tool in report order: `Machine tool bun is 1.4.2, below the floor 1.4.3.`, `Machine tool bun is a pre-release build (1.4.8-canary.3+38afee6c8); release floors admit stable versions only.` or `Machine tool release has no parseable version.` Doctor reads `bun --revision` from its own executable through the host command runner, because `Bun.version` hides a canary or debug tag; an unreadable revision, or one that does not describe the running version, refuses as release-less. A host whose identity facts (OS family, architecture, kernel flavour, Docker product, cgroup driver, operating mode, security options) match no measured row keeps the generic refusal with `release` `{ state: "unverified" }`. Human output prints the status word beside every tool (`bun         admitted    1.4.7                    > floor 1.4.3`), the release line `release   verified  floor darwin-x64-desktop (measured on darwin-15.7.7-x64-desktop-4.96.1)` and a trailing note when tools are admitted above the baseline; a refusal ends with its message and the `fleur setup` action. No credential, machine path or host name appears in the output.

## Bun compatibility

The selected Fleur release requires Bun at or above its release floor, currently 1.4.3, published in its package `engines.bun` metadata as `>=1.4.3`. Newer stable Bun versions are admitted. The CLI validates the stored floor against the `>=X.Y.Z` form before comparing and compares `Bun.version` numerically by major, minor and patch; it never passes the stored value to `Bun.semver`, which admits everything for an unparseable range. Valid non-help commands reject an invoking Bun below the floor with exit 4 and `BUN_VERSION_MISMATCH`, reporting the floor as `expected`, the invoking version as `actual` and manual installation guidance. A release whose stored floor is not of the `>=X.Y.Z` form refuses every valid non-help command with the same exit and code instead of admitting every Bun. `Bun.version` is plain X.Y.Z even on canary builds, so this gate compares the release number only; pre-release detection belongs to doctor. Fleur does not upgrade or replace Bun. Help remains available, and invalid command syntax retains its argument-error result.

Project pin resolution and exact local release delegation happen before the launcher's own compatibility check. A delegated release applies its own Bun floor; a newer temporary launcher cannot impose its floor on that older selected release, and it cannot admit a Bun that the selected release refuses.

The compatibility regression uses real checksum-verified Bun release executables in an owned temporary directory, rather than overriding the runtime-reported version: 1.4.2 proves refusal below the floor and 1.4.4 proves admission above it. Its setup downloads only the fixed official assets and extracts their expected executables through `/usr/bin/unzip`; tests also require `/usr/bin/tar` for the packed CLI. This is explicit development-test acquisition, outside command startup/deadline measurements, and is cleaned afterward. Ordinary Fleur execution still requires only Bun. Asset identities are pinned for Linux/macOS x64/arm64; only platforms that actually run the test provide execution evidence, and a downloaded fixture is never admitted as a supported runtime by its download alone. Pull-request and main CI install exactly the floor Bun.

## Database inspection and backups

`db inspect [--table <name>] [--limit 100] [--cursor <token>] [--export <file>] [--production]` returns read-only bounded pages. Without `--table` it returns the schema overview, which has no rows; with `--table` it returns that table's structure and a page of rows. `status [--production]` reports application state and database health, and `db migration status [--production]` reports applied, pending and drift state. `db inspect` and `status` embed that same migration summary. Findings such as drift, pending migrations, maintenance and an unreachable database are exit-0 data. See [schema overview and database health](maintenance.md#schema-overview-and-database-health). `db backup --out <file>` creates a retained PostgreSQL archive only after full disposable restoration, integrity comparison and owned cleanup. `db recover --inspect` reports durable maintenance state without clearing it. See [maintenance configuration, safety and recovery](maintenance.md).

`db migration generate`, `plan`, `status` and `apply [--grant <id>]` manage reviewed transactional schema artifacts. `db restore --from <file> [--grant <id>]` requires human replacement approval. JSON calls never manufacture destructive authority. See [reviewed migrations and interrupted recovery](maintenance.md#reviewed-migrations) for actual-state checks, grants, tool prerequisites and recovery outcomes.

`db seed` reconciles declared row ownership under maintenance, reports user-edited
or deleted rows and rolls back the whole run on conflicts. `db reset [--seed]
[--grant <id>]` recreates only the explicitly bound development target after
human approval and restore-verified backup. Empty data is the default; seeding is
explicit. Production reset is unavailable. See [owned seeds and development
reset](maintenance.md#owned-seeds-and-development-reset).


Production `build` and `start --artifact <dir> [--host <address>] [--port <number>]` add `ARTIFACT_INVALID` and `ARTIFACT_INCOMPATIBLE` (exit 4; build or copy a complete artifact for this release) and `ALREADY_RUNNING` (exit 4). `start` streams newline-delimited events like foreground `dev`. See [production artifact](production.md).

Development adds `PORT_OCCUPIED` (exit 4; select a free explicit port or omit the
option), `INSTANCE_UNAVAILABLE` (exit 1; inspect logs, stop, then restart),
`MIGRATIONS_PENDING` (exit 5; review/apply the schema change) and
`EXECUTION_RECOVERY_REQUIRED` or `IMAGE_RECOVERY_REQUIRED` (exit 5; retain
ownership evidence for verified recovery). `SOURCE_OBSOLETE` identifies a
superseded compilation; it cannot replace a later admitted snapshot.
`SOURCE_REJECTED` remains exit 1 and never replaces the last valid generation.
Status reports failure findings as exit-0 data. The lifecycle uses the same
shared database operations and private maintenance owner as database commands.

`db query (--sql <text> | --sql-file <path>) [--param <text>]... [--limit 100]`
is available for bounded development-only SQL diagnosis. `--timeout` defaults to
5 seconds and accepts at most 30 seconds. It refuses production selection,
stopped development PostgreSQL and active maintenance. See
[development SQL diagnosis](maintenance.md#development-sql-diagnosis) for statement
forms, exact text results, credential restrictions and failure codes.

`explain` reads the pinned environment guidance offline. `test` runs the whole
application `tests/` tree by default. Explicit `--suite unit|database|browser`
selects `tests/<suite>/`; `--filter <name-or-path>` selects matching test file
paths, or a Bun test-name expression when no file path matches. These are
subsets and do not establish whole-suite evidence. `types` runs the pinned
Microsoft compiler, and `lint` runs both oxlint and the independent ESLint engine.
These commands share verify's exact tool-graph check, guidance guard and bounded
deadline. They never execute package scripts or accept shell arguments. Tool
failure returns exit 1 with the failed check; timeout returns exit 4. No missing
tool, dependency, compiler or browser is installed automatically.

The generated test graph includes pinned `@playwright/test`. An operator prepares
Chromium explicitly with `bun ./node_modules/@playwright/test/cli.js install chromium`
and supplies required system libraries before browser tests. These commands run
with Bun; Node is not required. `PLAYWRIGHT_BROWSERS_PATH` can select the prepared
browser cache. Verification tools receive only `PATH`, `HOME` and that browser
cache setting, without database or provider credentials.

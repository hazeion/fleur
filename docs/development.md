# Development lifecycle

`fleur status` includes aggregate execution capacity, pending creation and
quarantine counts without exposing process or container identifiers.

`fleur status` reports an unused project as stopped without requiring database
configuration or starting resources. Explicit private database configuration still
uses the shared health probe when no lifecycle binding exists.

`fleur dev` owns a development supervisor, restricted application execution and
persistent PostgreSQL for the selected checkout. It does not launch a coding
agent. Use the project's exact Fleur pin and the supported Bun/Docker runtime.
Startup first uses the shared Doctor operation and binds further control to its
qualified local endpoint. An unverified runtime profile blocks development.
The pinned PostgreSQL image must already be available locally; missing
prerequisites are reported rather than silently installed.

```sh
fleur dev
# Agent workflow:
fleur dev --background
fleur status --json
fleur logs --limit 20 --json
fleur stop
fleur dev --background
```

Foreground development stops when its launcher or terminal session closes,
including abrupt launcher death. Background development survives its caller.
Repeated invocation reports the existing instance and never transfers shutdown
ownership to a second foreground caller. `stop` is idempotent. A failed instance
requires explicit `stop`, correction of the cause, then `dev`; observation never
restarts it. There is no separate restart command.

Fleur binds storage to repository project metadata and the machine-local
checkout's canonical filesystem identity. New projects contain a portable
`projectId` in `fleur.json`. Local paths, resource identities, ports, credentials,
logs and ownership journals stay in private machine state. A copied checkout,
including ignored files, gets a new storage binding and copies no database data.
Foreign containers and volumes are never silently adopted.

Application binding defaults to `127.0.0.1`. Automatic ports start at 3000; the
reported URL contains the selected port. `--port <number>` reserves exactly that
port and fails if occupied. `--host <address>` accepts an IP address or localhost.
An explicit broad bind warns that v1 has no authentication. PostgreSQL and the
authenticated lifecycle control endpoint remain on loopback.

## Readiness and source updates

Readiness defaults to 60 seconds, adjusted with `--timeout <seconds>`. It requires
connected compatible PostgreSQL, admitted source, usable server rendering and
browser assets, and functioning reactive delivery. Merely finding a process is
insufficient. Status distinguishes starting, ready, maintenance, failed and
stopped. Inspecting a failed instance succeeds with exit 0 and `ready: false`.
The status database probe has its own five-second default; explicit timeout
replaces it. Inspection does not start resources or repair database state.

Only startup calls the shared new-database initializer. A database Fleur created
for a provably never-initialized binding receives the reviewed migration chain
and declared seeds in one transaction. An empty chain remains new. Initialized,
adopted or previously emptied databases keep the explicit migration/seed flow.
Reload never initializes a database. See [maintenance](maintenance.md).

An invalid edit retains the last valid application and safe file/line/action
diagnostics in `logs`. Correct source and save again. Publication rechecks the
latest admitted snapshot after drain and retirement so an older compilation
cannot replace a later edit. If a save races retirement, the owner restores the
last valid immutable snapshot before trying the latest source. This rollback
does not replay initialization, migrations, seeds or mutations.
Server and browser compilation use that same snapshot. A changed browser
source generation loads its matching island module in the existing browser
runtime and reopens the reactive view. Keyed islands keep their draft values,
focus and component state; replacement does not reload the document. Submitted
mutations are never replayed.

Compatible source edits replace island code automatically. Incompatible or
uncertain hook layouts retain the previous browser generation, draft, focus and
unknown-mutation state. A stale diagnostic says to navigate or reload explicitly;
that deliberate navigation loads the new generation. Fleur never resets a draft
or replays a submitted mutation to make replacement succeed. Old browser
operations receive a known source-changed refusal before reaching the new app.
Current schema and maintenance fencing remains authoritative.

The compatibility proof recognizes directly imported hooks in unconditional
prefix statements of inline declared island components. It compares hook order,
bindings, state/memo/ref initializers, effect configuration and props/declaration
dependencies. Pure query results used through useQuery are invalidated before
compatible code receives fresh values. Custom hooks, dynamic aliases, conditional
layouts, classes and uncertain local call paths require explicit navigation after
an application edit. Declaration/shared-schema changes may also conservatively
require navigation. One uncertain module conservatively guards the whole browser
graph, so some safe edits also require navigation. This analysis does not migrate state or prove arbitrary
JavaScript behavior. Unchanged server-only edits continue automatic replacement.

Published immutable browser modules and styles remain available to retained views
until stop, within a 256 MiB cache. A capacity refusal preserves the current app;
explicit stop and dev clears these disposable assets without deleting data or
backups. Presentation assets retain their existing mutable no-cache URL contract.
Their admitted bytes participate in reload snapshots; invalid edits keep the last
valid bytes. Resource rendering can require a new navigation, as with ordinary
browser caching.

An incompatible source schema blocks database admission in the retained
application. Review and apply migrations explicitly, or restore compatible
source. Shared PostgreSQL maintenance fences independently protect queries,
mutations, migration, seed, reset and restore. Maintenance recovery requires the
existing state-verifying operations; never delete a maintenance marker.

## Stop, failure and recovery

Replacement and stop close new admission and drain within a 30-second bound.
A response lost after submission remains outcome-unknown. Inspect stored data
before deciding what to do; neither recovery nor reload replays the mutation.
Stop refuses held or queued database maintenance instead of interrupting it.

Stop also stops the owned PostgreSQL container. It preserves its persistent
volume, migration history and retained backup files. Disposal verifies ownership
and immutable resource identities. A PID record alone never authorizes a signal;
control also verifies kernel boot/start identity and an authenticated instance.
Separate projects cannot clean up each other's resources.

Crashes retain bounded logs and private recovery evidence. Fresh restricted
worker retirement after an operation is normal and is not an application crash.
If creation, retirement or cleanup cannot be verified, Fleur reports
`RECOVERY_REQUIRED`, retains ownership evidence and denies reuse. A successful
stop means owned disposable resources were verified retired. A timeout or
uncertain stop is not cleanup proof. Inspect `status` and `logs` and retry the
explicit stop only after the cause is resolved. Unsettled creation journals
require verified operator recovery; do not remove them to force a restart.
Data and backup deletion require their own deliberate authority.

## Machine output and bounded logs

A failed dev may include diagnostic partial data containing state and startup
initialization details; it still has `ok: false` and an error exit.
Background `dev`, `stop`, `status` and snapshot `logs` return one JSON version 1
result with the common exit categories. `logs` defaults to at most 200 records;
`--limit` accepts 1–200. Follow `cursor` while `truncated` is true. Cursors are
opaque, authenticated and bound to the local instance. An invalid or expired
cursor is exit 2; read a new snapshot instead of editing a token.

Foreground `dev --json` and `logs --follow --json` emit newline-delimited events
with `formatVersion`, `command`, monotonically increasing `sequence`, `event`
and `data`. Foreground dev starts with `starting`, then reports ready/state
changes. Log follow emits bounded `log-result` pages. Graceful completion ends
with `completed`, including the result and exit category. Force termination has
a signal-derived exit and may prevent a completion event. Diagnostic warnings
use stderr. Logs contain safe lifecycle and source diagnostics, never raw
compiler/Docker output, database URLs or credentials.

For an invalid reload: inspect `logs`, correct the reported source and verify a
new ready generation with `status` and the browser. For a crash: inspect status
and logs, explicitly stop, restart with dev and verify retained data. Production
artifact creation and `start` remain separate work.

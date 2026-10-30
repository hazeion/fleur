# Development lifecycle

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
latest admitted snapshot so an older compilation cannot replace a later edit.
Server and browser compilation use that same snapshot. A changed browser
source generation loads its matching island bundle in open browsers. This
source reload replaces the document; ordinary reactive database refreshes retain
keyed drafts, focus and island state. Submitted mutations are never replayed.

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

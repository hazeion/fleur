# Reactive database views

Managed mutations advance a durable database revision in the same transaction as
their writes. Rollback publishes nothing. Mutation success confirms commit and
does not wait for subscribers. Notifications wake the revision monitor; active
views also probe the authoritative revision at least once each second, including
when notifications disappear. Direct SQL writes have no automatic refresh
guarantee.

Server components use `readQuery`. Fleur tracks their dependencies and reconciles
server regions after commits. Use stable component and list keys to retain island
identity through reorder. Islands retain their local state, unsaved drafts and
focus when their validated props update. Application navigation, removal or a
changed key deliberately changes identity.
Keep a draft's expected row version with that draft. Receiving newer public props
does not authorize replacing its base version or silently overwriting an edit.

Browser islands use the inferred `useQuery` hook from `fleur/client`:

```tsx
const exercises = useQuery(listExercises, {});
if (exercises.data === undefined) {
  return <p>{exercises.error?.code ?? "Loading exercises"}</p>;
}
return <section>
  {exercises.stale && <p>Stored data may have changed.</p>}
  {exercises.error && <p>{exercises.error.code}</p>}
  <ul>{exercises.data.map(row => <li key={row.id}>{row.name}</li>)}</ul>
</section>;
```

The state exposes `status`, optional `data` and `error`, `stale`, `refreshing`, and
read-only `refresh()`. Query status is loading, success or error. The separate
`connection` field is connected, reconnecting or maintenance. A failed refresh retains any last complete result as stale. An
initial failure has no fabricated result. Failures are isolated to their query
or server region. `refresh()` resolves with success or an error code and never
replays a mutation.

Fleur deduplicates an operation plus canonical validated inputs within one
browser connection, including server dependencies. Consumers receive separate
copies of public values. At most 20 logical queries may be active per connection
and 100 per running project. Additional subscriptions receive `QUERY_LIMIT`;
healthy subscriptions remain. Server dependency changes at capacity can require
headroom until prior dependencies are released. Navigation, unmount and disconnect dispose their
subscriptions, with abandoned connections expiring within 30 seconds.
Concurrent equal reads at the same epoch and revision can share execution.
Each connection still counts its own logical subscription and receives separate
public values. Completed results are not cached across connections.

Responses bind a database epoch, page identity, connection generation, request
sequence and revision. Old responses cannot replace newer state. A second
revision probe closes the initial read/subscription race. A commit arriving
during a read triggers a trailing refresh until the final revision is observed.
Reconnect refreshes every active query before reporting it current. Maintenance
pauses access and invalidates earlier results. Trusted state outside PostgreSQL
prevents restoring a backup from making its old epoch current again.

For a disconnected or failed view, inspect its stale, error, reconnecting or
maintenance state. Reconnect or explicitly refresh the read after connectivity
returns. A mutation with an unknown outcome stays unknown until the application
reconciles stored state; refresh never proves exactly-once delivery and never
retries that mutation. Maintenance needing recovery requires inspection through
the documented [maintenance commands](maintenance.md).

The internal build/render adapter and
`tests/runtime/fixtures/reactive` demonstrate these contracts. Lifecycle CLI
commands and full reference-workload performance qualification remain their own
slices. External retrieval is separate from database subscriptions.

## Native execution

Application operations run in retained execution slots, as recorded in
[ADR 0001](adr/0001-reuse-application-containers.md). Each slot owns one
restricted application container whose init is an idle trusted process, plus one
guard host container. The application container keeps the one-CPU, 512-MiB,
64-PID ceilings, shared by its idle init, the operation process and trusted
inspection. It has a read-only root, no network, no shared-memory mount, no
mounts and no Docker socket. The guard host container has its own one-CPU,
256-MiB, 32-PID ceilings. A trusted controller owns the slot; application processes never
receive its channel.

Every operation starts a fresh operating-system process, so heap and module
state never carry over. A slot runs at most one operation at a time; up to four
slots provide independent capacity. Before application code evaluates, the
process installs its irreversible restrictions on every thread and closes
unrelated descriptors. The controller then independently inspects that exact
process's threads and descriptors. Before admission, a one-shot guard binds one
immutable operation, container, boot, process start identity and pidfd. No input
extends its deadline or selects another target. The five-second operation
deadline and 250-ms physical-exit tolerance are unchanged.

An operation completes only after its guard observes physical exit and the
container's cgroup again holds only its idle init. Mutation output validation
and that retirement precede commit. A busy, malformed or cancelled operation
fails only itself. Any uncertain ownership, admission, retirement or cleanup
quarantines the whole slot: its containers are removed, and it keeps occupying
capacity until that removal is verified. Controller loss closes the guard's control channel, which
kills the bound process. Shutdown closes admission, drains for up to 30 seconds
and verifies removal of every owned container.

While views are active, each idle slot keeps one prepared process waiting at its
admission gate. The scheduler replaces a prepared process 20 seconds after its
preparation completed, and the controller refuses admission 30 seconds after its
preparation began, preserving the original startup/admission bound. Waiting for
a slot and preparing a process precede an operation's five-second deadline, as
worker startup did before; that deadline starts when the guard is armed. This trades
bounded idle resource use for lower refresh latency.

## Qualification status

On Intel macOS with pinned Bun 1.4.3 and Docker Desktop, the retained-execution
qualification gates, the real two-view browser test, and the mutation and
maintenance browser tests pass. In those local runs a warm operation's guard
arming, execution and retirement took approximately 260 ms. Preparation took
another 300–350 ms when no prepared process was available. Cold slot creation
took approximately 2.3 seconds. These are local measurements, not performance
guarantees. Required platform qualification comes from the full CI matrix.

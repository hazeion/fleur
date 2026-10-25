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

The runtime prepares at most four standby operation workers, including workers
being retired. They execute one operation each and keep the existing native
restrictions and physical deadlines. Idle workers retire before the controller's
30-second admission deadline; active views replenish that bounded reserve.
This trades bounded idle resource use for lower refresh startup latency.

## Qualification status

This implementation has not met the approved native refresh timing gate and
must not be treated as release-qualified. On Intel macOS with pinned Bun 1.4.3,
the full suite's two-view native test failed to deliver the new client query
within five seconds after mutation success. Earlier exploratory runs on host
Bun 1.4.4 also failed: one delivered the query after approximately 5.4 seconds;
another delivered the query but did not update server props within the following
five seconds. Diagnostic operation times were approximately 4–5 seconds per query
and 4–5 seconds per server render, despite prepared one-shot workers. The fast
browser protocol tests pass against a controlled backend; they do not establish
native database performance.

The native execution/refresh mechanism requires further work or a live decision
under the approved specification's compatibility rule. Deadlines, physical
retirement, cleanup verification and freshness assertions remain unchanged.

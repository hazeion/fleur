# Host CLI startup measurement

The compatibility probe invokes the host's pinned `ctr` to observe and retire
owned resources. These host commands do not run inside an application worker.

The [pinned client constructor](https://github.com/containerd/containerd/blob/ee2735368117d2eb259779949d5e75cdafec9761/cmd/ctr/commands/client.go)
performs an optional `Introspection.Server` RPC to print deprecation warnings
before the requested command. The documented
`CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS=true` setting removes that optional
RPC. The authoritative version command still obtains both client/server
versions and revisions, and still performs its required server information RPC.
The setting is supplied in a fixed root host command environment after `sudo`;
application environment and authority are unchanged.

A local controlled experiment built the exact pinned upstream `ctr` source and
used a disposable Unix-socket gRPC server that delayed each introspection
response by 250 ms. It exercised the actual upstream CLI, client constructor,
and protocol, rather than a simulated CLI argument parser. Two observations per
setting, with settings interleaved, produced:

| Command | Default milliseconds | Optimized milliseconds | RPCs retained |
| --- | --- | --- | --- |
| `tasks list --quiet` | 338, 336 | 88, 84 | One task-list RPC; optional introspection reduced from one to zero |
| `version` | 592, 595 | 340, 338 | One version RPC and one required introspection; redundant introspection reduced from two to one |

All eight commands exited zero. This isolates the cost of one redundant RPC.
The imposed delay is a controlled reproduction, not a measurement of native CI
server latency. It does not explain the earlier zero-output cold-start delays.

Run the bounded native comparison before launching application workers:

```sh
python3 experiments/compatibility/runtime-probe/cli_latency.py > host-cli-latency.json
```

The command first verifies the actual host Docker association, root-owned socket
and executable, and exact client/server pins. It records that first authoritative
query's duration. It then measures one no-RPC banner and four version queries in
an interleaved default/optimized/optimized/default order. This avoids attributing
a warm executable alone to RPC removal. Each comparison has a root-owned
four-second command deadline, bounded termination escalation, and a five-second
outer fence. Failed commands remain failed measurements; the command exits
nonzero if either optimized version sample fails or cannot verify the exact
client/server pins. A failed default or banner sample remains marked failed, but
does not require the old slower path to satisfy the optimized command budget.
If a version sample fails, `baseline_comparable` is false and no speedup can be
inferred from that comparison.

Reports contain status, elapsed time and byte counts, never CLI output, UUIDs,
unknown environment values or credentials. They retain every sample instead of
selecting the fastest. Native AMD64 and ARM64 measurements are required before
claiming that CI startup latency improved. The existing 30-second application
operation limit and all isolation/lifecycle assertions remain in force.

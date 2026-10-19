# Host CLI startup measurement

The compatibility probe invokes the host's pinned `ctr` to observe and retire
owned resources. These host commands do not run inside an application worker.

The [pinned client constructor](https://github.com/containerd/containerd/blob/f2551031d7276a770f65f98c9b52e57e7dad07e8/cmd/ctr/commands/client.go)
performs an optional `Introspection.Server` RPC to print deprecation warnings
before the requested command. The documented
`CONTAINERD_SUPPRESS_DEPRECATION_WARNINGS=true` setting removes that optional
RPC. The authoritative version command still obtains both client/server
versions and revisions, and still performs its required server information RPC.
The setting is supplied in a fixed root host command environment after `sudo`;
application environment and authority are unchanged.

A local controlled experiment built the previously pinned upstream `ctr` 2.3.6
source at `ee2735368117d2eb259779949d5e75cdafec9761` and
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

The command first verifies the actual host Docker association and root-owned
socket/executable. Inside the existing 15-second startup envelope, it measures
one privileged no-op, then the first no-RPC ctr banner, then the authoritative
version query, identity audit and executable SHA calculation separately. The
query still must validate exact client/server pins. It explicitly records that
this first RPC follows startup probes, so it is not described as a cold binary
load. It then measures one warm no-RPC banner and four version queries in
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

## Containerd candidate update on October 15, 2026

[CI run 38805744792](https://github.com/hazeion/fleur/actions/runs/38805744792)
measured the same host builds on AMD64 and ARM64: Docker 28.0.4 commit
`6430e49`, containerd v2.4.1 commit
`f2551031d7276a770f65f98c9b52e57e7dad07e8`, and runc 1.5.2 commit
`v1.5.2-0-g29dd3dc2`. The existing exact 2.3.6 gate rejected the changed runtime
before observer or worker tests; this was an expected identity rejection.

The candidate now requires exactly those measured builds, including both ctr
client and containerd server revisions. Unknown versions, the earlier 2.3.6
build, changed revisions and missing components are rejected. Reports emit only
the accepted version/commit facts and bounded match flags on rejection. They do
not emit arbitrary runtime metadata. No runtime is installed or downgraded.

Source audit against the prior pin found the filter parser/scanner, event
exchange and subscription service, task/namespace protobufs and generated JSON
structs, and task RPC schema byte-identical. The CLI uses urfave/cli v3; the
reviewed event, namespace, version and task commands retain their argument and
RPC behavior, with `DisableSliceFlagSeparator` enabled. The optional deprecation
introspection setting is unchanged.

An executable oracle built from the exact new upstream commit accepted all three
observer filters, matched task start/exit and the owned namespace update,
rejected another namespace and another topic, and rejected the old unquoted
topic syntax. Actual generated event values retained the required field names:
`container_id`, `id`, `pid`, `exited_at` with numeric `seconds`/`nanos`, and
namespace `name`/`labels`; zero exit status remains omitted. The source-built new
CLI also accepted the observer's three filter arguments and reached its socket
access check. These source checks establish a candidate, not a native CI pass.

The earlier controlled timing table applies only to 2.3.6. Native 2.4.1 timings,
readiness, lifecycle termination and cleanup still require successful AMD64 and
ARM64 CI evidence before compatibility or speed improvements are claimed.

## Native measurements and remaining first-use cost

[CI run 38807006869](https://github.com/hazeion/fleur/actions/runs/38807006869)
passed both exact host identity and CLI comparison checks on containerd 2.4.1.
AMD64 version samples were 19/19 ms with the default RPC and 18/19 ms with the
optional RPC suppressed. ARM64 samples were 13/15 ms and 12/12 ms respectively.
Warm no-RPC banners were 17 ms and 11 ms. The native difference is 0–3 ms; the
250 ms controlled-server result above is not the native speedup.

The earlier report's `first_authoritative_version_ms` values, 2168 ms and
2208 ms, included the version subprocess, identity audit and executable read/SHA.
Those aggregate values cannot identify a slow RPC or executable startup. New
reports separate `privileged_noop`, `ctr_banner`, `authoritative_version`,
`identity_audit` and `binary_sha256` milliseconds, and retain their aggregate as
`host_startup_duration_ms`. `first_authoritative_version_ms` now measures only
the actual subprocess. The no-op distinguishes first sudo/session startup; the
first banner isolates ctr loading without server calls; the following version
command measures the remaining first RPC work; hashing is measured afterward.

Only the standalone performance benchmark requests these two initial probes.
The lifecycle driver's normal identity check adds no extra commands. Probes
consume the same startup budget and the final observation must still occur
before 15 seconds; all application operation limits remain unchanged. A slower
phase must be observed before changing its code or claiming the first-use cost
has been fixed.

The first no-op and banner are diagnostic samples. A failed sample remains
`passed: false` in `host_startup_probes`, with its elapsed time, timeout status,
return code and available byte counts. It is not retried. If the original
15-second startup envelope still has time, the mandatory authoritative query
continues and must verify the exact identities. No-op/banner failure cannot
substitute for a failed required query or optimized comparison sample. If the
required path fails, the JSON retains a fixed allowlist of numeric/status
observations and completed phase timings; unknown fields and raw output are
removed. The normal lifecycle inspection still adds no diagnostic commands.

Run 38812419549's AMD64 benchmark failed at `ctr_banner`, but its old error
report omitted status/count evidence, so the cause cannot be inferred from that
artifact. The exact source-built 2.4.1 CLI accepts bare `--version` and exits
successfully; the next native report must establish what failed on the runner.

## Docker host preflight

ARM run 39287256479 timed out before the ctr phases with zero CLI output. The
old report called all three Docker commands `host-command`, so it cannot identify
which command or initialization phase stalled. Run 39288543603 passed that same
preflight on both architectures before this change; the failure is intermittent.

Docker 28.0.4's [info command](https://github.com/docker/cli/blob/v28.0.4/cli/command/system/info.go#L77)
lists CLI plugins before retrieving server information, even with a server-only
format. [Plugin discovery](https://github.com/docker/cli/blob/v28.0.4/cli-plugins/manager/manager.go#L128)
collects candidate metadata. This is avoidable work for fixed default-daemon
metadata, but the failed run does not prove it caused the timeout.

The preflight now reads only `GET /v1.48/info` and `GET /version` directly from
the verified root-owned default Unix socket. The parent directory and socket
identities are retained and rechecked around the reads. Responses must be HTTP
200 JSON objects within 64 KiB. An absolute timer interrupts slow or trickled
responses through a retained socket, including response/connection cleanup.
All socket and directory descriptors are closed.

One ambient `docker info --format '{{.ID}}'` remains mandatory. Its returned ID
must exactly match the default API's ID; merely naming the same endpoint does
not prove association. Docker, containerd and runc version/revision requirements
are unchanged. No socket or host capability is passed into application workers.

The three former independent five-second command bounds become one 15-second
Docker preflight budget, retaining their previous aggregate maximum. Each step
receives only the remaining time, and late final observations fail. The separate
15-second ctr prerequisite budget and 30-second application deadline are
unchanged. Reports identify `docker-default-info`, `docker-default-version`,
`docker-active-info`, or association/deadline failure, with safe timings and
counts. Native CI must establish the resulting latency; no measured speedup is
claimed from this source-based removal of two CLI launches.

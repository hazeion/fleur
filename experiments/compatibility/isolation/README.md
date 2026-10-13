# Isolation compatibility experiment

Subset of [Prove compatibility and runtime isolation](https://github.com/hazeion/fleur/issues/23), governed by the [runtime boundary](../../../docs/planning/V1-SPEC.md#runtime-isolation-and-production-feasibility-gate). The original read-only diagnostic was collected on October 13, 2026. It deliberately reports blocked and does not evaluate applications. Subsequent [native runtime](../runtime-probe/README.md) and [real database/broker](../database-broker/README.md) experiments execute restrictions and registered operations; their results supersede the initial absence of a runner. The aggregate gate remains open for effective container-configuration inspection and actual CPU-busy worker deadline/healthy-worker evidence. No completed production artifact exists.

## Executed evidence

The available host reports Darwin/x86_64. `docker` is absent from PATH. A native Linux seccomp test cannot run on this host, and no Linux Docker runner was supplied for that initial local diagnostic. Hosted native Linux runners were subsequently used successfully. This establishes a missing runner, not a failure of the chosen isolation mechanism.

Run the read-only diagnostic from the repository root:

```sh
python3 experiments/compatibility/isolation/preflight.py
python3 -m unittest discover -s experiments/compatibility/isolation -p 'test_*.py'
```

The diagnostic emitted JSON with `gate: "blocked"`, `applicationEvaluated: false`, and blockers for missing Docker, missing image pin, unverified bootstrap and unexecuted security/resource tests. It exited 2. It always exits 2, including when Docker and a local image are present. Python is a disposable experiment tool, not a Fleur application or runtime prerequisite.

Four diagnostic tests passed twice. They cover missing prerequisites, rejection of a mutable image tag, unavailable daemon error redaction, and refusal to equate an available daemon/local digest image with isolation proof. The daemon fixtures are executable test scripts. They establish diagnostic behavior only; they do not represent executed Docker, Linux or Bun security tests. Initial tests failed because the diagnostic file did not exist. That failure is not a requirements-based red test for the security contract, and no syscall or broker regression proof is claimed.

The diagnostic uses only Docker `version` and local `image inspect`, with a five-second timeout per command. It never pulls, builds, imports or launches an image, installs prerequisites, reads application code or exposes raw subprocess errors. An optional `--image repository@sha256:...` checks local image presence/architecture only. No supplied image can make this diagnostic pass the gate.

## Available upstream candidate image pins

An anonymous Docker Hub registry request for `oven/bun:1.4.3` returned an OCI index with Linux amd64 and arm64 manifests. Downloaded index and architecture-manifest bytes were independently hashed and matched their SHA-256 references:

| Object | Digest |
| --- | --- |
| Index | `sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598` |
| Linux amd64 | `sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e` |
| Linux arm64 | `sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023` |

Metadata came from the [official Bun repository on Docker Hub](https://hub.docker.com/r/oven/bun), through its registry API. The inventory itself downloaded no layers and checked no contained runtime. The later native runtime and database experiments executed these exact architecture manifests with Bun 1.4.3 and frozen compiler pins; see the [durable evidence](../evidence.md). They are executed base-image compatibility pins for the bounded probes, not selected Fleur release images or production OCI archive digests. A complete production artifact remains later work.

## Historical probe requirements

Use a disposable Linux Docker runner for each required architecture, with recorded host kernel, Docker/container runtime versions and immutable image digests. Docker on macOS can provide Linux containers, but native Darwin does not provide Linux seccomp. A runner also needs an exact Bun binary, exact rendering dependencies and a native compiler/helper build pin. These prerequisites were missing at the initial inventory stage; the separate native probe now supplies and executes them.

A bounded first probe should determine whether a trusted Bun bootstrap can load its native restriction helper and runtime necessities, retain only admitted broker/log and required runtime descriptors, install no-new-privileges and a synchronized final filter, then evaluate the admitted bundle. The [Bun FFI documentation](https://bun.sh/docs/runtime/ffi) describes a possible trusted native-call bridge, but marks FFI experimental. It is a candidate to test, not a supported security integration. [Compiled Bun executables](https://bun.sh/docs/bundler/executables) bundle code/assets; this does not prove that startup or later module/runtime work avoids filesystem access.

Do not statically import application modules into an unrestricted entrypoint. Verify evaluation ordering with an adversarial top-level module fixture and an externally observed side effect. Dynamic bundled imports may still require runtime work; determine that on the real pinned executable. If a future native Bun source hook is required, its exact source revision and rebuilt binary digest must be pinned before testing. This inventory did not verify an embedding hook; the later probe instead executes a trusted FFI restriction bridge before compiling/evaluating its inert application source.

[Linux seccomp](https://man7.org/linux/man-pages/man2/seccomp.2.html) requires explicit handling of synchronization failure, including a positive thread-ID return under TSYNC. Every nonzero installation result must terminate before application evaluation. Filters are inherited by subsequently created threads, but thread creation policy and Bun/JIT compatibility still need execution tests. A helper that only filters its calling thread cannot satisfy the contract.

The following requirements guided the implemented native and database probes. Their executed scope is recorded separately; they are not passes from this inventory diagnostic:

- Existing Bun threads and any later threads cannot bypass the final restriction; failed synchronization never reaches an application module.
- Filesystem opening/mutation and syscall alternatives fail, including open/openat/openat2, inherited-file misuse, dynamic native loading and io_uring paths. Verify architecture-specific syscall ABI handling.
- New sockets/connects, subprocess/process execution, namespaces, debugging and privilege changes fail. No descriptor transfer or duplicated unrelated descriptor restores authority.
- The sole admitted broker channel supports rendering and registered database-proxy operations. Malformed, cross-operation and arbitrary SQL/URL/path/shell requests cannot broaden authority. Apply request bounds and test disconnects and stalled workers.
- A real container has no host secrets, Docker socket, database credentials, ambient outbound network or writable host mounts. Measure the one-CPU, 512-MiB, 64-PID cgroup limits.
- Real disposable PostgreSQL and broker tests prove cancellation, rollback, safe connection reuse, worker termination, healthy-worker separation and committed-versus-unknown outcomes.

Do not use Docker's default seccomp policy, a read-only root, JavaScript global replacement or an alternative runtime as a passing substitute. If executed Bun probes show the approved contract cannot work, return the affected decision to live human discussion. Missing prerequisites keep the gate open without changing the decision.

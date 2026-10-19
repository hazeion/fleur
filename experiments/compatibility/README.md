# Fleur compatibility experiments

These disposable experiments establish the initial mechanism evidence required by [issue #23](https://github.com/hazeion/fleur/issues/23) and the [approved specification](../../docs/planning/V1-SPEC.md). They are not an installable Fleur CLI or the completed application runtime.

[PR #39](https://github.com/hazeion/fleur/pull/39) merged after all fifteen checks passed at `ba3769df6debc468c6ff7a8ccacad52fdf30f2ee`. The [durable evidence record](evidence.md) records the actual tested platforms, exact pins, results and limitations. Earlier failed experiments remain documented as historical evidence; they are not the current check results.

Five of issue #23's seven acceptance criteria have executed evidence: rendering/browser boundaries, pre-evaluation restrictions, effective container authority/resource limits, internal tooling, and the recorded platform matrix. [Run 38478108428](https://github.com/hazeion/fleur/actions/runs/38478108428) passed fourteen of fifteen checks at `683dc3855b9d9394a173e27d5ca4c12c049ee4c3`. AMD64 completed both restricted busy/healthy lifecycle repetitions; ARM64 emitted the healthy worker report but did not establish its exit before the deadline. The broker/lifecycle criterion and final consolidated verification remain open. Dependent implementation stays blocked until both architectures satisfy the required mechanism, applicable checks and independent review pass. Resource limits and the 30-second operation deadline remain unchanged.

## Experiments

| Experiment | Executed scope |
| --- | --- |
| [Tooling](tooling/README.md) | Frozen Zod/tRPC/Drizzle inference, strict Microsoft compiler, declaration provenance and independent lint engines |
| [Rendering](rendering/README.md) | Bun/Preact SSR, validated islands, draft/focus-preserving refresh and browser artifact exclusions |
| [Native platforms](platforms/README.md) | Native Intel/Apple Silicon macOS and Ubuntu 24.04/26.04 on both architectures |
| [Distribution fixtures](distro-fixtures/README.md) | Debian 13 on both architectures and exact Arch x86_64 package snapshot, in matching-native-architecture containers |
| [Native runtime](runtime-probe/README.md) | Pre-evaluation all-thread restrictions, negative syscall/descriptor controls, admitted rendering/IPC and measured CPU/memory/PID limits |
| [Database and broker](database-broker/README.md) | Owned disposable PostgreSQL, registered authority, transactions, cancellation, rollback and unknown commit outcomes |
| [Isolation inventory](isolation/README.md) | Read-only prerequisite diagnostic; deliberately reports blocked rather than claiming an isolation pass |

Python is a diagnostic/test tool for these experiments. Runtime and browser fixture commands use Bun; there is no separate Node browser prerequisite. Experimental Rust remains unavailable until its exact package/upstream equivalence checks execute successfully. Microsoft TypeScript is the verified default; no fallback compiler is selected.

## Local and CI verification

Use the [command catalog](evidence.md#verification-commands), then each experiment's detailed instructions. Binaries, dependencies, generated builds and database data belong to disposable owned resources. Never supply development or production PostgreSQL data to an experiment.

[Compatibility CI](../../.github/workflows/compatibility.yml) runs on pull requests, with read-only repository permission, immutable checkout/artifact action pins, no persisted checkout credentials and no supplied secrets. It uses checksum-verified Bun archives, frozen lockfiles and explicit browser/library provisioning on disposable runners. Browser cases run twice; database cases and distribution tooling also run twice. Failures remain failures. Artifacts retain bounded diagnostics for seven days; the committed evidence record preserves sanitized identities and results beyond that retention window.

GitHub runner images change. Their recorded OS/kernel/image identity is executed evidence, not an immutable release image. Debian/Arch results concern container userspace on the recorded Ubuntu host kernel. Native Debian/Arch Docker installation and macOS Docker readiness are not proved here. Packed CLI, self-contained production artifacts and full application admission are later implementation/release gates.

## Historical red evidence

The [first PR run](https://github.com/hazeion/fleur/actions/runs/38427572433) passed rendering but failed full strict Drizzle declarations. The exact source-backed declaration repair subsequently passed without `skipLibCheck` or runtime changes. The [early native run](https://github.com/hazeion/fleur/actions/runs/38428505562) established a smaller restriction probe; later runs added descriptor, all-thread, real broker and cgroup evidence. The original ambiguous memory exit failed its attribution requirement; direct kernel OOM counters and child signal now establish the cause. An ARM64 repeat timed out under the unchanged 30-second bound; the final PR #39 run passed both native architectures with diagnostic instrumentation and the frozen compiler pins. It does not establish the cause or absence of all future stalls.

## Implementation graph

Issue #23 is the initial compatibility gate. Once it closes, native GitHub blocking relationships enable project setup, exercise reads and exercise writes. Subsequent tickets implement maintenance, reactive delivery, templates, retrieval, session snapshots, import enforcement, lifecycle, packaging and release verification. A passing experiment proves its observed mechanism; it does not complete those product features.

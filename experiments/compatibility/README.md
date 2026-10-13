# Fleur compatibility experiments

These disposable experiments begin [Prove compatibility and runtime isolation](https://github.com/hazeion/fleur/issues/23). They are not Fleur's application runtime or CLI. The [approved specification](../../docs/planning/V1-SPEC.md) defines the acceptance gate. A successful experiment proves only the behavior it actually exercises.

The gate remains open. No dependent implementation ticket may start until its rendering, isolation, broker, database, tooling and platform evidence is complete. In particular, a Docker inventory or an upstream image digest does not prove restrictions apply before application evaluation.

## Experiments

- [Tooling](tooling/README.md) checks exact candidate availability, internal library execution, inference and independent lint engines.
- [Rendering](rendering/README.md) exercises server rendering and validated interactive islands in a pinned browser fixture.
- [Isolation](isolation/README.md) inventories prerequisites without evaluating application code and records the unexecuted Linux security probes.

Follow each experiment's instructions. Dependencies and binaries belong to disposable experiment directories. Python is a diagnostic/test tool for these experiments, not a Fleur runtime prerequisite. No script may use development or production PostgreSQL data.

## Implementation graph

The GitHub issues' native blocking relationships govern scheduling. The current frontier begins with the compatibility gate. Once it passes, the first slices are project setup, exercise reads and exercise writes. Backup and maintenance then enable migration/recovery and seed/reset work; committed-data refresh enables templates and external retrieval. Session snapshots follow templates. Import enforcement follows retrieval, lifecycle combines those prerequisites, and production packaging precedes upgrades and final release evidence.

Keep unfinished tickets open. Test results from these experiments cannot close the complete compatibility gate, establish platform support, or authorize a release.

## Scoped pull-request CI

[Compatibility experiments](../../.github/workflows/compatibility.yml) runs the existing diagnostic, tooling and rendering subsets on disposable GitHub-hosted Ubuntu 24.04 amd64 runners. It also runs on pushes to `implement/fleur-v1`. Jobs use read-only repository permission, disable persisted checkout credentials and receive no configured secrets. Checkout and artifact actions are pinned to immutable commits.

The tooling and rendering jobs obtain exact Bun 1.4.3 from the official `bun-v1.4.3` release's `bun-linux-x64.zip`. The downloaded bytes were independently checked on October 13, 2026 against SHA256 `3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18`, matching the official release asset metadata. CI checks that digest and the reported version again. It does not choose another runtime or invoke Node to run experiment commands. Both dependency graphs install with frozen lockfiles. Rendering explicitly provisions the pinned Playwright package's Chromium revision and required Linux system libraries with `install --with-deps chromium`; apt changes happen only on the disposable runner. Hosted runner images and distribution library updates are not immutable toolchain artifacts, so their OS label alone cannot establish release support.

The workflow runs isolation diagnostic tests, the complete tooling runner, rendering's production browser build, strict types, both lint engines, unit tests and two consecutive Chromium runs. Isolation preflight must report its documented blocked exit 2. That job can pass its diagnostic expectations while the isolation gate remains blocked. The tooling runner's known strict Drizzle declaration failure remains a failing job. It has no `continue-on-error`, compiler substitution or `skipLibCheck` exemption. All jobs finishing successfully would prove only these scoped checks, not the aggregate compatibility gate.

Diagnostic JSON and browser command logs are retained for seven days as CI artifacts even after failures. They contain fixture diagnostics and platform/runtime identifiers, not credentials or development database data. Tooling's report truncates individual output excerpts and includes their hashes. CI logs and artifacts must be read with that limit in mind.

The [first PR run](https://github.com/hazeion/fleur/actions/runs/38427572433) executed on October 13, 2026 at integration commit `eaa756c`. The Ubuntu 24.04 x86_64 runner reported kernel `6.17.0-1022-azure`, Python 3.12.3 and Bun `1.4.3+c6da4a4d3`. Rendering's build, strict types, both lint engines, four unit tests and three Chromium tests on each of two runs passed. Isolation diagnostic expectations passed while actual isolation remained blocked. Tooling frozen installs, runtime tests, scoped positive/negative inference and both lint engines passed. Full strict Drizzle declarations failed, and the complete workflow correctly concluded failure. These results do not establish the whole supported platform or compiler matrix.

There is still no tested restricted Bun worker, final synchronized seccomp filter, broker/database-proxy authorization, real disposable PostgreSQL integration, cancellation/resource evidence, packed CLI or production artifact. Remaining macOS, Ubuntu/Debian architectures and Arch matrix checks are separate obligations. A green diagnostic or rendering job cannot close the gate or enable dependent implementation.

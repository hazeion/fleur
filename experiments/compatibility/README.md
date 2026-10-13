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

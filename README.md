# Fleur

Fleur is a TypeScript application environment and a set of development tools for existing coding agents. It gives agents a consistent project layout, typed application APIs, and commands to develop and verify small full-stack browser applications.

[Application admission](docs/application-surface.md) checks imports, presentation
assets and styling before compilation. Browser transport and DOM guards enforce
the approved surface alongside CSP, with Tailwind generation and dynamic inline
JSX styles.

[Reactive database views](docs/reactivity.md) refresh server regions and island
queries after managed commits, with explicit stale/error states, reconnect
recovery and preservation of keyed drafts, focus and local state.

Fleur is in early implementation. The unpublished Bun package currently provides help, safe project creation with `new` and `init`, prerequisite diagnosis and scoped setup grants. The read-page and mutation slices supply inferred contracts, restricted database reads, atomic versioned writes, server pages and validated islands. See [atomic mutations](docs/mutations.md) for form outcomes and concurrent-edit protection. [External retrieval](docs/retrieval.md) obtains validated API data from declared destinations through a trusted host broker, with server-only credentials, bounded deadlines and sizes, and typed failures. Owned seed reconciliation and approved development reset now share maintenance ownership with reviewed migrations, drift detection and explicitly approved restore/reconciliation with database inspection and restore-verified backups; see [maintenance](docs/maintenance.md). [Development lifecycle](docs/development.md) supplies foreground/background development, verified readiness, safe source reload, status, bounded logs and stop with persistent data. [Production artifacts](docs/production.md) build and start a self-contained application against separately configured PostgreSQL. See [read pages](docs/read-pages.md) for application APIs.

The entry point is `bunx fleur`, with Bun installed beforehand. Until a release is published, run `bun bin/fleur.ts --help` from this checkout. Project creation uses exact release pins. An older project pin requires its matching project-local Fleur installation; the launcher never fetches a replacement automatically.

See [exact upgrades and generated guidance](docs/upgrades.md) for offline docs, safe refresh and verification.

See [CLI usage](docs/cli.md), [project creation](docs/project-creation.md) and [prerequisite setup](docs/setup.md). Setup admits exact reviewed Ubuntu/Debian x64 package profiles and Intel Docker Desktop application placement, with separate human authority for each effect. The Intel macOS 15.7.7/Desktop 4.96.1 runtime tuple has passed native qualification and packed Doctor/setup verification; by human decision ([#118](https://github.com/hazeion/fleur/issues/118), 2026-10-30) that measured tuple is a floor, so newer Docker Desktop, Engine/CLI, Compose, containerd, runc and linuxkit releases with the same isolation options are admitted on that host. The approved [version floors amendment](https://github.com/hazeion/fleur/issues/124) (2026-10-31) generalises that decision: every required target's measured tuple becomes a version floor for Bun, Docker components, the OS release and the kernel, with identity facts exact; the CLI applies it as its implementation issues land. Other runtime tuples remain unverified; placement alone does not establish readiness.

Required v1 targets are Intel macOS, Ubuntu 24.04/26.04 x64 and Debian 13 x64. Apple Silicon, other ARM64 targets and Arch are deferred. Existing CI coverage and measured component evidence remain, but full support is claimed only for published version floors and the measured rows behind them. See the [approved platform amendment](https://github.com/hazeion/fleur/issues/5#issuecomment-6385377944).

The agreed first version uses Bun, Preact, Tailwind, Vite, and PostgreSQL on macOS and Linux. Server functions and components are the default, with interactive client islands. Docker manages development PostgreSQL and isolates application execution in development and production. Authentication and hosted deployment are deferred.

See [the agreed scope](docs/planning/V1-SCOPE.md) and [the completed Wayfinder map](https://github.com/hazeion/fleur/issues/1) for the planning decisions.

The [approved v1 specification](docs/planning/V1-SPEC.md) assembles the agreed contracts, acceptance gates, and implementation sequence. Implementation requires separate authorization and begins with mandatory compatibility validation.

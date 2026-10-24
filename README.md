# Fleur

Fleur is a TypeScript application environment and a set of development tools for existing coding agents. It gives agents a consistent project layout, typed application APIs, and commands to develop and verify small full-stack browser applications.

Fleur is in early implementation. The unpublished Bun package currently provides help, safe project creation with `new` and `init`, prerequisite diagnosis and scoped setup grants. The read-page and mutation slices supply inferred contracts, restricted database reads, atomic versioned writes, server pages and validated islands. See [atomic mutations](docs/mutations.md) for form outcomes and concurrent-edit protection. Application lifecycle commands are still being built; see [read pages](docs/read-pages.md).

The entry point is `bunx fleur`, with Bun installed beforehand. Until a release is published, run `bun bin/fleur.ts --help` from this checkout. Project creation uses exact release pins. An older project pin requires its matching project-local Fleur installation; the launcher never fetches a replacement automatically.

See [CLI usage](docs/cli.md), [project creation](docs/project-creation.md) and [prerequisite setup](docs/setup.md). Setup admits exact reviewed Ubuntu/Debian x64 package profiles and Intel Docker Desktop application placement, with separate human authority for each effect. The exact Intel macOS 15.7.7/Desktop 4.96.1 runtime tuple has passed native qualification and packed Doctor/setup verification. Other runtime tuples remain unverified; placement alone does not establish readiness.

Required v1 targets are Intel macOS, Ubuntu 24.04/26.04 x64 and Debian 13 x64. Apple Silicon, other ARM64 targets and Arch are deferred. Existing CI coverage and measured component evidence remain, but full support is claimed only for published qualified tuples. See the [approved platform amendment](https://github.com/hazeion/fleur/issues/5#issuecomment-6385377944).

The agreed first version uses Bun, Preact, Tailwind, Vite, and PostgreSQL on macOS and Linux. Server functions and components are the default, with interactive client islands. Docker manages development PostgreSQL and isolates application execution in development and production. Authentication and hosted deployment are deferred.

See [the agreed scope](docs/planning/V1-SCOPE.md) and [the completed Wayfinder map](https://github.com/hazeion/fleur/issues/1) for the planning decisions.

The [approved v1 specification](docs/planning/V1-SPEC.md) assembles the agreed contracts, acceptance gates, and implementation sequence. Implementation requires separate authorization and begins with mandatory compatibility validation.

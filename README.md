# Fleur

Fleur is a TypeScript application environment and a set of development tools for existing coding agents. It gives agents a consistent project layout, typed application APIs, and commands to develop and verify small full-stack browser applications.

Fleur is in early implementation. The unpublished Bun package currently provides help, safe project creation with `new` and `init`, prerequisite diagnosis and scoped setup grants. The application runtime is still being built.

The entry point is `bunx fleur`, with Bun installed beforehand. Until a release is published, run `bun bin/fleur.ts --help` from this checkout. Project creation uses exact release pins. An older project pin requires its matching project-local Fleur installation; the launcher never fetches a replacement automatically.

See [CLI usage](docs/cli.md), [project creation](docs/project-creation.md) and [prerequisite setup](docs/setup.md). Native release installation profiles remain unverified. Setup can inspect required actions and manage expressly authorized smoke-image acquisition, but assisted Docker package installation is blocked pending that evidence.

The agreed first version uses Bun, Preact, Tailwind, Vite, and PostgreSQL on macOS and Linux. Server functions and components are the default, with interactive client islands. Docker manages development PostgreSQL and isolates application execution in development and production. Authentication and hosted deployment are deferred.

See [the agreed scope](docs/planning/V1-SCOPE.md) and [the completed Wayfinder map](https://github.com/hazeion/fleur/issues/1) for the planning decisions.

The [approved v1 specification](docs/planning/V1-SPEC.md) assembles the agreed contracts, acceptance gates, and implementation sequence. Implementation requires separate authorization and begins with mandatory compatibility validation.

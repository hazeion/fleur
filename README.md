# Fleur

Fleur is a TypeScript application environment and a set of development tools for existing coding agents. It gives agents a consistent project layout, typed application APIs, and commands to develop and verify small full-stack browser applications.

Fleur is currently in planning. There is no installable CLI or application runtime yet.

The planned entry point is `bunx fleur`, with Bun installed beforehand. Fleur will detect missing Docker prerequisites and offer installation with human authorization.

The agreed first version uses Bun, Preact, Tailwind, Vite, and PostgreSQL on macOS and Linux. Server functions and components are the default, with interactive client islands. Docker manages development PostgreSQL and isolates application execution in development and production. Authentication and hosted deployment are deferred.

See [the agreed scope](docs/planning/V1-SCOPE.md) and [the completed Wayfinder map](https://github.com/hazeion/fleur/issues/1) for the planning decisions.

The [approved v1 specification](docs/planning/V1-SPEC.md) assembles the agreed contracts, acceptance gates, and implementation sequence. Implementation requires separate authorization and begins with mandatory compatibility validation.

# Fleur planning: Lakebed reference review

Sources reviewed on October 12, 2026:
- https://lakebed.dev/agents.md
- https://docs.lakebed.dev/
- https://docs.lakebed.dev/reference/
- https://docs.lakebed.dev/database/

## Confirmed Fleur direction

Fleur prepares an environment for an existing coding agent. It owns application APIs and runtime behavior for full-stack browser applications. V1 targets macOS and Linux with TypeScript, Bun, Preact, Tailwind, Vite, and Docker-managed PostgreSQL. Client/server contracts must provide inferred types and runtime validation. Auth and hosted deployment are deferred. The planning destination is a build-ready specification, including the process for developing and testing Fleur itself.

## Useful Lakebed patterns

Lakebed's agent guide begins with explicit creation commands, tells agents to read generated project instructions, and makes CLAUDE.md import AGENTS.md. It gives directory boundaries, supported APIs, prohibited assumptions, and links to focused documentation. It directs agents to inspect data and logs and verify actual behavior.

Its documentation uses fixed server/client entry points and pure shared TypeScript. A type-only server import provides client API inference. Tailwind is integrated into the build. The documented development database resets on restart.

Its CLI reference describes structured runtime inspection, bounded database views, a build independent of deployment, and explicit handling of uncertain mutation results. Client queries subscribe to updates. Arbitrary application npm packages and CSS files are restricted in the documented version.

## Initial proposals and subsequent decisions

- One authoritative generated AGENTS.md, with a CLAUDE.md reference and documentation matched to the installed Fleur version.
- A doctor command that reports prerequisite failures and precise recovery steps.
- A project explanation command covering file layout, registered APIs, schema, and available tools.
- Versioned JSON command results with operation status, error codes, and actionable next steps. Diagnostic output should not corrupt JSON output.
- Project-specific runtime discovery so agents need not guess ports or process identities.
- Persistent PostgreSQL volumes; separate disposable test databases; explicit destructive resets.
- First-class verification commands for types, runtime contracts, database integration, browser behavior, and the production artifact.
- Validate request inputs and outputs from shared contracts; enforce client/server import boundaries.
- Document transaction guarantees and avoid automatic retries of writes whose outcome is unknown.
- Rejected during discovery: ordinary application CSS and arbitrary package additions. Fleur supplies an approved package surface and Tailwind-only styling; agents may suggest additions but cannot install them independently.
- Keep the short agent guide task-oriented and move detailed API material into focused, locally available references.

These are recommendations for Fleur's scope and contracts, not claims that Lakebed lacks every corresponding feature.

## Workout proof proposal

- Exercise: reusable named exercise.
- Workout template: named, ordered exercises with target sets and repetitions.
- Workout session: dated record with performed sets, repetitions, and optional weight.
- A recorded session preserves its own details when a template changes.
- Demonstrate create, save, reopen, invalid-input rejection, atomic multi-row saves, restart persistence, and production execution.
- Exclude accounts, timers, coaching, charts, social features, and integrations.

## Further confirmed decisions

The workout proof uses one simple screen per workflow. Application agents may not install additional packages or author CSS outside Tailwind; they may only suggest package additions. Fleur owns its dependency scope. Automatic data updates across browser views are required, in addition to source hot reload. First-run setup should detect and help install missing Bun and Docker, including when initiated by an agent. The production contract is fleur build followed by fleur start with configured PostgreSQL.

## Live updates and setup research

Lakebed documents subscribed client queries and query invalidation following writable operations. Vite's HMR updates source modules; it does not synchronize application database changes. Fleur therefore needs a distinct reactive data contract, including reconnect behavior and post-commit notifications.

Sources: https://docs.lakebed.dev/capsule-api/ and https://vite.dev/guide/features.html

Bun supports official installation paths on macOS and Linux. Docker setup differs by OS: Desktop on macOS, distribution-specific Engine setup on Linux. Installation completion, runtime readiness, permissions, and any user-required steps must be separate states in Fleur's setup contract.

Sources: https://bun.sh/docs/installation ; https://docs.docker.com/desktop/setup/install/mac-install/ ; https://docs.docker.com/engine/install/

## Open decisions

The proof scope, constrained package and styling surface, automatic live updates, assisted first-run installation, production build/start, and independent review requirements are confirmed in docs/planning/V1-SCOPE.md. Remaining details are tracked in the Wayfinder map: https://github.com/hazeion/fleur/issues/1 .

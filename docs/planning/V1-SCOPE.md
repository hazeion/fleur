# Fleur v1: agreed scope

Confirmed through product discovery on October 12, 2026. This is the scope baseline, not the completed build-ready specification.

## Destination

A build-ready specification for Fleur's first version, including the development, testing, and independent review process used to build Fleur itself.

## Product

One invocation prepares an environment where an existing coding agent can quickly understand and build a small full-stack browser application. Fleur owns its application APIs and runtime rather than acting only as a scaffold for unrelated tools.

## Confirmed requirements

- TypeScript, Bun runtime, Preact, Tailwind, Vite, and development PostgreSQL managed through Docker. Server-default rendering uses interactive client islands. Docker also isolates application execution in production; production PostgreSQL is explicitly configured and separately managed.
- Required native targets are Intel macOS, Ubuntu 24.04/26.04 amd64 and Debian 13 amd64, under the [approved October 24 platform amendment](https://github.com/hazeion/fleur/issues/5#issuecomment-6385377944). Apple Silicon, other ARM64 targets and Arch are deferred and do not block v1 or #24. Each release must publish its exact verified OS/runtime matrix; exact macOS versions remain tied to Bun/Docker compatibility. Existing ARM/Arch tests and scoped evidence remain useful coverage, without establishing full release support. Safety, isolation, cleanup, repeat and deadline requirements remain unchanged for required targets.
- Consistent client/, server/, and shared/ layout.
- Fleur application and database APIs with inferred types and runtime validation. Type safety is a core requirement.
- Application agents use approved dependencies and Tailwind only. Additional packages may be suggested, never independently installed. Enforce dependencies, imports, and styling in development, verification, and builds.
- The v1 application dependency set is fixed. Tailwind's documented patterns, including inline styles and CSS variables, are allowed; application-authored and external stylesheets are rejected. CDN presentation assets are allowed; external JavaScript is rejected.
- Server functions and components are the default. Client components handle interaction and local UI state; application data retrieval and delivery use Fleur server operations. Direct browser data requests are rejected.
- Separate Fleur server retrieval operations can obtain external API data through a Fleur-owned capability with declared destinations, server-only credentials, timeouts, response-size limits, and runtime response validation. Network retrieval stays outside atomic database mutations. Applications explicitly handle retrieval failures.
- Automatic source updates through development tooling and reactive data updates across open views.
- Persistent development data, migration tooling, and explicit reset operations.
- Commands for project creation and explanation, prerequisite checks, development lifecycle, status and logs, migrations and seeds, database inspection, tests, types, lint, builds, and combined verification.
- Consistent help, exit codes, and structured JSON output for agents. Commands represent defined operations rather than arbitrary shell passthrough.
- Generated AGENTS.md and CLAUDE.md describing the application surface, layout, and workflow.
- Bun must be installed before invoking Fleur. First invocation checks compatibility and Docker readiness and offers authorized Docker setup. An agent can initiate explicit setup within human-granted permissions. Setup reports required human actions and can resume.
- fleur build produces the production application; fleur start serves it through Bun against configured PostgreSQL.
- `bunx fleur` is the entry point. Node/npm and a Node-based bootstrap are not required. The launcher is temporary; generated projects pin an exact Fleur version.

## Proof application

Use one simple screen per workflow:

- Exercises: a small catalog of reusable named exercises.
- Workout templates: named, ordered exercises with target sets and repetitions.
- Workout sessions: dated completed-workout records with sets, repetitions, and optional weight.

Recorded sessions retain their details when templates change. Demonstrate valid saves, invalid-input rejection, atomic multi-row saves, automatic updates in another browser view, persistence after restart, and operation of the production build.

## Building Fleur

Use TDD by default for meaningful testable behavior, with mandatory test-first work for critical contracts and regressions. Use Bun tests, real disposable PostgreSQL integration, Playwright browser checks, compiler type fixtures, oxlint plus remaining ESLint checks, and production-build verification. Separate reviewer agents challenge substantial changes, and automated checks run on pull requests. Tool pins and executable compatibility remain under research. The customized [Fleur TDD skill](../../.agents/skills/fleur-tdd/SKILL.md) is the planning reference for generated application guidance.

## Outside v1

Authentication, hosted deployment and hosting accounts, coding-agent launch/orchestration, Windows support, arbitrary application packages, application-authored stylesheets, external integration effects beyond approved data retrieval, and workout coaching, timers, analytics, social features, or integrations.

## Decisions still needed

The [approved specification](V1-SPEC.md) assembles approved behavior, command grammar, API reference families, failure handling, acceptance gates and implementation order. [Rendering research](../../research/server-rendering-capabilities.md) and [verification research](../../research/verification-tooling.md) record the selected direction and candidate pins. Mandatory initial compatibility experiments must establish actual tested versions and isolation before dependent implementation; documentation research is not executed support. Final human specification review is complete; implementation still requires separate authorization.

## Approved decision references

The [application-surface resolution](https://github.com/hazeion/fleur/issues/6#issuecomment-6140495358) revises the earlier client-only component model and blanket external-network restriction in #4. Server-default components and separate validated external retrieval are required; concrete rendering and capability enforcement still need resolution.

Migration, seed, and reset guarantees are recorded in [the approved migration resolution](https://github.com/hazeion/fleur/issues/7#issuecomment-6140996588). They require reviewed transactional migrations, verified backups, explicit destructive approval, drift checks, atomic seeds, and separate development/test identities.

Reactive query guarantees are recorded in [the approved reactive resolution](https://github.com/hazeion/fleur/issues/8#issuecomment-6141104247). Complete validated results refresh after managed commits, across server and client components. Fleur exposes stale/error states, refreshes on reconnect, recovers missed updates, and never automatically retries mutations.

Development lifecycle and production ownership are recorded in [the approved lifecycle resolution](https://github.com/hazeion/fleur/issues/9#issuecomment-6141277739). Fleur owns per-project development resources, preserves data on stop, verifies readiness, and builds a self-contained artifact served through Bun against explicitly configured PostgreSQL.

Commands and agent guidance are recorded in [the approved command resolution](https://github.com/hazeion/fleur/issues/10#issuecomment-6141388129). Named operations provide versioned JSON, stable exit categories, scoped authorization, bounded output, offline pinned-version documentation, and safe project creation without automatic commits.

Verification and workout acceptance are recorded in [the approved verification resolution](https://github.com/hazeion/fleur/issues/11#issuecomment-6142000930). TDD is the default for testable behavior, supported by a generated project-local skill. Tooling uses Bun tests, oxlint plus remaining ESLint checks, Playwright and real disposable PostgreSQL. Microsoft TypeScript is the default; pinned ts-rust is an experimental creation option after compatibility verification. Weight uses kg/lb exact decimals with at most two decimal places.

Performance targets and query limits are recorded in [the approved performance resolution](https://github.com/hazeion/fleur/issues/17#issuecomment-6142062428). They define reference workload, browser-visible percentile targets, subscription/result limits, and bounded external retrieval. These targets have not been benchmarked.

Documentation maintenance and recovery examples are recorded in [the approved documentation resolution](https://github.com/hazeion/fleur/issues/18#issuecomment-6142126729). Catalog-driven help and schemas stay synchronized with pinned local guidance; explicit docs refresh preserves user content, and recovery examples verify resulting state in disposable environments.

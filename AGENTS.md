# Developing Fleur

Read README.md, docs/planning/V1-SCOPE.md, CONTEXT.md, and the Wayfinder map before planning changes. Fleur is currently in planning: the map resolves decisions toward a build-ready specification. A proposed decision or roadmap entry does not authorize implementation.

## Product boundaries

- Fleur prepares an environment for an existing coding agent; it does not launch or manage coding agents.
- Application agents use Fleur-owned APIs, approved dependencies, and Tailwind only. They may suggest additional packages, but may not independently install them or author custom CSS.
- Distinguish Fleur's internal dependencies from the approved application surface. Internal library choices remain decision tickets.
- Preserve runtime validation, inferred client/server/database types, and server-only secret boundaries.
- Auth and hosted deployment are outside v1.

## Development process after specification approval

For nontrivial changes, define observable behavior, acceptance criteria, failure cases, and appropriate tests before implementation. Tests must derive from requirements, not simply mirror code.

Use test-first development for critical contracts and regressions. Confirm a regression test fails for the intended reason before fixing a bug. Implement the simplest behavior that satisfies the approved criteria.

Run meaningful relevant tests, type checks, lint, and production builds. Database behavior requires a real disposable PostgreSQL database; never use development data as test data. Key browser workflows require browser verification. Establish the actual tools and CI commands through the verification decision ticket before implementation.

Substantial features, security-sensitive changes, and major refactoring require a separate reviewer agent. Give it the original requirements and contracts. It must challenge behavior, tests, concurrency, and data integrity; it may add independent tests but must not silently modify production code, acceptance criteria, or existing assertions. Return defects to the implementation agent and verify fixes.

Never weaken tests merely to get a passing result. Resolve intended behavior changes explicitly. Report changes, tests actually executed, results, and remaining limitations. Never claim checks passed without running them.

Keep secrets, generated artifacts, runtime files, personal data, and machine-local paths out of tracked documents and issues.

## Planning tracker

Use docs/agents/issue-tracker.md. Keep decision detail in its issue and only a linked gist in the map. Research tickets may resolve independently; human decision tickets require live discussion. Do not resolve more than one human decision ticket per Wayfinder session.

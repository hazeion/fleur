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

## Project skills

For pull-request descriptions, read `.agents/skills/pr/SKILL.md` and use its Summary, Evidence, and Merge Danger format. Use Fleur terminology from CONTEXT.md. Report only verification actually performed; documentation changes can use file and diff checks as evidence.

Keep additional skill installations project-scoped under `.agents/skills/`.

## CI cost policy

Always consider CI cost when changing workflows or running verification. Prefer targeted local checks while diagnosing failures and rerun only failed CI jobs when investigating the same commit. The final candidate still requires all applicable checks to pass.

Cancel superseded pull-request runs within the same workflow and PR. Keep concurrency groups isolated across workflows and events, and preserve every main-branch verification run. Keep routine diagnostic artifacts for seven days; record durable sanitized evidence before it expires.

Save compute by eliminating obsolete or demonstrably duplicate work, never by weakening assertions, deadlines, required platforms, repeat runs, isolation, cleanup or acceptance gates. Preserve unique coverage when consolidating jobs. A cancelled or skipped check is not passing evidence. Do not raise spending limits or change billing settings without explicit user authorization.

## Planning tracker

Use docs/agents/issue-tracker.md. Keep decision detail in its issue and only a linked gist in the map. Research tickets may resolve independently; human decision tickets require live discussion. Do not resolve more than one human decision ticket per Wayfinder session.

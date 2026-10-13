---
name: fleur-tdd
description: Develop testable Fleur application behavior through requirements-based red-green-refactor cycles. Use for UI flows, server operations, database behavior, and regressions; use proportionate verification for documentation, purely visual edits, and exploratory work.
---

# Fleur test-driven development

This is the planning reference for the skill generated into Fleur applications. Fleur commands are specified contracts, not installed tools in this planning repository. Do not implement a runtime merely because this skill exists.

Read the project's AGENTS.md or CLAUDE.md and pinned-version Fleur documentation. Identify configured test suites, browser base URL, database isolation, and selected compiler before running commands. Use documented Fleur options for targeted tests; do not invent CLI flags or install missing tools independently.

## Red, green, refactor

1. Define observable behavior, acceptance criteria, and failure cases. Choose the smallest useful public boundary: a typed operation, real database integration, CLI result, or browser workflow. Avoid tests that mirror implementation details.
2. Write the test separately from production changes. Never edit a UI component and its test in the same tool execution step. Run the targeted test before implementing the behavior. Confirm failure comes from the intended missing or incorrect behavior, not syntax, compilation, configuration, or unavailable prerequisites. Record that evidence.
3. Implement the simplest complete behavior satisfying the requirement. Run the targeted test again. For network- or timing-sensitive cases, run it at least twice; two passes alone do not establish absence of flakiness.
4. Refactor without weakening assertions. Rerun relevant tests, `fleur types`, and `fleur lint`. Run the complete applicable verification before delivering substantial changes. `fleur verify` includes tests, types, full lint, and production build.

TDD is the default for meaningful testable behavior changes and mandatory for critical contracts and regressions. Bug fixes require a reproducing test that fails for the intended reason before the fix. Explain when a meaningful red test is unavailable; use appropriate verification for documentation, purely visual changes, or exploration. Do not invent a test merely to satisfy the sequence.

## Browser tests

- Prefer role and accessible-name locators, labels, and other user-facing attributes. Use a stable test ID when semantic locators are unavailable. Avoid selectors coupled to CSS classes, XPath, or incidental DOM structure.
- Use Playwright's auto-waiting actions and web-first assertions. Do not add fixed sleeps or immediate visibility assertions as synchronization. Observe the required state or use controlled clocks/network fixtures.
- Test user-visible behavior, including loading, failure, stale, refresh, maintenance, and unknown-mutation states where relevant. Separate browser contexts for independent views; never share mutable state across unrelated tests.
- Explicitly type reusable Page, Locator, and Frame helpers. Keep strict TypeScript checks and do not bypass them with `any` or unchecked casts.
- Use controlled external API fixtures, including failures and limits. Do not substitute mocked PostgreSQL for database integration. Authentication scenarios are outside Fleur v1.

## Server, database, and types

- Server functions/components are the default. Client components render data and manage interaction; they cannot retrieve application data outside Fleur transport. External retrieval uses a separate Fleur server capability and never runs inside atomic database mutations.
- Derive database tests from validation, output-before-commit, atomic rollback, constraints, version conflicts, maintenance, drift, seed ownership, reset, and recovery requirements. Use only real disposable PostgreSQL targets created for testing, never development or production data.
- Test reactive updates across views, including server-rendered content, reconnects, stale results, ordering, missed notifications, and post-maintenance replacement. Never automatically retry unknown mutations.
- Pair valid inference fixtures with invalid-call fixtures. A negative fixture must fail for the intended contract; an unrelated compiler error cannot stand in for it.
- `fleur types` uses the project's pinned compiler. Microsoft TypeScript is the default; explicitly selected experimental ts-rust must be identified separately by package version and upstream revision. Do not silently switch compilers or confuse the linter's type engine with the selected compiler.
- Oxlint provides fast feedback. Full `fleur lint` also runs the remaining ESLint checks. Editor checks and optional pre-commit hooks do not replace required verification.

## Review and reporting

Substantial features, database changes, security boundaries, and major refactoring require an independent reviewer with original requirements and contracts. It may add independent tests but must not silently change production code, acceptance criteria, or existing assertions. Return defects to the implementation agent and verify fixes.

Report red-phase evidence, executed checks, results, and remaining limitations. Do not claim checks passed without running them. Never change assertions merely to obtain a pass; resolve behavior changes explicitly. Keep secrets, personal data, and generated runtime artifacts out of tracked evidence.

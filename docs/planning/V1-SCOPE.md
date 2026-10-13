# Fleur v1: agreed scope

Confirmed through product discovery on October 12, 2026. This is the scope baseline, not the completed build-ready specification.

## Destination

A build-ready specification for Fleur's first version, including the development, testing, and independent review process used to build Fleur itself.

## Product

One invocation prepares an environment where an existing coding agent can quickly understand and build a small full-stack browser application. Fleur owns its application APIs and runtime rather than acting only as a scaffold for unrelated tools.

## Confirmed requirements

- TypeScript, Bun runtime, Preact, Tailwind, Vite, and PostgreSQL managed through Docker.
- macOS and Linux support; supported versions and Linux installation targets need specification.
- Consistent client/, server/, and shared/ layout.
- Fleur application and database APIs with inferred types and runtime validation. Type safety is a core requirement.
- Application agents use approved dependencies and Tailwind only. Additional packages may be suggested, never independently installed. Enforce dependencies, imports, and styling in development, verification, and builds.
- Automatic source updates through development tooling and reactive data updates across open views.
- Persistent development data, migration tooling, and explicit reset operations.
- Commands for project creation and explanation, prerequisite checks, development lifecycle, status and logs, migrations and seeds, database inspection, tests, types, lint, builds, and combined verification.
- Consistent help, exit codes, and structured JSON output for agents. Commands represent defined operations rather than arbitrary shell passthrough.
- Generated AGENTS.md and CLAUDE.md describing the application surface, layout, and workflow.
- First invocation detects missing Bun and Docker and offers installation; an agent can initiate explicit setup. Setup reports required human actions and can resume.
- fleur build produces the production application; fleur start serves it through Bun against configured PostgreSQL.
- npx invocation is intended; how a Node-based bootstrap provisions and hands off to Bun needs investigation.

## Proof application

Use one simple screen per workflow:

- Exercises: a small catalog of reusable named exercises.
- Workout templates: named, ordered exercises with target sets and repetitions.
- Workout sessions: dated completed-workout records with sets, repetitions, and optional weight.

Recorded sessions retain their details when templates change. Demonstrate valid saves, invalid-input rejection, atomic multi-row saves, automatic updates in another browser view, persistence after restart, and operation of the production build.

## Building Fleur

Define requirements and appropriate test coverage before implementing substantial changes. Use requirements-based tests, real PostgreSQL integration tests, browser tests for key workflows, type checks, lint, and production-build verification. Bug fixes include reproducing regression tests. Separate reviewer agents challenge substantial changes, and automated checks run on pull requests. Exact tooling and enforcement gates remain to be decided.

## Outside v1

Authentication, hosted deployment and hosting accounts, coding-agent launch/orchestration, Windows support, arbitrary application packages, custom application CSS, and workout coaching, timers, analytics, social features, or integrations.

## Decisions still needed

Application contract syntax, validation and serialization, database library and migration guarantees, reactive query semantics, runtime lifecycle and recovery, installer targets and bootstrap, dependency enforcement, production packaging, and the executable verification process. These belong in Wayfinder decision tickets.

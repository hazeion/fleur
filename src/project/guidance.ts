import { releaseVersion } from "./release.ts";
export const generatedGuidance = `<!-- fleur:generated:start version=${releaseVersion} -->
# Fleur ${releaseVersion} project

Fleur prepares an environment for an existing coding agent. It does not launch or manage agents.
Use client/ for interactive Preact islands, server/ for server code and shared/ for browser-safe contracts. Assets belong in assets/. Keep secrets in server-only configuration.
The approved application imports are fleur/schema, fleur/database, fleur/server, fleur/client, fleur/routing, preact, preact/hooks and compiler-managed Preact JSX entry points. The read-page and mutation slices supply schemas, tables/relations, read-only queries, atomic versioned writes, routes and validated islands; see the package docs/read-pages.md and generated dist/reference declarations. Use only these imports and fixed dependencies. Suggest additional packages with the need and existing alternatives; do not install them or edit protected manifests, locks or tooling. Use Tailwind utilities and documented inline styles/CSS variables. Do not author stylesheets or load external JavaScript.
Server components and operations are the default. Validate public inputs and outputs. Browser data requests must use Fleur operations. Database changes require reviewed migrations and explicit destructive authority; never reset development data to fix a test.
Read docs/fleur.md for offline pinned guidance and .agents/skills/fleur-tdd/SKILL.md before changing testable behavior. Use disposable test data and independent review for substantial work.
This creation release supplies the project layout and pinned tooling. Application lifecycle commands are not implemented by this slice; do not invent working APIs or claim a running application.
<!-- fleur:generated:end -->
`;
export const tddGuidance = `---
name: fleur-tdd
fleur-version: ${releaseVersion}
description: Requirements-based Fleur test-first development.
---

Agree observable behavior, acceptance criteria and public test boundaries before implementation. Follow red then green: demonstrate the intended failing behavior, implement the smallest correction, and verify it. Do not weaken assertions or skip failures.
Use Bun tests, positive/negative compiler fixtures, real uniquely owned disposable PostgreSQL for database behavior and browser verification for key flows. Never use development data as test data. Keep application agents within the fixed approved imports and dependencies; do not install packages or author stylesheets.
Use bun run types for Microsoft TypeScript 7.0.2 and bun run lint for oxlint 1.87.0 plus the independent ESLint 10.12.0/typescript-eslint 8.71.2/TypeScript 6.0.3 analyzer. Run bun run test after adding the first requirements-based test; do not add a fabricated passing test to an empty suite. These package scripts do not imply later Fleur runtime or verification commands exist.
Repeat timing and network-sensitive checks. Substantial changes need an independent reviewer. Report checks actually executed and remaining limitations. The CLI still does not expose application lifecycle or verification commands.
`;

export const offlineGuidance = `# Fleur ${releaseVersion} project guidance

This file belongs to the exact Fleur pin in fleur.json. The package metadata and generated instruction sections use that same release version. Missing or mismatched installed versions must be resolved explicitly; never substitute latest or change the pin silently. No registry publication is implied by this scaffold.

## Current operations and tooling

The creation slice supplies new <dir>, init, --compiler microsoft and --no-git, with help and JSON version 1 output. Use --project to select a directory and --timeout to bound creation. Setup and doctor are separate prerequisite operations; no prerequisite installation or image acquisition happens during project creation. Use the shipped command help for the operations present in this release.

After explicitly installing the two frozen graphs with Bun, bun install --frozen-lockfile --ignore-scripts and bun install --cwd lint --frozen-lockfile --ignore-scripts, run bun run types and bun run lint. These are package tooling scripts, not claims that the later Fleur verification commands exist. Microsoft TypeScript 7.0.2 is the compiler. The independent ESLint analyzer uses TypeScript 6.0.3 with ESLint 10.12.0 and typescript-eslint 8.71.2; its engine is separate from the project compiler. Oxlint is 1.87.0. Preact is 11.0.1, Vite 8.3.4 and Tailwind with its Vite plugin 4.3.3. The Rust compiler option remains unavailable until its exact equivalence proof passes.

The initial shared/placeholder.ts only exports an empty module so strict types and lint have a real source input. Write the first requirements-based test before invoking bun run test. An empty tests directory has no fabricated passing test. No application build script or production artifact is supplied.

The installed package supplies inferred read-page APIs and an internal restricted rendering adapter, with a worked fixture in tests/runtime/fixtures/exercises in the source release. Consult docs/read-pages.md and dist/reference in the package. Atomic mutations and their client states are documented in docs/mutations.md, with create/rename/delete in tests/runtime/fixtures/saves. Never automatically replay an unknown mutation; refresh stored data first. No application is running after init. Lifecycle commands, reactive delivery, external retrieval and production operations require their later implementations; do not invent endpoints or success evidence.

## Application contracts

The approved imports are fleur/schema, fleur/database, fleur/server, fleur/client, fleur/routing, preact, preact/hooks and compiler-managed Preact JSX entry points. Zod, tRPC, Drizzle, raw SQL, Bun/Node built-ins and arbitrary package subpaths are internal capabilities rather than application imports. Keep client and shared modules browser-safe; they cannot reach server modules, credentials or secrets. Server components and validated server operations are the default. Client islands own local interaction state and receive validated public data. Direct browser data requests are outside the approved contract.

Use Tailwind utilities and documented inline styles/CSS variables; application-authored stylesheets, external stylesheets and external JavaScript are rejected by the approved application contract. Presentation assets may use approved CDN sources. Suggest unsupported dependencies by describing the need and existing Fleur alternatives; do not install them or edit manifests, locks or protected tooling. This creation slice records these rules and does not claim to implement their later runtime admission enforcement.

Use db inspect for bounded read-only pages or explicit file exports, db backup --out <file> for restore-verified retained backups and db recover --inspect for read-only maintenance diagnosis. See package docs/maintenance.md. Direct PostgreSQL control authority and shared private durable state are required. Never delete a maintenance marker or retry an unknown operation automatically. Use reviewed db migration generate/plan/status/apply and explicitly approved db restore for maintenance recovery. Use db seed for declarative owned data and db reset only for the explicitly bound development target after approval and verified backup. Reset leaves empty data unless --seed is explicit. Seed files export defineSeed from fleur/database; declare dependsOn for foreign-key seed ordering. User-edited rows are skipped, deleted rows retain tombstones and conflicts roll back the run. See package docs/maintenance.md. Future database operations require runtime validation, transactions and explicit authority for destructive actions. Use uniquely owned disposable test databases, never development data. Unknown mutation outcomes require reconciliation, not automatic replay. Keep secret values and machine-local runtime state out of tracked configuration. Runtime files under .fleur are ignored without editing the user's root ignore rules.

## Development and recovery

Read .agents/skills/fleur-tdd/SKILL.md. Agree observable requirements and public test boundaries, demonstrate red before green and keep assertions intact. Substantial or security-sensitive work needs an independent reviewer. Repeat timing/network-sensitive checks and report checks actually executed.

A creation collision returns exit 5 before writes. Choose a clean directory or resolve the exact reported collision manually; never remove user files automatically. A handled partial failure restores only owned unchanged files and guidance. RECOVERY_REQUIRED identifies content or path changes that cannot safely be restored. Inspect those paths and preserve user edits before retrying. Existing generated guidance is not overwritten or duplicated; explicit refresh/replacement belongs to its later implemented workflow.

Finite JSON output has formatVersion, command, ok, data, error and truncated. Exit categories are 0 success, 1 failure, 2 invalid invocation, 3 human authority/action, 4 unavailable/incompatible environment and 5 contention/drift/recovery. Diagnostics belong on stderr. A generic --yes never grants setup or destructive authority.
`;

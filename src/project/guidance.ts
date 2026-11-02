import { bunFloor, releaseVersion } from "./release.ts";
const sharedGuidance = `<!-- fleur:generated:start version=${releaseVersion} -->
# Fleur ${releaseVersion} project

Fleur prepares an environment for an existing coding agent. It does not launch or manage agents.
Fleur requires Bun at or above its release floor, declared as ${bunFloor}; newer stable Bun versions are admitted, while the project's @types/bun stays the exact release pin. Fleur never upgrades or replaces Bun.
Use client/ for interactive Preact islands, server/ for server code and shared/ for browser-safe contracts. Assets belong in assets/. Keep secrets in server-only configuration.
The approved application imports are fleur/schema, fleur/database, fleur/server, fleur/client, fleur/routing, preact, preact/hooks and compiler-managed Preact JSX entry points. The read-page and mutation slices supply schemas, tables/relations, read-only queries, atomic versioned writes, routes and validated islands; see the package docs/read-pages.md and generated dist/reference declarations. Use only these imports and fixed dependencies. Suggest additional packages with the need and existing alternatives; do not install them or edit protected manifests, locks or tooling. Use Tailwind utilities and documented inline styles/CSS variables. Do not author stylesheets or load external JavaScript. Source admission, the worker/browser compilers and browser runtime enforce these boundaries; see the package docs/application-surface.md for local aliases, inert media, source diagnostics and the supported Tailwind/inline-style patterns.
Server components and operations are the default. Validate public inputs and outputs. Browser data requests must use Fleur operations. External API data comes only from Fleur retrievals (defineRetrieval, defineDestination, handleRetrieval, readRetrieval and refreshRetrieval); see the package docs/retrieval.md. Never call fetch or other network APIs directly, and never put credentials in source: handlers name a credential binding that trusted configuration supplies. Database changes require reviewed migrations and explicit destructive authority; never reset development data to fix a test.
Read docs/fleur.md for offline pinned guidance and .agents/skills/fleur-tdd/SKILL.md before changing testable behavior. Use disposable test data and independent review for substantial work.
This release supplies the project layout, pinned tooling and development lifecycle. Use fleur dev in the foreground or fleur dev --background for an independent owner, fleur status for verified state, bounded fleur logs for diagnostics and fleur stop to preserve data and backups. Repeated dev reports the existing owner. A copied checkout gets fresh storage. Failed instances need explicit stop and dev; never claim readiness from process existence. See package docs/development.md. Use fleur build for an immutable production artifact and fleur start --artifact <dir> to serve it against explicitly configured PostgreSQL; see package docs/production.md. Use fleur verify to check guidance, tests, the pinned Microsoft compiler, both lint engines and the production build.
`;
const generatedEnd = "<!-- fleur:generated:end -->\n";
const databaseGuidance = `
## Database

Fleur owns database orchestration: development PostgreSQL, maintenance locking, migrations, seed reconciliation, inspection, backup, restore, reset and recovery. This application owns its table and relation declarations, reviewed migration and seed content, operations and business rules, and expresses them only through \`fleur/schema\`, \`fleur/database\` and \`fleur/server\`. Safety is enforced by Fleur code and PostgreSQL authority, not by these instructions alone.

### Data access

- Declare tables with \`defineTable\` and relations with \`defineRelations\` from \`fleur/database\` in server/. Tables are versioned by default: writes use \`updateVersioned\` and \`deleteVersioned\` with the expected version and report version conflicts. Declare \`versioned: false\` only when lost concurrent updates are acceptable.
- PostgreSQL does not index foreign keys. Use \`defineTable\`'s \`indexes\` option to declare an index that starts with each reference column you read children by, cascade through or restrict on. For an ordered list, declare the filtered columns first, then the \`orderBy\` fields with their directions. Indexes are non-unique; partial and expression indexes are not available.
- Fleur queries (\`defineQuery\` with \`handleQuery\`) and Fleur mutations (\`defineMutation\` with \`handleMutation\`) are the only data access path for application code. A Fleur query only reads. Each Fleur mutation runs in one transaction that commits only after its output validates.
- Raw SQL, Drizzle, Bun SQL, PostgreSQL clients and other ORMs are not application imports. The trusted broker holds the database credential and binds every value, so application code never receives a connection, and typed operations keep inferred types, validation and maintenance checks intact. When an operation needs something the typed APIs cannot express, do not work around them: suggest the missing capability to the user by describing the need and the existing alternatives you considered.
- Use inferred types from schemas and table declarations instead of hand-written copies or casts. Fleur applies runtime validation at every boundary, including operation inputs and outputs, inserts, seed values and island props.

### Migrations

1. Change the table declarations in server/.
2. Run \`fleur db migration generate\`. It writes the next numbered file in migrations/ from the declarations and the last committed snapshot, and never changes the database.
3. Run \`fleur db migration plan\` and review its SQL, removals, incompatibilities and required backfills. Fix refused plans by changing declarations before applying. Removing columns or tables needs separate human approval.
4. Run \`fleur db migration apply\`. It verifies a backup before applying; destructive plans need human approval.
5. Run \`fleur db migration status\` to see applied, pending and drift state.

Commit migration files with the application. Never edit or remove an applied migration: applied files are immutable, and a changed file blocks the database. Never resolve drift by resetting data or rewriting history.

### Seeds and reset

- Restore needs visibility into other roles' sessions through \`pg_read_all_stats\`, or no other roles connected to the target. Hidden session state returns \`MAINTENANCE_BUSY\`, even for idle sessions. Reconciliation requires schema-read authority; refused reconciliation and seed fences name the \`maintenance locks\` capability.
- Seeds are declarative. Export \`defineSeed\` declarations from seeds/ with stable ownership keys and validated row values, and declare \`dependsOn\` for foreign-key ordering. \`fleur db seed\` reconciles them: it skips user-edited rows, keeps tombstones for deleted rows and rolls back the whole run on any conflict. Seeds never run shell commands or SQL.
- \`fleur db reset\` recreates only the explicitly bound development database, and only with human approval after a verified backup. It leaves tables empty unless \`--seed\` is given. Never reset development data to make a test pass.

### Credentials, test data and destructive authority

- Database credentials stay in the trusted host. Never read, print, log or commit them, and never pass them to application code, workers or browser bundles.
- \`DATABASE_PRIVILEGE_INSUFFICIENT\` (exit 4) means the configured database credential lacks the capability named in the error; nothing was changed. The schema overview, \`db inspect --table\`, \`db migration status\` and \`status\` need only the minimum-privilege profile, while other commands, such as backup, migration apply, seed, restore and reset, need more, as listed under Credential authority in the package docs/maintenance.md. Maintenance authority preflights precede the control lease and private state creation; commands recheck authority before work because privileges can be revoked after preflight. Report the command and the named capability to the user; never change, search for or replace credentials or grants yourself.
- Database tests need a uniquely owned disposable PostgreSQL database. This release supplies no approved way for application tests to create one, so do not build your own harness or connect to PostgreSQL directly. Never use development data as test data, and never point tests at the development or production database.
- Destructive operations, including \`fleur db reset\`, \`fleur db restore --from <file>\` and destructive migrations, need human approval bound to the exact target and content. JSON output and a generic --yes never grant it, and an agent never approves on the user's behalf.
- \`db query\` is a development-only diagnostic for reading development data, never a data access path for application code. Use \`fleur db query --sql <text>\` or \`--sql-file <path>\` for development-only diagnosis with one SELECT, WITH without data-modifying parts, VALUES or TABLE statement. Repeat \`--param <text>\` to bind text values as $1, $2 and so on. SQL is limited to 64 KiB, output to 100 rows by default, at most 500 with \`--limit\`, and the inspection byte cap. Columns retain duplicate names and PostgreSQL types; values are exact text or null. Truncation exits 0. The default deadline is 5 seconds, with \`--timeout\` at most 30 seconds. Queries use a verified restricted credential, refuse maintenance and stopped development PostgreSQL, and never read production configuration. PostgreSQL rejections return \`DATABASE_QUERY_REJECTED\` with a redacted SQLSTATE diagnostic; a deadline returns \`QUERY_TIMEOUT\`. Application code must still use Fleur's typed APIs.
- Read data with \`fleur db inspect --table <name>\`, which is read-only and bounded. Take retained backups with \`fleur db backup --out <file>\`. After an interrupted operation, run \`fleur db recover --inspect\` and keep its maintenance marker and backups; never delete Fleur state to force access.

### Schema overview and database health

- \`fleur db inspect\` without --table returns the schema overview: each application table's columns with PostgreSQL type, Fleur column kind, nullability and default, its primary key, foreign keys with their onDelete actions, unique constraints and indexes, and whether it is versioned. Fleur-managed columns are marked managed, and Fleur's own metadata tables are left out. It never returns rows. Page through it with --limit and --cursor while \`truncated\` is true.
- \`fleur status\` reports database health whether or not the application is running: connectivity, target kind, database name, server version, a target fingerprint, the maintenance or recovery stage and the migration summary. Each readiness reason (\`DATABASE_UNAVAILABLE\`, \`MIGRATION_PENDING\`, \`SCHEMA_DRIFT\`, \`MAINTENANCE_ACTIVE\`, \`RECOVERY_REQUIRED\`, \`PREREQUISITE_UNAVAILABLE\`) carries one action; follow it rather than improvising.
- \`fleur db migration status\` alone computes applied, pending and drift state, with each drift difference's object, expected and actual definition. \`db inspect\` and \`status\` embed its summary. Drift, pending migrations, maintenance and an unreachable database are reported as data with exit 0. These diagnostics only read; they do not fix anything.
- Application admission and migration apply share those database drift checks. Unrecorded application objects are \`SCHEMA_DRIFT\` even when admission has no table declarations. Registered tables without initialized history keep their \`MIGRATIONS_PENDING\` refusal. Use inspection to diagnose them; do not reset data or rewrite migration history.
- Verified backup can preserve a database before its first migration. It still refuses changes to recorded catalog/history expectations, and taking a backup does not authorize application admission or migration apply.
- All three default to the development target. --production selects the configured production database and adds no authority. Their output never shows the database host, port, user or URL; do not look for them elsewhere.

### After a schema change

Run these checks and report which ones actually ran:

1. \`bun run types\`.
2. Database tests against disposable PostgreSQL covering the changed tables, constraints and operations. This release has no approved disposable test database for applications, so report this check as not run.
3. \`fleur db migration status\`, which must show no drift and no pending entries after apply.
4. Persistence across restart using public dev -> stop -> dev processes in a separately owned disposable project and persistent volume. Verify recorded rows, migration history and retained backup files; never use development data as test data.

### Development startup and reload

- \`fleur dev\` includes startup initialization of a new development database: one Fleur created for its storage binding and never initialized gets the committed migrations and declared seeds in one transaction. Every other database, even an empty one, is never initialized automatically. Apply migrations and seeds explicitly with \`fleur db migration apply\` and \`fleur db seed\`. Reload never initializes.
- Invalid source retains the last valid application and safe diagnostics. Correct the reported source; use status and the browser to verify the replacement. Proven compatible source changes load matching browser assets without replacing the document, preserving keyed drafts, focus and component state. Automatic replacement is limited to proven text, font-style and validated query-text changes with fixed hook/effect/handler setup. Unknown calls, callbacks, tagged helpers, escaped values/writers and unsupported hook layouts require navigation rather than guessing a state migration. Incompatible or uncertain client layouts retain the previous browser view and show a reload-required diagnostic. Explicit user navigation opts into the new generation; never silently reset drafts or automatically replay mutations. Retained browsers cannot authorize operations in the new generation.
- Schema incompatibility blocks the retained app's database authority. Stop refuses held or queued maintenance. Drain is bounded to 30 seconds; unknown submitted outcomes are never replayed.
- Foreground terminal/launcher close stops its owner. Background survives its caller. Broad app binding is explicit and warns about absent authentication; database/control stay local. Keep machine-local paths, credentials and runtime identities out of tracked configuration.
- Use bounded \`fleur logs --limit 200\`; cursor pages are opaque and follow is opt-in. Uncertain creation/retirement retains ownership evidence and blocks reuse. Never delete journals or maintenance markers to force readiness.

### Not available in this release

Other operations are unavailable unless listed by this pinned release. Do not call, simulate or claim later capabilities.
`;
const instructionGuidance = {
  "AGENTS.md": sharedGuidance + databaseGuidance + generatedEnd,
  "CLAUDE.md": sharedGuidance + "Read the Database section of AGENTS.md before changing tables, relations, migrations, seeds or data access.\n" + generatedEnd,
} as const;
export type InstructionFile = keyof typeof instructionGuidance;
export const generatedGuidance = (name: InstructionFile): string => instructionGuidance[name];
/** Replaces the one marked generated section and keeps every byte outside it. */
export function regenerateGuidance(name: InstructionFile, text: string): string {
  const markers = [...text.matchAll(/<!-- fleur:generated:/g)];
  const start = text.indexOf("<!-- fleur:generated:start version=");
  const end = text.indexOf(generatedEnd.trimEnd());
  if (markers.length !== 2 || start === -1 || end < start) throw new Error("Generated guidance markers are missing, duplicated or out of order");
  const after = end + generatedEnd.trimEnd().length;
  return text.slice(0, start) + instructionGuidance[name] + text.slice(text[after] === "\n" ? after + 1 : after);
}
export const tddGuidance = `---
name: fleur-tdd
fleur-version: ${releaseVersion}
description: Requirements-based Fleur test-first development.
---

Agree observable behavior, acceptance criteria and public test boundaries before implementation. Follow red then green: demonstrate the intended failing behavior, implement the smallest correction, and verify it. Do not weaken assertions or skip failures.
Use Bun tests, positive/negative compiler fixtures, real uniquely owned disposable PostgreSQL for database behavior and browser verification for key flows. Never use development data as test data. Keep application agents within the fixed approved imports and dependencies; do not install packages or author stylesheets.
Use fleur test for the whole tests/ tree, or explicitly select --suite unit|database|browser for tests/<suite>/ and --filter <name-or-path>. Use fleur types for Microsoft TypeScript 7.0.2 and fleur lint for oxlint 1.87.0 plus the independent ESLint 10.12.0/typescript-eslint 8.71.2/TypeScript 6.0.3 analyzer. Run bun run test after adding the first requirements-based test; do not add a fabricated passing test to an empty suite. fleur verify runs these pinned engines with tests and a production build after checking generated guidance.
Browser tests may import the pinned @playwright/test package. An operator must explicitly prepare its Chromium binary and any system libraries before running them. Use Bun to run the pinned Playwright CLI; no Node installation is required. Tests never download browsers or install dependencies. PLAYWRIGHT_BROWSERS_PATH may select the operator-prepared browser cache. Application modules remain within the approved imports.
Repeat timing and network-sensitive checks. Substantial changes need an independent reviewer. Report checks actually executed and remaining limitations. Development lifecycle commands are available; Use fleur verify to check guidance, tests, the pinned Microsoft compiler, both lint engines and the production build. Use the documented pinned project tooling and report what actually ran.
`;

export const offlineGuidance = `# Fleur ${releaseVersion} project guidance

This file belongs to the exact Fleur pin in fleur.json. The package metadata and generated instruction sections use that same release version. Missing or mismatched installed versions must be resolved explicitly; never substitute latest or change the pin silently. No registry publication is implied by this scaffold.

## Current operations and tooling

Use fleur docs refresh --preview to review a bounded generated diff. Unchanged generated content can refresh directly; edited content needs --replace <token>. Commit .fleur-guidance.json with generated instructions, the tailored skill and docs/fleur.md. Preserve user content outside instruction markers. Doctor diagnoses mismatch and verify refuses until resolved. After an interrupted file update, retain its private journal and use the exact updater release with docs refresh --recover after its owner exits. Recovery can restore files and the pin; it never replays an upgrade or reverses database schema changes.

The creation slice supplies new <dir>, init, --compiler microsoft and --no-git, with help and JSON version 1 output. Use --project to select a directory and --timeout to bound creation. Setup and doctor are separate prerequisite operations; no prerequisite installation or image acquisition happens during project creation. Use fleur docs catalog for the versioned operation grammar and result schema, and fleur docs upgrades for supported exact-version paths. No release path exists before the first published release. Upgrade never migrates a database; rolling back files and a pin never reverses schema changes. Use upgrade --to <exact-version> --preview before an admitted upgrade.

After explicitly installing the two frozen graphs with Bun, bun install --frozen-lockfile --ignore-scripts and bun install --cwd lint --frozen-lockfile --ignore-scripts, run fleur types and fleur lint. Use fleur test for all tests, --suite unit|database|browser for a tests/<suite>/ subtree, and --filter <name-or-path> for an explicit subset. A matching test-file path takes precedence over a test-name expression. Use fleur explain for this pinned environment guidance. fleur verify also checks generated guidance and a production build; it never silently substitutes a compiler. Microsoft TypeScript 7.0.2 is the compiler. The independent ESLint analyzer uses TypeScript 6.0.3 with ESLint 10.12.0 and typescript-eslint 8.71.2; its engine is separate from the project compiler. Oxlint is 1.87.0. Preact is 11.0.1, Vite 8.3.4 and Tailwind with its Vite plugin 4.3.3. The Rust compiler option remains unavailable until its exact equivalence proof passes.

The initial shared/placeholder.ts only exports an empty module so strict types and lint have a real source input. Write the first requirements-based test before invoking bun run test. An empty tests directory has no fabricated passing test. Production artifacts come from fleur build, documented in package docs/production.md.

The installed package supplies inferred read-page APIs and an internal restricted rendering adapter, with a worked fixture in tests/runtime/fixtures/ingredients in the source release. Consult docs/read-pages.md and dist/reference in the package. Atomic mutations and their client states are documented in docs/mutations.md, with create/rename/delete in tests/runtime/fixtures/saves and ordered aggregate saves with an expected parent version, plus immutable dated snapshots with exact decimal amounts, in tests/runtime/fixtures/recipes. Reactive server regions and useQuery are documented in docs/reactivity.md, with a two-view fixture in tests/runtime/fixtures/reactive. Use stable keys to preserve island drafts, focus and local state. Show stale/error/reconnecting/maintenance state and never fabricate initial data. Identical validated query inputs share a logical subscription, capped at 20 per connection and 100 per running project. Never automatically replay an unknown mutation; refresh stored data first. No application is running after init. External retrieval is documented in docs/retrieval.md, with a fixture in tests/runtime/fixtures/retrieval: declare destinations and handlers in server/, handle RetrievalError explicitly and save retrieved data only through a revalidating mutation. Its credentials, local-service exceptions and limits are trusted startup configuration supplied to the development broker. Use dev/stop/status/logs as documented in package docs/development.md. Only startup initializes a provably new development database with its reviewed chain and seeds. Existing or adopted databases use explicit migration apply and seed; reload never initializes. Invalid source retains the last valid generation and diagnostics; incompatible schema blocks database authority. Production uses fleur build and fleur start --artifact <dir> as documented in package docs/production.md; start never applies migrations or provisions a database. Do not invent endpoints or success evidence.

## Application contracts

The approved imports are fleur/schema, fleur/database, fleur/server, fleur/client, fleur/routing, preact, preact/hooks and compiler-managed Preact JSX entry points. Zod, tRPC, Drizzle, raw SQL, Bun/Node built-ins and arbitrary package subpaths are internal capabilities rather than application imports. Keep client and shared modules browser-safe; they cannot reach server modules, credentials or secrets. Server components and validated server operations are the default. Client islands own local interaction state and receive validated public data. Direct browser data requests are outside the approved contract.

Use Tailwind utilities and documented inline styles/CSS variables; application-authored stylesheets, external stylesheets and external JavaScript are rejected by the approved application contract. Presentation assets may use approved CDN sources. Suggest unsupported dependencies by describing the need and existing Fleur alternatives; do not install them or edit manifests, locks or protected tooling. The runtime admission and compilation adapters enforce these rules using one captured source/asset snapshot, browser transport and DOM guards, and CSP. See package docs/application-surface.md for local aliases, lazy-island registration, supported assets and safe SOURCE_REJECTED diagnostics. Use fleur dev/status/logs/stop for development lifecycle and fleur verify for guidance, tests, types, both lint engines and the production build.

The Database section of AGENTS.md summarizes the database workflow and lists operations that are not available in this release. Use db query with --sql or --sql-file and bound --param text values for bounded development-only SQL diagnosis, never application data access. Use db inspect for the read-only schema overview, bounded table pages or explicit file exports, status for database health and the embedded migration summary, db backup --out <file> for restore-verified retained backups and db recover --inspect for read-only maintenance diagnosis. See package docs/maintenance.md. Direct PostgreSQL control authority and shared private durable state are required. A credential without the authority a command needs returns DATABASE_PRIVILEGE_INSUFFICIENT, naming the missing capability, before anything changes; the schema overview, db inspect --table, db migration status and status need only the minimum-privilege profile in package docs/maintenance.md. Never delete a maintenance marker or retry an unknown operation automatically. Use reviewed db migration generate/plan/status/apply and explicitly approved db restore for maintenance recovery. Use db seed for declarative owned data and db reset only for the explicitly bound development target after approval and verified backup. Reset leaves empty data unless --seed is explicit. Seed files export defineSeed from fleur/database; declare dependsOn for foreign-key seed ordering. User-edited rows are skipped, deleted rows retain tombstones and conflicts roll back the run. See package docs/maintenance.md. Future database operations require runtime validation, transactions and explicit authority for destructive actions. Use uniquely owned disposable test databases, never development data. Unknown mutation outcomes require reconciliation, not automatic replay. Keep secret values and machine-local runtime state out of tracked configuration. Runtime files under .fleur are ignored without editing the user's root ignore rules.

## Development and recovery

Read .agents/skills/fleur-tdd/SKILL.md. Agree observable requirements and public test boundaries, demonstrate red before green and keep assertions intact. Substantial or security-sensitive work needs an independent reviewer. Repeat timing/network-sensitive checks and report checks actually executed.

A creation collision returns exit 5 before writes. Choose a clean directory or resolve the exact reported collision manually; never remove user files automatically. A handled partial failure restores only owned unchanged files and guidance. RECOVERY_REQUIRED identifies content or path changes that cannot safely be restored. Inspect those paths and preserve user edits before retrying. Existing generated guidance is not overwritten or duplicated by init. Use fleur docs refresh --preview to inspect changes, then fleur docs refresh for unchanged generated content or --replace <token> to explicitly replace edited content. Refresh preserves user instructions, packages and the exact pin.

Finite JSON output has formatVersion, command, ok, data, error and truncated. Exit categories are 0 success, 1 failure, 2 invalid invocation, 3 human authority/action, 4 unavailable/incompatible environment and 5 contention/drift/recovery. Diagnostics belong on stderr. A generic --yes never grants setup or destructive authority.
`;

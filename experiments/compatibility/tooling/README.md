# Tooling compatibility experiment

This is a disposable experiment for [Prove compatibility and runtime isolation](https://github.com/hazeion/fleur/issues/23). It implements no Fleur runtime. Its agreed seams are exact artifact identity, internal schema/operation/database inference, strict compiler diagnostics, Bun execution and independent lint-engine resolution.

Python 3 runs the read-only metadata probe. Provide Bun 1.4.3 explicitly to execute the fixture. The runner copies files to an external temporary directory, installs from frozen lockfiles, runs checks and removes only its own temporary directory. It neither installs a global runtime nor selects a replacement version.

```sh
python3 experiments/compatibility/tooling/probe.py
python3 experiments/compatibility/tooling/test_runner.py
python3 experiments/compatibility/tooling/run.py --bun "$FLEUR_EXPERIMENT_BUN"
```

Set `FLEUR_EXPERIMENT_BUN` to a deliberately obtained local binary. This run downloaded the official `bun-darwin-x64.zip` for `bun-v1.4.3`, checked SHA256 `62660e6438eb872278877acca77e1152d5d031324df368d4a81b428211489d2d` against the release asset digest, and confirmed `--version` reported `1.4.3`. A published metadata checksum alone does not prove downloaded bytes match it.

## Executed results

On October 13, 2026, macOS 15.7.7 reporting x86_64 with Python 3.13.14 executed the runner checks below. Bun and Docker were initially absent from PATH. Bun was acquired only for disposable experiments; Docker was not installed. The external probe report records availability, exact identities and published digests. All 16 candidate metadata requests succeeded. Translation-state sysctl queries were unavailable, so native architecture is not established. These initial local results alone were not a verified platform matrix or container image pins. The final native and distribution jobs subsequently passed; the [durable evidence record](../evidence.md) lists actual hosts and pins.

| Check | Observed result |
| --- | --- |
| Frozen main and separate lint installs | Both succeed under Bun 1.4.3 |
| Zod strict input/output and tRPC local caller | Two runtime tests pass, five assertions |
| Bun SQL export | Constructor is present; no database connection or SQL execution tested |
| Full strict schema/database/operation type fixture | Passes with exact source-backed Drizzle declaration repair |
| Full negative fixture | Exactly the intended three input/nullability/decimal diagnostics |
| Scoped Zod/tRPC positive inference fixture | Passes with strict declaration checking |
| Scoped negative inference fixture | Exactly intended wrong-input, missing-nullable and numeric-decimal diagnostics |
| Oxlint 1.87.0 | Fixture passes under explicit Bun execution |
| Separate ESLint 10.12.0 / typescript-eslint 8.71.2 | Positive syntax fixture passes; explicit-any fixture rejects with intended rule |
| Lint TypeScript dependency | Internal import reports 6.0.3, independent of default compiler 7.0.2 |

The initial runner exited 1 because the full strict type gate failed. Complete positive and negative diagnostics are retained in external experiment notes; rerunning the fixture reproduces them. `skipLibCheck` remains false. Missing optional `gel`/`mysql2` driver declarations are packaging failures. Separate substantive diagnostics include:

```text
node_modules/drizzle-orm/gel-core/query-builders/query.d.ts(23,22): error TS2420: Class 'GelRelationalQuery<TResult>' incorrectly implements interface 'SQLWrapper'.
  Property 'getSQL' is missing in type 'GelRelationalQuery<TResult>' but required in type 'SQLWrapper'.
node_modules/drizzle-orm/mysql-core/query-builders/delete.d.ts(36,22): error TS2420: Class 'MySqlDeleteBase<TTable, TQueryResult, TPreparedQueryHKT, TDynamic, TExcludedMethods>' incorrectly implements interface 'SQLWrapper'.
```

Other select-builder generic constraints reference absent `session`/`config` members. The declaration packaging experiment below resolves these diagnostics without skipping library checks.

The negative ESLint check parses JSON diagnostics and requires exactly the `invalid.ts` fixture's `@typescript-eslint/no-explicit-any` error, with no fatal or unrelated diagnostics. Its CLI regression uses an explicit fake Bun executable and disposable external directories. Before the fix, all six parser, fatal, wrong-file, unrelated-rule, mixed-rule and unstructured-output controls incorrectly passed. After the fix, those controls fail and the intended-rule control passes. The regression test passed on October 13, 2026. That historical rerun confirmed the intended ESLint diagnostic while preserving the then-unresolved strict Drizzle failure. The later source-backed repair below passes the complete strict runner.

An initial experiment used @types/bun 1.3.10 against runtime 1.4.3 and reported duplicate FFI identifiers and WebAssembly declaration conflicts. Inspection confirmed exactly one bun-types 1.3.10 dependency, rather than two compiler engines. Aligning declarations to exact @types/bun/bun-types 1.4.3 and explicitly including the disposable standard library removed those Bun failures. The current lockfile and saved diagnostics use the corrected configuration. No candidate default compiler or linter version changed.

Internal research omitted Zod/tRPC/Drizzle versions. The experiment freezes newly inspected candidates Zod 4.6.7, tRPC 11.19.0 and Drizzle 0.45.4. These are internal dependency experiments, not approved application imports. Their exact transitive resolution and integrity records are in the two lockfiles.

## Current compatibility scope and remaining product work

The complete frozen tooling runner passed on all six native macOS/Ubuntu targets and all three Debian/Arch userspaces in [run 38455482128](https://github.com/hazeion/fleur/actions/runs/38455482128), at `ba3769df6debc468c6ff7a8ccacad52fdf30f2ee`. Real disposable PostgreSQL and native registered broker exchange also passed in the separate [database experiment](../database-broker/README.md). [Rendering](../rendering/README.md) establishes the browser fixture. The original import-only Bun SQL observation does not replace those real database checks.

These fixtures establish internal library compatibility and positive/negative inference. Full Fleur page/island/retrieval reference families, application admission rules, compiler watch/editor behavior and production API conformance belong later implementation tickets. Neither simple lint fixture proves policy enforcement. Experimental Rust remains unavailable: its package/upstream equivalence has not executed, and no fallback is offered. Browser CLI/workers launch with Bun without a separate Node prerequisite.

The follow-up issue-closure work expands both Oxlint and ESLint to all five positive tooling TypeScript sources, including declaration/provenance and scoped operation fixtures. Deliberately invalid compiler and ESLint fixtures remain separate rejection checks. At follow-up commit `b2b4905`, two public runner regressions first demonstrated false passes for an `operations.ts` failure in each lint engine, then passed twice after the fix. The complete actual frozen Bun runner also passed runtime/provenance, strict positive types, intended negative diagnostics and both expanded lint engines. The final CI rerun is pending. This addition is not part of the older tested commit's evidence.

## Source-backed declaration repair

The follow-up experiment on October 13, 2026 passes the complete frozen tooling runner on macOS with Bun 1.4.3 and TypeScript 7.0.2. It adds exact internal declaration peers `gel` 2.2.1 and `mysql2` 3.24.6. Installing those peers alone still failed; TypeScript 6.0.3 and Drizzle stable candidates 0.29.5, 0.30.10, 0.32.2, 0.38.4, 0.44.7 and upstream 1.0.0-rc.4 also failed the minimal strict import probe.

The root cause is stripped `@internal` declarations that remain necessary to satisfy exported interfaces and constraints. Published source maps and JavaScript contain `getSQL`, select-builder `session`/`config`, and role configuration members that the package's declarations omit. Bun `patchedDependencies` applies a checked-in patch to exact Drizzle 0.45.4. It restores only the required declarations in both ESM and CommonJS formats; JavaScript is unchanged. The SingleStore common generated-column method has its existing inherited `HasGenerated` return contract restored. The enum override always throws in published source, so its return is accurately narrowed to `never` rather than its incompatible original generated-column type.

`patches/provenance.json` freezes the original declaration, source-map, extracted source, repaired declaration and runtime hashes for each affected file. The runtime regression checks repaired declaration hashes and unchanged published source/runtime hashes, and verifies the relational `getSQL` runtime method exists. `declarations.ts` checks that the same relational method is callable at the type boundary, SQL query generation is typed, and PostgreSQL select/insert inference preserves required, nullable and decimal-string fields. Against the unpatched package this fixture failed with missing `PgRelationalQuery.getSQL` plus the original library diagnostics; against the patched frozen package it passes. The full negative fixture still requires exactly three intended diagnostics. No `skipLibCheck`, diagnostic suppression, compiler substitution or application import approval was introduced. The repair is an internal dependency packaging candidate, not a claim that upstream published a corrected release.

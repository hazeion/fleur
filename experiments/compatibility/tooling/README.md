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

On October 13, 2026, macOS 15.7.7 reporting x86_64 with Python 3.13.14 executed the runner checks below. Bun and Docker were initially absent from PATH. Bun was acquired only for disposable experiments; Docker was not installed. The external probe report records availability, exact identities and published digests. All 16 candidate metadata requests succeeded. Translation-state sysctl queries were unavailable, so native architecture is not established. These results are not a verified platform matrix or container image pins.

| Check | Observed result |
| --- | --- |
| Frozen main and separate lint installs | Both succeed under Bun 1.4.3 |
| Zod strict input/output and tRPC local caller | Two runtime tests pass, five assertions |
| Bun SQL export | Constructor is present; no database connection or SQL execution tested |
| Full strict schema/database/operation type fixture | Fails on Drizzle dependency declarations |
| Full negative fixture | Intended three diagnostics occur plus unrelated Drizzle failures; gate fails |
| Scoped Zod/tRPC positive inference fixture | Passes with strict declaration checking |
| Scoped negative inference fixture | Exactly intended wrong-input, missing-nullable and numeric-decimal diagnostics |
| Oxlint 1.87.0 | Fixture passes under explicit Bun execution |
| Separate ESLint 10.12.0 / typescript-eslint 8.71.2 | Positive syntax fixture passes; explicit-any fixture rejects with intended rule |
| Lint TypeScript dependency | Internal import reports 6.0.3, independent of default compiler 7.0.2 |

The runner exits 1 because the full strict type gate fails. Complete positive and negative diagnostics are retained in external experiment notes; rerunning the fixture reproduces them. `skipLibCheck` remains false. Missing optional `gel`/`mysql2` driver declarations are packaging failures. Separate substantive diagnostics include:

```text
node_modules/drizzle-orm/gel-core/query-builders/query.d.ts(23,22): error TS2420: Class 'GelRelationalQuery<TResult>' incorrectly implements interface 'SQLWrapper'.
  Property 'getSQL' is missing in type 'GelRelationalQuery<TResult>' but required in type 'SQLWrapper'.
node_modules/drizzle-orm/mysql-core/query-builders/delete.d.ts(36,22): error TS2420: Class 'MySqlDeleteBase<TTable, TQueryResult, TPreparedQueryHKT, TDynamic, TExcludedMethods>' incorrectly implements interface 'SQLWrapper'.
```

Other select-builder generic constraints reference absent `session`/`config` members. This experiment does not decide whether an approved internal packaging change can resolve them.

The negative ESLint check parses JSON diagnostics and requires exactly the `invalid.ts` fixture's `@typescript-eslint/no-explicit-any` error, with no fatal or unrelated diagnostics. Its CLI regression uses an explicit fake Bun executable and disposable external directories. Before the fix, all six parser, fatal, wrong-file, unrelated-rule, mixed-rule and unstructured-output controls incorrectly passed. After the fix, those controls fail and the intended-rule control passes. The regression test passed on October 13, 2026. Rerunning the actual Bun 1.4.3 fixture confirmed the intended ESLint diagnostic while preserving the full strict Drizzle type failures and overall exit 1.

An initial experiment used @types/bun 1.3.10 against runtime 1.4.3 and reported duplicate FFI identifiers and WebAssembly declaration conflicts. Inspection confirmed exactly one bun-types 1.3.10 dependency, rather than two compiler engines. Aligning declarations to exact @types/bun/bun-types 1.4.3 and explicitly including the disposable standard library removed those Bun failures. The current lockfile and saved diagnostics use the corrected configuration. No candidate default compiler or linter version changed.

Internal research omitted Zod/tRPC/Drizzle versions. The experiment freezes newly inspected candidates Zod 4.6.7, tRPC 11.19.0 and Drizzle 0.45.4. These are internal dependency experiments, not approved application imports. Their exact transitive resolution and integrity records are in the two lockfiles.

## Remaining gate work

Real disposable PostgreSQL integration is unexecuted. Bun SQL import availability is not transaction, inference or broker compatibility. Retrieval/page/island API fixtures, server-only graph checks, compiler declaration/watch/editor behavior, Rust package/upstream equivalence, full typed ESLint coverage, Oxlint negative-rule conformance, browser checks and supported-platform execution remain separate obligations. Neither simple lint fixture proves Fleur policy enforcement. The current experiment cannot pass issue 23 or authorize its dependent implementation.

These exploratory fixtures test upstream compatibility rather than missing Fleur production behavior. There is no meaningful production red-green cycle here. Negative fixtures demonstrate intended rejection only where a corresponding clean positive fixture passes. No test or assertion was weakened to hide the strict declaration failure.

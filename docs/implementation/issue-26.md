# Issue 26: save exercises

Implements [Save exercises with validation and concurrent-edit protection](https://github.com/hazeion/fleur/issues/26), following the approved v1 specification. The user authorized implementation and merge. The compatibility gate and read-page prerequisite are closed.

## Observable behavior and verification boundaries

The ticket explicitly requires operation, real PostgreSQL, and browser verification. These are the test boundaries for this slice:

- Shared mutation contracts infer handler and client types. Strict input parsing precedes handler execution. Output parsing precedes commit.
- All mutation helpers share one broker-owned Read Committed transaction. Handler, database, output and deadline failures roll back every write. A confirmed commit precedes success; an unacknowledged commit attempt has an unknown outcome.
- Versioned updates and deletes lock and compare the expected version atomically. Updates increment versions. Missing, stale and constraint failures remain distinct. Generated and managed fields cannot be assigned by writes. Explicit unversioned writes warn that they have no lost-update guarantee.
- Exercise forms trim names to 1–100 Unicode code points, retain display case, and enforce uniqueness using release-pinned Unicode full case folding. The same mapping supplies application folding and PostgreSQL uniqueness expressions, with locale-independent comparison.
- Client outcomes resolve to success, failure or outcome-unknown. Validation/offline refusal before dispatch is not-sent. Lost or malformed responses after dispatch are uncertain. No mutation is automatically retried.
- Browser create, rename and delete flows show invalid input, concurrent edits and uncertain outcomes. Reconciliation reads current data without replaying saves.

Critical tests begin red, then pass against the implementation. Database tests use uniquely owned disposable PostgreSQL. Network/deadline/browser cases repeat at least twice. Compiler fixtures cover inferred arguments/results, managed fields and versioned/unversioned mismatches. Production browser bundles are inspected for server code and secrets. Existing platform, isolation and cleanup checks remain required.

Reactive subscriptions, migrations, public lifecycle commands and full workout acceptance remain later slices. This slice extends the internal application adapter used by the read-page proof.

## Executed evidence

- Contract, version-comparison, Unicode-folding, browser-policy and transaction regressions were observed failing for the intended missing or incorrect behavior before their fixes.
- Real PostgreSQL verifies atomic rollback for invalid output, caught helper failures and oversized helper results; competing expected-version writers; distinct stale, missing and constraint failures; generated-field protection; and shared Unicode uniqueness.
- The production browser workflow passed both repetitions of create, rename, conflict, delete, lost-response reconciliation and no replay. Separate tests dropped the database COMMIT acknowledgement twice, reporting unknown while retaining exactly one stored row.
- Independent standards, specification and transaction/security reviews found and drove fixes for swallowed helper failures, cleanup masking an unknown outcome, generated-column type branding and browser realms exposing unrestricted transport. The standards reviewer found no documented-standard violation and noted an optional internal naming improvement for the existing `ReadBroker` and `ReadApplication` classes.

- Final focused PostgreSQL verification passed 13 tests and 51 assertions across mutation, default-value, COMMIT-loss and independent rollback cases. Defaulted-column updates and deferred constraint rejection first failed for the intended reasons, then passed. Compiler fixtures also reproduced and closed an empty-object loophole that accepted invalid updates on tables containing only defaulted or managed fields.
- The full local `bun run test` invocation completed 1,480 Bun tests: 1,476 passed and four timed out. All three CLI timeout cases passed focused reruns with unchanged assertions and deadlines. The separate Python controller and race suites passed three and five tests respectively.
- The existing read-page navigation test continued to exceed its render budget locally. A reduced direct-render diagnostic reproduced `QUERY_TIMEOUT` on both this branch and the prior merged commit `939f1ca`. Its nested query took 9.7 seconds on this branch and 5.6 seconds on the prior commit, exceeding the existing five-second render budget. No deadline was extended. Temporary diagnostics were removed and owned resources recovered. The mutation browser workflow passed both repetitions during the full run; browser transport-policy tests also passed separately.
- Strict type checks, both lint engines and the production reference build passed after the final changes. The final candidate must pass the applicable GitHub runtime, platform, lint and build checks before merge; local timeout failures are not reported as passing evidence.

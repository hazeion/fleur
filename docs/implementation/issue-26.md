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

Pending implementation and verification.

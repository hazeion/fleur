# Issue 38 verification evidence

Qualification is in progress. This record does not authorize publication or
claim that the required native matrix or performance budgets have passed.
The [acceptance ticket](https://github.com/hazeion/fleur/issues/38) remains the
release gate. The application is reviewed in
[fleur-workout #1](https://github.com/hazeion/fleur-workout/pull/1); its immutable
source revision is recorded in `scripts/workout-source.json`.

## Executed evidence

All results below used the release floor Bun 1.4.3. Intel macOS browser checks
used Chromium 156.0.8078.4 on macOS 15.7.7.

| Boundary | Failure reproduced | Passing evidence |
| --- | --- | --- |
| Named verification commands | Missing commands, underscore test filtering, wrong timeout category and surviving tool children | Closed grammar and real tool/process regressions, including SIGTERM and launcher SIGKILL |
| Protected tool profiles | Edited ESLint configuration or disabled strict compilation returned success | Both refuse before evaluating the edited profile; missing compiler reports environment failure without installation |
| Generated browser tool graph | Packed browser suite failed because Playwright was absent | Pinned Playwright 1.64.0, real Chromium button interaction, full verification and production artifact; 1 test, 29 assertions |
| Continuation readiness | Malformed opaque continuation became HTTP 500 | Public NOT_FOUND becomes HTTP 404 and readiness succeeds in repeated probes |
| Aggregate continuation | 501-entry template read returned REQUEST_DENIED | Disposable PostgreSQL preserves all 501 ordered template entries and session sets |
| Template chooser | Eleventh template was inaccessible | Chromium selects and copies a template on the second page |
| Reference storage | Fixture exposed no disk-storage evidence | Owned disk volume, fsync and synchronous_commit enabled, retained row after PostgreSQL restart |
| Failure cleanup | A failed listener resume could prevent resource retirement | Injected resume failure is reported while the owned database container and volume are removed |
| Proof ownership | Unbounded shutdown/output waits and unsafe unavailable child identity | Real ignored-TERM child is reaped, inherited stdout is bounded, invalid identity never becomes a signal target |
| Source identity | Reading a directory symlink raised EISDIR | Recorder hashes the link itself, including a broken target, without reading outside the tree |
| Native proof source contract | The guest rejected the current two-source report and accepted an obsolete flat report | Regression tests bind both clean source commits, tree hashes and positive file counts |

The 500-exercise catalog, 501-row detail and second-page template browser proof
passed twice with disposable databases. Actual Chromium and its selected test
process retired after both SIGTERM and launcher SIGKILL.

The app's unit suite passed 9 tests with 25 assertions, including bounded
read-only retries when an aggregate changes. Types and both independent lint
engines passed. Independent review reran the unit suite and found no remaining
critical defect in the cursor, version validation or chooser fixes.

An isolated produced-package run passed two repetitions of workout validation,
child rollback, expected-version competition, referential conflict, immutable
history, two-view draft/focus preservation and unknown outcomes without replay.
It also passed maintenance diagnostics, reviewed migrations, verified backup
preservation, authority refusals, explicit restart persistence, full verification,
and two clean production starts. Owned processes, database containers and volumes
were retired. The development cold start was 88.44 seconds; production starts
were 60.90 and 52.25 seconds. Dependency installation and existing Docker base
layers preceded those startup measurements. These are cold-start observations,
not warm-query budget results.

The broad local diagnostic run completed 479 runtime tests and all five Python
suites successfully. Its CLI half had four failures. Each passed in isolation
with the original deadlines after the approved guidance expectation changed.
That mixed run is not final-candidate passing evidence. Final applicable checks
must pass before merge.

## Performance and native matrix

Performance runs require the exact versioned 500-exercise, 100-template,
10,000-session/500,000-set fixture, five views and ten logical queries per view.
Every scenario must independently pass three runs of at least 100 samples with
nearest-rank p95; errors remain failures and infinite latency. A false or
incomplete report is not qualification.

The reference Mac has four physical cores, eight logical CPUs, 16 GiB RAM and
observed SSD storage. Docker has eight CPUs and 8,322,727,936 bytes of allocated
memory. The report freezes source identity, produced archive, artifact/images,
compiler/lint/browser/runtime pins, database durability, fixture, warmup and
measurement uncertainty. Warm measurements run without unrelated heavy work.
The initial recorder failure and a later limit-preflight failure occurred before
timing samples; no performance claim follows from those attempts. The independent
healthy-query service check remains unresolved. The full reference measurement
is still required before merge.

For PR head `8cc8980454535511cdd512bcea278565f388e139`,
[CLI run 41383964815](https://github.com/hazeion/fleur/actions/runs/41383964815)
passed every selected job, including packed CLI tests, both production artifact
jobs, both read-runtime jobs and both native Ubuntu workout proofs. The stale
Python test-count assertion was corrected without removing any test. Checkout
tested GitHub's PR merge commit `6cc6b14e0ceca83ac685e26fbccea7fbe79751c5`,
whose parents are that head and the main branch revision. The successful
Ubuntu proof also passes the repaired native source-contract validator when
bound to that exact checkout and the immutable workout pin.

| Required tuple | Acceptance status |
| --- | --- |
| Intel macOS | Packed workout and production run executed; final candidate pending |
| Ubuntu 24.04 amd64 | Native packed workout and production proof passed in run 41383964815; final candidate pending |
| Ubuntu 26.04 amd64 | Native packed workout and production proof passed in run 41383964815; final candidate pending |
| Debian 13 amd64 | Repeated native workout build failure; qualification incomplete |

[Debian run 41383978363](https://github.com/hazeion/fleur/actions/runs/41383978363)
reproduced the earlier build failure after both functional browser repetitions,
maintenance and restart persistence passed. Full verification passed tests,
types and both lint engines, then returned `INTERNAL_FAILURE` during artifact
construction. Owned workout resources, service cgroups and VM scratch retired.
This is failure evidence. The proof now records bounded fixed build-stage names
and child exit codes on failure, excluding tool arguments, output and environment,
to locate the failing operation without exposing credentials.

Existing ARM jobs and Arch observations retain their original limited scope.
A normal green PR does not establish the manual Debian row. No publication,
installer admission or experimental compiler support follows from this record.

## Native test-host observation

The read-only inventory from
[run 41349899368](https://github.com/hazeion/fleur/actions/runs/41349899368),
attempt 1, source `4d7fcb105437ae707a932b2427b775f22041ff77`, observed hosted Ubuntu
image `20261026.354.1`. Inventory SHA-256 is
`628b3b5fbccb613054c9d5bf2f72b203888242f247aa413808022e6a10c60d14`.
The collector hash matches the tracked observer. The existing strict
`validate_tool_plan` admitted the same frozen 18 new packages, with no upgrade or
removal, for KVM test-host preparation. The new runner record permits that
unchanged transaction to be attempted; actual baseline, package-delta, Docker
preservation, service/cgroup and disposal checks still apply. This observation
is not native application qualification.

The private source checkout uses an independent read-only deploy key. Checkout
credentials are not persisted or sent into the guest; source-only Git packs
retain the original commits without remotes or history. Debian browser
prerequisites refuse changes to existing distribution packages and freeze each
new package version before installation. The guest checks its private detached
nftables canary, daemon/service state, baseline images, empty container result
and source cleanup before the outer verifier retires the owned VM/cgroup.

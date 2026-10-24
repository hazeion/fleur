# Exercise reads through a restricted server page

Issue #25 implements the read path in the approved v1 specification. The later
#24 resolution records successful required compatibility checks. Historical
#23 evidence remains attributed to its original runs.

## Acceptance and test boundaries

- Public `fleur/schema` declarations infer inputs and outputs. Strict runtime
  parsing rejects extra fields, explicit undefined, unsupported objects, unsafe
  numbers and invalid calendar/instant values. Optional omission and nullable
  null remain distinct. Compiler fixtures independently reject invalid types.
- `fleur/database` declarations infer columns, projections, references and joins.
  The trusted broker accepts only registered read requests. PostgreSQL enforces
  read-only Read Committed transactions. A joined/related read is one statement.
- Reads default to 100 rows and reject limits above 500. Stable cursors bind the
  registered query, filters and ordering, including a unique tie-breaker. The
  five-second deadline starts before queueing. Public JSON exceeding 1 MiB fails.
- Page and island contracts infer and validate parameters/props. Direct browser
  navigation renders database content before island hydration. Routing failures
  reveal no internal details. Only registered islands hydrate.
- Browser/shared imports cannot reach server authority. Inspect production
  chunks and source maps and reject forbidden graphs. Application execution uses
  the verified native restriction mechanism before evaluating application code.

Database tests own a unique disposable PostgreSQL instance. Browser tests use
that instance through the public read path. Timing and transport cases run twice.
Type checking, both lint engines, production build, the full applicable suite,
independent Standards and Spec reviews, and all applicable CI checks precede merge.

## Review and verification evidence

Independent review added regressions for route precedence, nested-island
hydration, declared public errors, immutable endpoint ownership, pending-create
recovery and image disposal. The route and hydration tests first failed for the
reported defects; shared route selection and a single outer hydration boundary
made them pass. Owned image disposal now verifies immutable identity, owner,
endpoint and absence of live container references. Both review axes cleared the
resulting changes.

Focused verification passed the real PostgreSQL reads, restricted application
list/detail rendering and pagination, production browser fixture, two repeated
CPU-bound worker deadlines, generated declaration consumer fixtures, types and
both lint engines. Two independent generated-project runs passed with Node
unavailable. The packed CLI suite passed all eight tests and 85 assertions after
removing duplicate declaration-consumer compilation from its packaging hook;
the full declaration-consumer check remains an explicit CI step.

An intermediate runtime run overlapped the full CLI suite and generated-project
installation/lint work. It passed 70 tests and failed one detail render with
`QUERY_TIMEOUT`; the browser test passed but emitted an HTTP idle-timeout warning.
This is retained as a failed run, not passing timing evidence. The reference
procedure excludes unrelated heavy work. Final local verification runs
sequentially with the same deadlines and assertions; its results and the required
CI outcomes are recorded in the pull request before merge.

The first ARM CI run found the native compiler paired with an amd64 controller
base image. An architecture-pairing regression reproduced that mismatch; selecting
the immutable arm64 child from the same Ubuntu 24.04 image index made the focused
suite pass. Native CI remains necessary evidence for that corrected image.

Local verification used Intel macOS 15.7.7, a four-core Core i7-7820HQ with 16 GiB
RAM, Docker Engine 29.9.2 with eight virtual CPUs and approximately 7.75 GiB RAM,
Bun 1.4.3 and Playwright 1.64.0. The browser driver used Node 24.22.1. These slice
checks do not claim the complete application's reference performance targets or
qualify additional release platforms.

Further CI timing regressions exposed completion/exit races and server timeout
classification. Five deterministic guard/controller tests first reproduced four
failures: cancelling a healthy worker between final bytes and exit, treating
deadline-time EOF as early cancellation, extending its termination tolerance,
and concealing a late-observed natural exit. The corrected controller waits for
pidfd evidence; the guard retains the original deadline and reports observed
lateness. All five regressions and the three existing controller tests passed.
A real PostgreSQL cancellation before the host timer first returned the wrong
public error; using Bun's SQLSTATE field corrected it.

The initial complete local suite reported 1,432 passes and 11 failures. These
were the packaging hook, native-verifier packaging prerequisites and obsolete
guidance assertion. The corrected hook uses the invoking Bun executable even
without Bun on PATH; trusted verifier fixtures provide declaration-build inputs
while packed execution retains its restricted PATH. The affected CLI suites
then passed 51 tests and 407 assertions. Sequential runtime verification passed
73 tests and 302 assertions, including production browser navigation/hydration
and repeated native deadlines. Types, both lint engines and generated declaration
consumer verification passed.

An independent real-PostgreSQL regression also forced both cleanup verification
and backend-control failure. It reproduced pool starvation after four retained
reservations. Recovery now closes that individual reserved connection without
returning it for reuse, allowing healthy reads and shutdown to proceed. This
preserves the existing operation deadline and cleanup controls.
The combined PostgreSQL suites then passed 13 tests and 37 assertions; types,
full lint, declaration consumers and all 12 CI policy tests passed afterward.

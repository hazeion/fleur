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

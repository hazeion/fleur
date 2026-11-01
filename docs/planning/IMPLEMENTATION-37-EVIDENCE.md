# Issue 37 implementation evidence

Scope: [Upgrade pins and refresh generated guidance safely](https://github.com/hazeion/fleur/issues/37).
Implementation was separately authorized. The compatibility and prerequisite
issues were closed before work began. This record reports executed checks; it
makes no new platform-support or publication claim.

## Observable contracts

- Target-release upgrade dispatch admits only an exact target; ordinary commands
  retain exact project-pin delegation. Unsupported direct paths refuse before
  writes. The first release has no historical published upgrade edges.
- Synthetic release fixtures exercise preview and successful application through
  an actual target CLI, contract/compiler refusal, breaking-minor acceptance,
  package/pin and reviewed-lock changes, post-check rollback and interrupted
  recovery. They are test releases, not published versions.
- Refresh replaces generated sections and owned skill/docs files, preserves user
  instruction bytes and package/pin content, and binds edited-content acceptance
  to the previewed file snapshots. Legacy checksum adoption is explicit where
  generated content differs.
- A durable private journal serializes file updates and retains incomplete
  restoration evidence. Recovery cannot replay an upgrade or touch a database.
  Changed files, directory/journal identities and unsupported encodings refuse
  unsafe replacement. Recovery works even after the authoritative pin changed.
- Command definitions supply help and offline operation reference. New-operation
  grammar supplies both executable validation and JSON input schemas. The error
  catalog supplies guidance error exit categories and default recovery actions.
- Doctor diagnoses guidance mismatch and verify refuses it before tools. A packed
  public-API application passes tests, the selected Microsoft compiler, both lint
  engines and production build without hidden installs or compiler fallback.

## Red evidence

The initial command-boundary tests failed because the CLI rejected the missing
operations. Separate legacy-adoption and expired-refresh tests then failed at the
intended preservation/deadline assertions before their fixes. The explicit
installed-Fleur verification proof first refused the otherwise supported exact
Fleur dependency. The target-upgrade damaged-pin test first returned recovery
category 5 instead of version category 4.

An independent reviewer reproduced unsafe recovery after pin change, replacement
of the journal directory, invalid UTF-8 re-encoding and deadline violations before
fixes. Its regression assertions remain intact. BOM preservation and actual
target-release dispatch are independently checked too.

## Passing executed checks

On the release-floor Bun 1.4.3:

- `bun test tests/cli/guidance-update.test.ts tests/cli/upgrade-engine.test.ts tests/cli/review-upgrade.test.ts tests/cli/catalog-examples.test.ts`:
  29 passed, 0 failed, 210 assertions.
- `bun test tests/cli/native-candidate.test.ts tests/cli/native-candidate-debian13.test.ts tests/cli/native-candidate-ubuntu26.test.ts`:
  23 passed, 0 failed, 744 assertions. Catalog parity, exact entry/provenance
  refusal and candidate denial of dev/build/start/verify remain enforced.
- `bun test tests/runtime/guidance-verification.integration.test.ts`:
  two fresh disposable-project runs passed, each with 10 assertions. Each packed
  Fleur, installed the real frozen project/tool graphs and the owned archive,
  used public Fleur imports, ran verify and independently verified the resulting
  production artifact. These are ordinary successful verification runs, not
  just mocked subprocess results or an empty scaffold.
- `bun run types`, `bun run lint` and `bun run build:reference` passed.
  Full lint ran both engines. File/diff whitespace checks passed.

Independent review additionally passed 26 focused tests with 188 assertions,
then rechecked the candidate integration and authoritative-pin guard. It found
no remaining reproduced safety blocker. Its run used Bun 1.4.4; this does not
replace release-floor verification.

## Limits and outstanding aggregate evidence

The aggregate local runs were not clean. The first ran while implementation was
changing, causing incompatible module-cache observations; its newer Bun also
changed readiness fixtures that explicitly assert floor observations. All 248
readiness-policy tests passed when rerun under the floor. The candidate builder's
old entry anchor was updated without weakening its provenance/refusal assertions,
and the full candidate suites then passed.

Superseded aggregate runs were cancelled rather than counted as passes. Broader
local CLI/lifecycle runs also encountered subprocess/readiness deadlines
and recovery failures. The restart scenario failed against a pristine copy of
`origin/main` as well. No assertion, timeout, isolation rule or cleanup gate was
relaxed. These runs are failure evidence, not a full-suite pass. Required CI
summaries and remaining recovery execution must be checked before merge.

The selected PostgreSQL/browser recovery run had 7 passes and 1 failure: lost
COMMIT acknowledgement passed twice, complete backup/restore passed twice,
incomplete-restore fencing and interrupted-backup reconciliation passed, and the
maintenance browser recovered after release while refusing interrupted work. The
two-view reactive test timed out waiting for initial healthy query state, before
its offline/reconnect assertions; it is not passing recovery evidence.

The independently authored recovery recipes identify symptoms, diagnostic
commands, authority, recovery and resulting-state proof. Catalog tests validate
every recipe command; referenced existing real PostgreSQL/browser tests establish
state rather than treating exit success as sufficient. Controlled setup fixtures
prove interrupted repository recovery without claiming native setup qualification.

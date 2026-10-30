# Development lifecycle acceptance and evidence

Status: blocked and incomplete. This is a reviewable implementation checkpoint,
not a completed acceptance gate or a PR candidate. No PR, push, merge or issue
closure was performed. Independent review remains the parent orchestrator's step.

Specification: #35, the approved #9 resolution, V1-SPEC lifecycle and JSON v1
contracts, and ADR 0001. Baseline: ab0941a9c7c2c6112fa77aedd63bbfb603b6f293.

## Observable criteria before implementation

- CLI: documented dev/stop/status/logs grammar, strict invalid-option rejection,
  bounded snapshots and cursors, monotonically sequenced stream events ending
  with completed and an exit category. Foreground owns terminal lifetime;
  background survives its caller. Inspection of failure succeeds without restart.
- Ownership: concurrent/repeated starts return one instance; independent projects
  and copied checkouts get independent storage. Repository metadata plus private
  checkout identity bind storage. Ownership requires process start identity and
  verified resource identities. Stale records never authorize unrelated signals.
- Readiness: database/schema, admitted snapshot, rendering, assets and reactive
  delivery must pass before ready. A single default 60-second startup bound
  covers readiness. Explicit occupied ports fail; automatic ports start at 3000.
  App binding defaults to loopback. Broad binding warns about absent auth;
  database and control endpoints remain local.
- Reload: invalid source keeps the last valid app and safe actionable diagnostics.
  Corrected source replaces it; incompatible schema denies database authority.
  Replacement/stop close admission and drain within 30 seconds, preserving
  unknown outcomes without replay. Maintenance fences remain authoritative.
- Persistence and recovery: startup initializes only provably new bindings through
  the existing initializer. Reload never initializes. Stop preserves storage and
  backups. Crashes retain logs and require explicit restart; cleanup verifies
  ownership and removes only disposable resources.
- Documentation, catalog, examples and generated guidance describe implemented
  behavior together. Neutral fixtures exercise these contracts; artifact/start
  packaging from #36 is excluded.

## Agreed test boundaries

| Boundary | Catches | Misses |
| --- | --- | --- |
| Real CLI invocations, JSON, exit, events | Grammar, process lifetime, discovery and output contracts | Browser rendering and physical database guarantees |
| Public lifecycle operations | Concurrent ownership, binding, transitions, port and cleanup behavior | Packed launcher and browser interaction |
| Shared database operations with disposable PostgreSQL | Startup, migration compatibility, maintenance races, persistence and unknown writes | Browser state and CLI formatting |
| Real browser workflows | Assets, rendering, reactive reconnect, invalid/corrected reload | Other native platforms and rare scheduler interleavings |

Timing/network cases require at least two passes. Full suite, types, lint,
reference build, generated-project verification and rendering experiment checks
are final local gates; platform CI remains a separate requirement. Record actual
red commands and intended failures separately from production edits, then green
commands and results. No unexecuted check is passing evidence.

## Executed development evidence (in progress)

Runtime test commands below used Bun 1.4.3 on native Intel macOS. The machine
is running an unadmitted Docker Desktop tuple, discovered during the later
Doctor audit below. These historical component runs are not release
qualification or proof for the final checkpoint.

- `bun test tests/cli/lifecycle.test.ts`: initial catalog test failed because dev
  was missing from help; after catalog wiring it passed. Idempotent unused-project
  stop then failed with exit 1; its implementation passed. Grammar validation
  exposed project-pin probing before command syntax validation; pure validation
  now runs first. Three CLI tests passed (25 assertions).
- `bun test tests/runtime/development-initialization.integration.test.ts
  tests/runtime/maintenance-drain.integration.test.ts`: 11 passed, 125 assertions,
  including the existing repeated drain cases. The initial attempt lacked installed
  dependencies and is not red evidence; frozen-lockfile installation resolved it.
- Public background lifecycle test: intended initial red was dev exit 4 because
  there was no usable instance. One native end-to-end pass then verified ready,
  actual HTTP, instance reuse, read-only discovery, stop and labelled persistent
  container cleanup (19 assertions). A prior run timed out after isolated HOME
  selected different Docker build behavior; it is a failure, not passing evidence.
  The fixture now explicitly preserves the developer's Docker configuration.
- Real PTY test killed the foreground launcher after ready; status remained ready
  beyond its observation deadline. This intended red exposed absent terminal
  lifetime ownership. A foreground-only pipe now closes admission on launcher EOF;
  background callers do not hold that pipe open.
- Persistence/browser fixture errors (a leftover page import and an ambiguous
  label locator) were corrected before evaluating the persistence assertion;
  those errors are not requirement red evidence.
- Intermediate root types and full lint passed before subsequent edits. They must
  be rerun on the final candidate; this does not claim final verification.
- Public persistent-volume proof passed once: separate public CLI startup,
  browser mutation and reactive acknowledgement, public migration inspection,
  restore-verified backup, stop, new public startup, retained edited row/history
  and byte-identical backup/archive manifest. Startup reported `existing` on the
  second process. The test then verified stopped container identity and removed
  only its disposable labelled test volume (24 assertions, approximately 150 s).
- Its earlier intended red was `db migration status` exit 4,
  CONFIGURATION_MISSING, after a real browser commit. Private per-invocation
  context now selects the same owned database and durable maintenance owner for
  existing database operations; process-wide environment is not mutated.
- The reload test exposed status clearing a retained SOURCE_REJECTED diagnostic
  after a successful database probe. That diagnostic now remains until corrected
  source is published. The next rerun also checks changed island code in an
  already open browser, rather than only changed server HTML.
- The PTY stream test observed `ready` as sequence zero instead of `starting`.
  A shared event writer now supplies one monotonic sequence and a terminal
  completed result for foreground dev and opt-in log follow.


## Blocking prerequisite audit

The machine currently reports native Intel macOS 15.7.7, Bun 1.4.3, Docker
Desktop 4.97.0 (244584), Docker Engine/CLI 29.9.2 and Compose 5.6.1. The source
admission in `src/setup/verified-readiness-profiles.ts` admits Desktop 4.96.1
(244132) and Compose 5.6.0 for this macOS tuple. Engine version equality does not
qualify a different Desktop/Compose tuple.

`bun bin/fleur.ts doctor --json` returned exit 4, PREREQUISITE_UNAVAILABLE:
CLI, daemon, Compose and smoke were ready, smoke cleanup was true, but release
was unverified. Neither the profile nor shared Docker installation was changed.

Development startup now invokes that shared Doctor operation, retains only
safe prerequisite states, and binds subsequent control to its qualified local
endpoint. The current public background-dev test fails with exit 4,
`ready: false`, and prerequisite `release: unverified`; no application or
PostgreSQL resource is created. This failure is the expected external blocker,
not passing lifecycle acceptance. An admitted runtime, or separately authorized
qualification of the new tuple, is needed before requirements-based native
implementation and proof can continue.

## Requirements to evidence at this checkpoint

| Requirement | Evidence actually observed | Remaining gate |
| --- | --- | --- |
| CLI grammar, JSON v1, bounded options | Catalog missing-dev red; current lifecycle CLI tests pass, including strict host/port/limit/cursor rejection | Positive foreground/follow completion and force-termination matrix |
| New/initialized/adopted database distinction | Existing initialization/drain group: 11 pass, 125 assertions, real disposable PostgreSQL | Repeat public lifecycle flows on an admitted runtime |
| Persistent storage and backups | One separate public dev/stop/dev pass retained a browser edit, migration history and byte-identical restore-verified backup/manifest | Second pass; newly added lost-acknowledgement extension has not been executed |
| Concurrent owners and project/copy isolation | One public concurrent-start/copy/stop-stop pass, 28 assertions; copied ignored records did not attach original storage | Two admitted-runtime passes and additional dev/stop interleavings |
| PID plus start identity | Kernel boot/start identity, authenticated incarnation control, inherited ownership lock implemented | Public unrelated-live-PID regression is written but not executed |
| Readiness and ports | Component public readiness/status pass; explicit occupied-port red led to early reservation; corrected broad binding and local DB proof passed once | Qualified readiness failure matrix; dynamic-only routes remain an implementation gap |
| Invalid/corrected reload | Source diagnostic clearing red; server-only update with stale island bundle red; corrected server/island browser pass; schema-blocking browser pass | Repeat qualified proof; new old-asset retention assertion was red and its cache fix is not yet green |
| Superseded A/B reload | Public test observed A publishing after B was saved; publication now rechecks the admitted snapshot | Green run and repeats remain |
| Foreground/background | Actual PTY SIGKILL red exposed missing lifetime ownership; foreground pipe and monotonic stream writer added | Final PTY pass, background PTY survival, stale foreground caller, and completed-event proof remain |
| Admission/drain/maintenance | Ordinary stop initially interrupted a real shared maintenance lease; fixed shared-fence test passed once, 17 assertions | Two passes; bounded-drain/unknown-write and retirement uncertainty fault matrix |
| Startup cancellation | Public tiny-deadline/start-stop case passed once; inherited kernel ownership has no publication gap | Repeat after kernel-clock change on an admitted runtime |
| Foreign resources/partial creation | Real foreign same-name container/volume refusal passed; native image creation journals and quarantine retained | Injected partial-creation and uncertain-retirement proof; verified recovery review |
| Crash/restart and logs | Failed state, retained bounded logs, explicit restart and dead-owner recovery implemented | Separate supervisor/database/service crash proof remains |
| Secret boundaries | Intended red exposed raw prerequisite version output in dev JSON; six targeted lifecycle CLI tests now pass, including tool-output redaction and unsafe-private-state denial | Qualified compiler/Docker failure and cursor/admission fault matrix |
| Docs/catalog/generated guidance | Development docs, packaged docs, portable project ID, current generated guidance and internal candidate admission guard updated | Final offline command results below; independent standards/spec review |

The current readiness implementation requires a static registered page. Dynamic-only
applications need a specification-preserving rendering probe before #35 is complete.
The lifecycle runtime tests retain their success assertions; none were skipped or
relaxed to accommodate this machine's unverified profile. Source generation
currently reloads the document; preserving the required reconnect/draft guarantees
across source replacement still needs spec review and, if required, a state-preserving
replacement implementation. This is not an accepted contract amendment.

## Additional observed red/green corrections

- `bun test tests/runtime/development-lifecycle.integration.test.ts --test-name-pattern 'invalid source|incompatible source schema'`: two component passes, 33 assertions. This preceded final prerequisite admission and later asset/journal changes.
- `--test-name-pattern 'occupied ports'`: broad bind reached readiness but returned HTTP 403 through a valid local address (red); corrected origin handling passed with the ambient-configuration test (two component passes, 36 assertions).
- `--test-name-pattern 'superseded reload'`: A was rendered after B had been saved (red). Freshness enforcement added; no green is claimed.
- `--test-name-pattern 'ordinary stop cannot'`: stop returned 0 and killed PostgreSQL under a real held maintenance lease (red). The shared maintenance fence correction passed once.
- `--test-name-pattern 'ambient private database'`: an ambient control URL redirected startup and prevented readiness (red). Explicit owned control configuration passed once against a second real disposable cluster.
- `--test-name-pattern 'foreign same-name|stop during startup'`: two component passes, 26 assertions before the final prerequisite gate.
- `bun test tests/cli/lifecycle.test.ts`: six current tests pass, 43 assertions. The unsafe-state test first observed status falling back to CONFIGURATION_MISSING (red), and the redaction test observed a synthetic tool-output canary in JSON (red). Both now pass without changing their assertions.
- A failing negative CLI fixture initially omitted owner shutdown in its failure path. Its finally cleanup was corrected, and the one identified orphan test supervisor was retired after checking kernel start identity and its exact test command. It had created no database/application containers.

## Verification still required

### Checkpoint checks actually completed

Using the repository-pinned Bun 1.4.3:

| Command | Result |
| --- | --- |
| `bun test tests/cli tests/ci` | 1,408 pass, 0 fail; 13,535 assertions across 89 files |
| `bun run types` | Passed, including the runtime test TypeScript project |
| `bun run lint` | Passed both configured lint engines |
| `bun run build:reference` | Passed declaration build and read-reference verification |
| `bun scripts/verify-generated-project.ts` (two separate runs) | Both passed; isolated frozen dependencies, compiler/lint diagnostics and browser bundling toolchain checks |
| Rendering experiment `bun run lint`, `bun run types`, `bun run build`, `bun run test` | Passed; actual Vite production application build and four tests, 20 assertions |
| Rendering experiment `bun run browser` (two separate runs) | Both passed all three Playwright tests |
| `git diff --check` | Passed |

The rendering experiment verifies its existing server-region/island behavior. It
does not launch the public lifecycle commands and cannot qualify source-generation
replacement or foreground/background behavior. Generated-project verification
likewise makes no application runtime claim.

Final disposable-resource inspection found zero containers, volumes or images
with the lifecycle ownership label and zero development supervisor processes.
The first container-list inspection timed out; a separate bounded retry completed
successfully and found zero. This is observed cleanup of these test fixtures,
not proof that every uncertain-retirement path cleans up correctly.

The complete root test command (including runtime and Python suites), the two-pass
qualified public CLI/browser matrix, and independent standards/spec/evidence
reviews have not passed for this checkpoint. CI must select full runtime scope
and all three required summaries later. A cancelled, skipped or unexecuted check
is not passing evidence. Production artifact #36 and the workout proof remain
outside this change.

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
qualification of the new tuple, is needed before qualified public runtime proof can continue. Static, browser and
component implementation work continues independently of that qualification.

## Requirements to evidence at this checkpoint

| Requirement | Evidence actually observed | Remaining gate |
| --- | --- | --- |
| CLI grammar, JSON v1, bounded options | Catalog missing-dev red; current lifecycle CLI tests pass, including strict host/port/limit/cursor rejection | Positive foreground/follow completion and force-termination matrix |
| New/initialized/adopted database distinction | Existing initialization/drain group: 11 pass, 125 assertions, real disposable PostgreSQL | Repeat public lifecycle flows on an admitted runtime |
| Persistent storage and backups | One separate public dev/stop/dev pass retained a browser edit, migration history and byte-identical restore-verified backup/manifest | Second pass; newly added lost-acknowledgement extension has not been executed |
| Concurrent owners and project/copy isolation | One public concurrent-start/copy/stop-stop pass, 28 assertions; copied ignored records did not attach original storage | Two admitted-runtime passes and additional dev/stop interleavings |
| PID plus start identity | Kernel boot/start identity, authenticated incarnation control, inherited ownership lock implemented | Public unrelated-live-PID regression is written but not executed |
| Readiness and ports | Component public readiness/status pass; explicit occupied-port red led to early reservation; corrected broad binding and local DB proof passed once | Qualified public readiness failure matrix; dynamic-only component proof is recorded below |
| Invalid/corrected reload | Source diagnostic clearing red; server-only update with stale island bundle red; corrected server/island browser pass; schema-blocking browser pass | Repeat qualified proof; immutable asset retention and conservative browser replacement component checks pass below |
| Superseded A/B reload | Public test observed A publishing after B was saved; publication now rechecks the admitted snapshot | Green run and repeats remain |
| Foreground/background | Actual PTY SIGKILL red exposed missing lifetime ownership; foreground pipe and monotonic stream writer added | Final PTY pass, background PTY survival, stale foreground caller, and completed-event proof remain |
| Admission/drain/maintenance | Ordinary stop initially interrupted a real shared maintenance lease; fixed shared-fence test passed once, 17 assertions | Two passes; bounded-drain/unknown-write and retirement uncertainty fault matrix |
| Startup cancellation | Public tiny-deadline/start-stop case passed once; inherited kernel ownership has no publication gap | Repeat after kernel-clock change on an admitted runtime |
| Foreign resources/partial creation | Real foreign same-name container/volume refusal passed; native image creation journals and quarantine retained | Injected partial-creation and uncertain-retirement proof; verified recovery review |
| Crash/restart and logs | Failed state, retained bounded logs, explicit restart and dead-owner recovery implemented | Separate supervisor/database/service crash proof remains |
| Secret boundaries | Intended red exposed raw prerequisite version output in dev JSON; six targeted lifecycle CLI tests now pass, including tool-output redaction and unsafe-private-state denial | Qualified compiler/Docker failure and cursor/admission fault matrix |
| Docs/catalog/generated guidance | Development docs, packaged docs, portable project ID, current generated guidance and internal candidate admission guard updated | Final offline command results below; independent standards/spec review |

Dynamic-only rendering and declared missing-data probes have since been implemented;
see the continuation evidence below.
The lifecycle runtime tests retain their success assertions; none were skipped or
relaxed to accommodate this machine's unverified profile. Source generation now reopens the reactive view and replaces admitted application
modules within the same browser runtime, rather than reloading the document.
The continuation tests cover retained drafts, focus, component state, stylesheet
replacement and query-contract changes; qualified public lifecycle proof remains required.

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


## Implementation continuation from checkpoint 7016767

This continuation preserves the prerequisite profiles and Doctor gate. Installed
Bun 1.4.4 is not used for verification; all commands explicitly select Bun 1.4.3
and put its directory first on PATH for child processes.

Additional criteria and boundaries:

- The public readiness operation must render a project containing only dynamic
  routes, including a route whose schema-valid key correctly produces declared
  NOT_FOUND. It must reject failed rendering and end a stalled transport at the
  supplied readiness deadline. Real restricted execution and disposable PostgreSQL
  catch registration/schema/rendering failures; this component proof does not
  qualify the CLI prerequisite gate or persistent-volume lifecycle.
- Browser replacement must load new admitted island code and compiler-owned
  Tailwind CSS without a second document, retain the same draft/focused input,
  click/mount state, reopen the view once and reject obsolete responses. New
  query contracts must never receive values validated only by an earlier schema.
  Browser protocol fixtures isolate this client behavior; public CLI/browser
  generation handoff remains a separate required proof.
- Closing reactive or native admission must reject new work immediately and
  report unverified drain within the supplied bound. Lost actual Docker control
  transport must retain quarantined capacity and private lease evidence. A later
  explicit close may release it only after verified cleanup. These use public
  lifecycle operations and the existing native/maintenance implementations;
  no successful Docker response or version admission is fabricated.
- Cancellation crosses candidate registration and execution startup. No phase
  starts after creation closes. An already accepted daemon request can remain
  uncertain; neither a timer nor client death proves its retirement.

Observed continuation red phases, separately from implementation:

- The strengthened public invalid/corrected-reload test stopped at the unchanged
  prerequisite gate, exit 4. This is blocked qualification, not a behavioral red.
- Running the new browser replacement assertions against the committed
  checkpoint's reactive browser implementation failed: the document reloaded,
  the draft reverted to Stored and the counter reverted to zero.
- A held reactive backend outlived the supplied close budget in both repetitions,
  returning the test's unbounded sentinel instead of uncertainty.
- Native close ignored its supplied short bound and resolved successfully in both
  repetitions. Actual Docker transport loss retained capacity but a later close
  kept returning the earlier rejection; the new explicit-recovery test was red.
- New island code using its changed query output schema emitted browser errors
  when it briefly received the old cached value. Cache invalidation before code
  publication corrected this without resetting local island state.
- A new Tailwind utility appeared in the DOM but remained unstyled because the
  application realm correctly denied the ordinary stylesheet setter. The trusted
  transport now retains a narrow validated setter; application authority is unchanged.
- A readiness probe to a stalled listener ignored the supplied deadline and
  returned the unbounded sentinel. The signal now covers every probe request.

The first bundle-split attempt also failed because Vite removed module exports
under application-entry defaults. Explicit entry signatures fixed that build
integration error. One early browser fixture included excess fields in its view
identity and was corrected before its results were used as behavioral evidence.

## Continuation results and limits

These checks used the pinned Bun 1.4.3. Component checks on the current host do
not admit its Docker tuple or replace public lifecycle acceptance.

| Command or boundary | Result actually observed |
| --- | --- |
| `bun test tests/runtime/retained-execution.integration.test.ts` | 13 passed, 107 assertions. Includes two repetitions of strict busy deadlines, bounded close and actual Docker-control transport loss with retained quarantine followed by explicit verified retirement. |
| Dynamic-only readiness integration, two separate runs | Each passed seven assertions, including a schema-valid long dynamic key, declared NOT_FOUND, rejected rendering and bounded stalled transport. Real disposable PostgreSQL and restricted execution were used. |
| Browser replacement, asset retention, reactive protocol/transport/regions, mutation policy, presentation build and source admission group | 83 passed, 398 assertions across ten files. Each browser replacement variant ran twice internally. |
| `bun test tests/cli/lifecycle.test.ts` | Eleven passed, 102 assertions. Missing records, unresolved creation evidence and redirected native directories cannot produce a false stopped result. Explicit verified recovery leaves a durable stopped receipt. |
| Types, lint and reference build | Passed after the asset-cache implementation; types and lint also passed after the recovery-directory and missing-record corrections. Later edits still require final checks. |
| Generated-project verification, two final runs | Both passed after the latest generated guidance, with isolated frozen dependency graphs and the configured compiler/lint/bundler checks. |
| Rendering experiment lint, types, production build and test | Passed; four tests and 20 assertions. This is an actual production application build, separate from reference declarations. |
| Rendering experiment browser, two runs | Both passed all three tests. The experiment is not public lifecycle proof. |

The complete root `bun run test` was executed during continuation and **failed**.
It ran while implementation was still changing, so it is diagnostic evidence,
not a final-head gate. CLI/CI reported 1,404 passes, five failures and one async
error across 1,409 tests. The failures were the existing packed-launch timeout,
two fresh-session cancellation deadlines, fresh enrollment resume and denied PTY
completion. Repeating exactly those five cases, without changing their assertions
or deadlines, passed twice with 30 assertions per run. The full-run failures
remain recorded; targeted passes do not erase them.

The runtime portion reported 399 passes and 23 failures across 422 tests. Seventeen
public lifecycle cases were refused by the unchanged unadmitted-runtime gate.
Two existing busy-native deadline cases failed under the concurrent full run.
Two retirement-control-loss cases, one cancelled-open case and one compatible
browser-replacement case used module versions loaded before their fixes. The
later complete retained-execution file and browser group above passed with those
fixes. Newer public fault cases were not collected by that earlier process and
are not claimed as executed. All five native Python suites passed, 59 tests in
total. A final full runtime/Python gate remains required.

## Browser compatibility decision and additional failure cases

The observed hook-order experiment inserted a state hook before a mounted
island's existing hooks. Its stable export and key did not prevent Preact from
assigning old state slots to different hooks and corrupting the draft. The parent
orchestrator chose conservative recovery within the existing draft-preservation
requirements: incompatible or uncertain hook layouts retain
the previous browser generation until explicit navigation. No specification
amendment or automatic draft reset was introduced.

The deterministic browser regression now covers compatible replacement,
incompatible hook insertion, an uncertain custom hook and query-derived local
state. It preserves the original focused DOM input, unsaved draft, nested state,
mount count and unknown mutation outcome. Compatible edits update code, CSS and
query validation automatically. Incompatible views display an actionable stale
diagnostic; obsolete mutations are refused before forwarding. Explicit navigation
opts into the new generation without replay. These are real browser component
checks with a controlled protocol backend, not SQL commit or public dev proof.
The conservative AST analysis and its limits are documented in development
guidance. It does not prove arbitrary JavaScript state migration.

Publication now rechecks the admitted snapshot after retirement and can reopen
the last valid immutable application if a newer invalid save superseded the
candidate. Candidate cancellation closes creation admission. A failed database
or gateway closes that admission too, so a late candidate cannot implicitly
restart a failed instance. New public tests cover these races, stable-URL asset
bytes, uncertain maintenance, and retirement evidence; their qualified runs
remain outstanding.

Immutable browser assets remain available for retained browser generations in a
bounded cache. Quota or conflicting content refuses replacement before retirement.
Mutable presentation URLs continue serving the current admitted bytes. Two
component repetitions verify retention and atomic refusal; the public asset-byte
browser case has been written but not qualified.

Docker quiet windows requested by the parent were honored. Only uniquely owned
active workloads were retired; no global prune, unrelated container removal or
profile edit was performed. At the latest acknowledgement, the active container
inventory was empty and no owned supervisor/native test command remained.
Stopped objects and original images were preserved. Lack of an active process
alone is not evidence that an uncertain retirement was verified.

Public profile admission, two qualified public timing/network passes, final
full gates and independent standards/spec review remain outstanding. No public
end-to-end or release result is claimed here.


Further non-Docker recovery regressions failed for the intended behavior before
production edits. Missing instance records hid inert unresolved creation evidence
from status, stop and dev. The first red reported stopped; after status was fixed,
stop still returned exit zero, and then dev reached prerequisite probing instead
of refusing recovery. Each was corrected separately. A subsequent recovery test
showed that verified cleanup lacked a durable stopped receipt and could not permit
restart. The receipt is now published only after reconciliation succeeds.
A redirected empty native directory also made stop return success. Recovery now
checks its actual owned private directory before examining any journals. The
foreign target remains unchanged. These checks created no database or container.

The PostgreSQL image-preflight, credential-argument and tool-file ownership
regressions are being prepared during the parent's Docker quiet window. They
have not been executed and are not red or green evidence yet. Their direct
resource-operation boundary will be component engineering evidence only; the
public persistent-volume proof still requires separate CLI processes on an
admitted runtime.


The latest complete lifecycle CLI file passed eleven tests and 102 assertions.
The new bounded-log case passed independently and again in that complete file.
It verifies authenticated cursor continuation, tampering refusal without echoing
the token, monotonic finite follow completion for a failed instance and absence
of the machine-local project path in output. This covers an existing contract;
no new behavioral red is claimed for that case.

A stale stopped receipt under a real live ownership lock was an additional
observed red: status reported stopped. Status now refuses both missing and stale
publication evidence while ownership remains. The test preserves and restores
the actual failed supervisor record before cleanup; it does not inject Doctor
success or start any Docker workload.

Project creation, project-pin enforcement and packed-launcher suites passed
54 tests and 546 assertions after the guidance and lifecycle changes. The packed
suite retained its interruption/grace checks and all existing deadlines.


The PostgreSQL resource implementation now preflights the pinned image before
writing creation intent or creating its volume. Container creation receives a
private mode-0600 environment-file handoff rather than a password argument.
Only verified owned creation or stop retires that handoff. Unconfirmed creation
retains its private evidence. Generated PostgreSQL tool scripts use exclusive
creation and verify an existing file's owner, mode, link count and exact bytes;
they never overwrite or follow a foreign target. These changes were made while
Docker testing was prohibited by coordination. Their written regressions are
still unexecuted, so no behavioral red or runtime green is claimed for them.


After these PostgreSQL file-handling edits, pinned types, lint and the reference
build passed. The five native Python component suites also passed again, 59 tests.
No Docker workload was launched during this quiet window. The final full root
suite and PostgreSQL regressions remain unexecuted at this revision; the earlier
complete-suite failure and subsequent focused results above retain their stated
scope. The unrelated inherited clean-CI commit is not an ancestor of this branch.

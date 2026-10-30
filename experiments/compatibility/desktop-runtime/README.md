# Native Intel Desktop runtime qualification

This internal qualification driver must run the unchanged Linux runtime probe in
Docker Desktop's native x86_64 Linux VM. Ubuntu is only the trusted controller's
userspace. It is not an Ubuntu host qualification or an owned full-system guest.

Required behavior before runtime admission:

- Bind native untranslated Intel macOS and the exact Desktop/Engine/kernel tuple,
  source commit and all controller/probe files, immutable controller image, local
  Unix endpoint, daemon identity, VM boot identity, manager PID and namespaces.
- Run the original compiler with its executed binary hash pin. Run every original
  report, thread, resource, descriptor/replacement and two ordinary plus two idle
  lifecycle oracles. Keep the 11-second broker pause, 30-second worker deadlines
  and 250ms physical-exit tolerance. Arm and measure inside the Linux VM.
- Keep application workers unchanged. Only the trusted controller may use host
  PID/cgroup namespaces and the Docker API socket. Its root filesystem is read
  only, network is none, temporary storage is bounded and private, and capabilities
  are explicitly enumerated. Never use privileged mode or host filesystem mounts.
- Refuse unknown tuples, program/image drift, ambiguous transport, source mismatch,
  incomplete runtime evidence, uncertain build retirement or unconfirmed cleanup.
- Independently remove owned controller/workers/images, confirm absence and
  preserve the original Docker context, daemon, container and image inventories.
  A partial result or preparation success is never runtime admission.
- Execute and independently review the full native qualification twice before
  adding a source-owned exact readiness profile. Keep failed attempts as failures.

Image preparation may acquire official Ubuntu packages into a disposable image.
It installs no host software. The image's actual package inventory and immutable
image identity must be retained. Compiler and runtime pins remain mandatory.

Image preparation runs only through the explicit `desktop_runtime_images` manual
input on the existing native GitHub amd64 runner. The ARM readiness job and every
required summary remain intact. Preparation executes the original compiler and
trusted Bun build/tests inside the exact controller image, exports both immutable
images and retains package versions, tool hashes, source hashes and retirement
receipts. Its deliberate stop before worker execution is not a runtime pass.
The ordinary runtime path keeps its original compiler/build behavior.

The Desktop path accepts only an internally typed prepared image whose source
and newly recompiled native helpers match the producer. It requires ownership,
independent-deadline and cleanup adapters before any worker can start. The owner
handoff accounts for all thirteen original worker names and blocks until the
external observer acknowledges the durable ledger. Preparation and measurement
are separate; the personal Mac must not run daemon-side image builds.

A separate guardian has no Docker socket or network. Its fixed wrapper executes
the unchanged Linux pidfd guard in the VM and retains the actual bound records
in a bounded private journal, including after manager stdout disappears. Closing
the manager connection cannot retire the guardian. Normal qualification must
retain original deadline results; a manager-loss/EOF control must separately
prove this behavior natively. Lost records remain failures. The outer observer
must verify worker absence before retiring the guardian, then confirm all owned
images/controllers are absent and original inventories preserved.

The source-owned `image-origin.json` catalog authenticates the producer run, ZIP,
origin and every artifact. The native observer retains private descriptors,
validates one untagged amd64 OCI image per archive, loads through those same
descriptors, and rechecks the bytes after the load clients retire. The immutable
identity chain retains the producer config digest separately from the native OCI
manifest execution digest and verifies the native descriptor, config and layer
diff IDs. Image inventories include untagged objects; cleanup uses the exact
validated native manifest identity. Operator source
is bound separately from the producer payload commit.

Native execution proceeds through capabilities, a manager-loss control and full
qualification. Full qualification automatically requires a fresh successful loss
control. The manager hands off each already-armed guard identity, PID and original
VM deadline; the observer verifies the live worker and durably acknowledges that
binding before execution proceeds. Cleanup stops the creation authority before
sweeping all worker names and retains the guardian on uncertain worker retirement.
Original resource snapshots include stable container state/configuration and image
reference mappings. Every partial result keeps runtime admission false.

Run the internal observer with `--mode=--capabilities`,
`--mode=--guardian-loss` or `--mode=--qualify`, `--images-directory` pointing to the
private authenticated inputs, and `FLEUR_DESKTOP_RUNTIME_QUALIFICATION=yes`.
Preparation, unit fixtures and capability results never establish full runtime
qualification or readiness admission.

The internal `--mode=--controller-diagnostic` lane traces only the unchanged
controller's fixed-command refusal. It retains bounded command outcomes and
socket ownership metadata while using the same manager authority. It declares
its instrumentation and program hash and always refuses qualification, including
when the underlying capability commands succeed. Diagnostic results cannot admit
a readiness profile or replace any capability, manager-loss or runtime check.

## Candidate selection and existing Bun executable

The internal observer accepts `--candidate=desktop-4.97.0-244584` for Intel macOS
15.7.7, Desktop 4.97.0 build 244584 and Compose 5.6.1. The control preflight binds
CLI 29.9.2/a82e528, Engine 29.9.2/0367cbe, Linuxkit 7.0.14-linuxkit,
containerd v2.4.2/b7a25261e029d68978bbf290df0a62fc819b3c51,
runc 1.5.2/v1.5.2-0-g29dd3dc2 and rootful cgroupfs/v2 with builtin seccomp
and cgroup namespaces. Selection permits measurement only. It does not add a
readiness profile. Unknown selections and mismatched observations refuse before
container creation. Omitting the selection retains the 4.96.1/244132 candidate
and its existing preflight checks.

`--pinned-bun="$QUALIFICATION_BUN"` selects an existing absolute executable.
The default remains the user's `.bun/bin/bun`. The observer resolves the path
and requires a bounded regular executable owned by root or the observer's
effective UID. Group/world write permission and all special mode bits, including
setuid and setgid, refuse before either launch. Ownership participates in drift
checks. Hash-matching bytes do not waive this authority policy.

The observer copies bytes from the open source descriptor into an exclusively
created file in its own mode-0700 temporary directory. It authenticates the source
while copying, flushes the copy, sets its mode to 0500, closes every writable
descriptor and independently authenticates the complete copy. The new file has
one link and belongs to the observer; source ownership, modes and other metadata
are not copied. Both the exact `1.4.3` version command and fixed preflight launch
execute this private copy. They never execute the selected source pathname.
Atomic pathname replacement and in-place updates to the source therefore cannot
change the launched bytes. Source rechecks still refuse drift after either
command; those checks are evidence checks, not the execution-custody mechanism.
The copy is removed on scope exit, including refusal paths. Unconfirmed command
retirement remains a failure under the existing bounded runner.
It is temporary qualification scratch, not a host installation.

The threat model trusts the observer and its private directory, consistent with
the [existing host authority boundary](../../../docs/planning/V1-SPEC.md#runtime-isolation-and-production-feasibility-gate).
It handles updates or replacements of the selected source, including writes
through another source hard link. It does not sandbox root or a process running
as the observer that deliberately tampers with the observer's private storage or
code. No claim of a kernel-sealed immutable file or descriptor-based execution
is made. The executable path is one argv element, never shell input, and private
source/snapshot paths are omitted from reports. The Darwin x64 executable SHA256 is
`c2a945a9d33f9088b32ac3550d1d1fd485a7fc10d71c66f91ef0d33b41cefa7c`.
It was extracted from the 1.4.3 archive authenticated against the existing
`platforms/bootstrap.py` archive pin
`62660e6438eb872278877acca77e1152d5d031324df368d4a81b428211489d2d`.
No executable is downloaded or installed by this selection.

Acceptance cases were recorded before the tooling changes at the existing
qualification-driver and refusal seams:

| Requirement | Observable acceptance or refusal | Coverage |
| --- | --- | --- |
| Exact candidate selection | 4.97 reaches the original proof; unknown selection, other build, OS, Compose, CLI, component or security tuple refuses before creation | `tests/cli/desktop-control-integrity.test.ts` |
| Existing 4.96 behavior | Default still reaches original proof and preserves ownership/cleanup refusals | Existing Desktop control tests |
| Pinned executable | Private copy remains one argv element; wrong source/copy hash or exact-version output refuses before preflight | `test_qualification_inputs.py`, `test_bun_execution_custody.py` |
| Execution custody | Source pathname and in-place replacement immediately before each launch cannot execute replacement markers | `test_bun_execution_custody.py` |
| Executable authority | Setuid, setgid and foreign source owner refuse without version/preflight launch; executed copy is observer-owned mode 0500 | `test_bun_execution_custody.py` |
| Selected/returned candidate binding | Different candidate in successful preflight refuses before outer Docker operations | `test_qualification_inputs.py` |
| Operator source binding | Changed preflight source refuses before Bun execution; both observer and preflight inputs are retained in operator hashes | `test_qualification_inputs.py` |
| Producer, image and payload drift | Changed catalog, source, archive, image descriptor/config/layers or helper bytes refuse | Existing artifact, OCI, producer-binding and prepared-custody tests |
| Runtime proof and disposal | Original compiler, two ordinary/two idle repetitions, 11-second pauses, 30-second deadlines, 250ms exit tolerance, guardian custody and complete inventory preservation remain required | Existing runtime/controller tests; native repeated proof still required |
| Admission | Candidate preparation and fixture results leave readiness unverified | No readiness-profile change; two independently reviewed full native attempts plus packed readiness proof remain required |

## Staged fresh preparation and native follow-up

These are follow-up commands, not evidence of execution. First obtain independent
standards/spec/security review of the committed tooling. The parent coordinates
branch push and explicit workflow dispatch after that review. Do not open a PR
or run native qualification during tooling preparation.

Use the unchanged native prerequisite workflow on the pushed qualification
branch, whose exact head is recorded as the producer source:

```sh
gh workflow run native-setup.yml --repo hazeion/fleur --ref "$QUALIFICATION_BRANCH" \
  -f desktop_runtime_images=true
```

Leave `debian_helpers` empty and `debian_recovery` and `arch_boot_observation`
false. Require the scope job, both ordinary native jobs and required summary to
pass. Record the dispatched run ID, head SHA, workflow/event/ref and successful
x86_64 preparation step. Download that run's `native-setup-x86_64` artifact by its
exact artifact ID, retain its ZIP and SHA256, and authenticate the API metadata
against the selected run/head before using its bytes. Use the run and artifact
IDs selected from that dispatch, never a latest-artifact lookup:

```sh
gh run view "$PREPARATION_RUN" --repo hazeion/fleur \
  --json databaseId,headSha,headBranch,event,workflowName,conclusion,jobs
gh api "repos/hazeion/fleur/actions/runs/$PREPARATION_RUN/artifacts"
gh api "repos/hazeion/fleur/actions/artifacts/$PREPARATION_ARTIFACT/zip" > "$PREPARATION_ZIP"
shasum -a 256 "$PREPARATION_ZIP"
```

The selected artifact must be unexpired, named `native-setup-x86_64`, and belong
to the recorded successful producer run. Keep generated inputs and receipts
outside the checkout.

Before native execution, independently review the preparation result and update
only the source-owned `image-origin.json` catalog with the actual producer run ID,
artifact ID, ZIP SHA256, raw artifact `image-origin.json` SHA256 and its complete
`origin` object. Commit that catalog. The operator commit may differ from the
producer commit; every selected payload byte must still match both producer Git
source and the current checkout. Do not reuse the historical catalog to bypass
source drift.

Verify all seven payload artifact sizes/hashes and producer cleanup, the complete
`source-manifest.json` closure selected by `export_images.source_name`, compiler
and helper hashes, preparation provenance, package/tool inventory and both OCI
archives. The closure includes every tracked top-level `runtime-probe` file,
including its ignore file, the five controller inputs and rendering package/lock
files. Authenticate configuration and native manifest identities separately.
The consumer enforces private directory mode 0700, file mode 0600, single-link
owned regular files, a closed eight-file inventory including artifact origin,
retained descriptors and post-load rechecks. Run the existing artifact and OCI
validators without loading images during review.

After the parent reserves a quiet Docker window with the lifecycle implementer,
run capabilities and review its receipt before full qualification:

```sh
FLEUR_DESKTOP_RUNTIME_QUALIFICATION=yes python3 -I scripts/observe-desktop-runtime.py \
  --candidate=desktop-4.97.0-244584 --pinned-bun="$QUALIFICATION_BUN" \
  --mode=--capabilities --images-directory="$QUALIFICATION_IMAGES" > "$CAPABILITIES_REPORT"
```

Then run the following command twice with distinct private report destinations,
reviewing each attempt independently. Each full command automatically runs a
fresh manager-loss control using the same candidate and executable selection.

```sh
FLEUR_DESKTOP_RUNTIME_QUALIFICATION=yes python3 -I scripts/observe-desktop-runtime.py \
  --candidate=desktop-4.97.0-244584 --pinned-bun="$QUALIFICATION_BUN" \
  --mode=--qualify --images-directory="$QUALIFICATION_IMAGES" > "$QUALIFICATION_REPORT"
```

A failure remains failed, including uncertain cleanup or changed unrelated
inventory. Do not add a readiness row until the two full native results have
passed independent review. Packed public Doctor/setup readiness proof and issue
35 public lifecycle proof remain separate follow-up gates under the parent's
quality decision. No runtime pass is claimed by this tooling change.


## Local execution-custody evidence

The correction to the original tooling commit first reproduced eight intended
regression failures. Four actual synthetic-program launches executed replacement
markers at the version/preflight boundaries, through both pathname replacement
and in-place writes. Separate launch-interception tests demonstrated missing
setuid, setgid and foreign-owner refusals without executing special-mode files.
The positive control also required authenticated observer-owned mode-0500 bytes.
After the correction, every replacement marker stayed absent and both normal
launches used only the private authenticated copy, which was removed afterward.

An opt-in non-Docker test additionally uses an existing archive-authenticated
Mach-O Bun 1.4.3 on Intel macOS. It mutates only disposable copies of the selected
binary. Across all four launch/mutation combinations, the private executable
returns exact version output and a fixed JavaScript probe reports its own
executed binary SHA256 matching the source pin. No preflight script, Docker
command or qualification workload runs in this test:

```sh
FLEUR_TEST_PINNED_BUN="$QUALIFICATION_BUN" python3 -W error::ResourceWarning \
  -m unittest discover -s experiments/compatibility/desktop-runtime \
  -p test_bun_execution_custody.py
```

This test passed on the required Intel macOS 15.7.7 host. A separate exploratory
`/dev/fd` launch of the pinned Mach-O returned permission denied, so the tooling
does not use that mechanism. Unit/probe success remains distinct from native
Docker qualification or readiness admission. The earlier broad CLI failures and
Linux-only pidfd/observer failures remain failed evidence; they are not converted
into Mac passes by these targeted checks.

## Controller candidate propagation correction

The first 4.97 capabilities attempt at operator
`3050547599a6050903245f5029b349928f9e31f1`, using artifact `12952360196`
from producer `d27ba3f437f93fb47e81d4c23e267f3467f837e4`, failed with exit 4
in 109.759 seconds. Report SHA256 is
`46f1b26ede97d874f652769297b86ccbe9a1130bd9e6da347e22133c6fdcc4cb`.
The outer error was `CONTROLLER_RESULT_UNPROVEN`; the actual controller returned
`DESKTOP_TUPLE_CHANGED`. The native control preflight observed the selected
Desktop 4.97.0/244584, but `entry.py` still compared against a literal
4.96.1/244132. The attempt remains failed. Its preflight resources, manager,
guardian and two imported images were confirmed absent. Original inventories,
including all fourteen preexisting stopped containers, were preserved. No full
qualification or runtime admission followed.

The correction adds a required `candidate` field to the closed internal binding.
The controller owns the exact candidate-ID-to-platform allowlist; the Python
observer takes its accepted IDs from that same source. The actual server must
match the platform selected by that bound ID, alongside every existing exact
Engine/kernel/architecture check. Accepting either known platform independently
of the selected candidate would be incorrect. Missing, unknown and coercible
candidate fields refuse. Existing 4.96 default selection is retained; historical
raw bindings without the new field are not accepted by the new controller.

The candidate travels in the exact environment bytes already checked by role
profiles and hashed into guardian/manager ready frames. No ready-frame fields
need to change. Controller result frames echo the validated candidate; the outer
observer refuses a changed or omitted result candidate. Candidate support grants
measurement authority only. No readiness profile or public override is added.

### Diagnosis and regression evidence

The recorded error and exact guard establish the cause. Following the diagnosis
loop, the native reproduction was minimized to production observer candidate
checks and both binding writes, serialized into the actual controller `main`.
Host file/command boundaries are fixtures. This caller-to-controller regression
first failed in 0.035 seconds with the same `DESKTOP_TUPLE_CHANGED` symptom,
while the legacy default reached the next daemon check. Repeated red runs also
caught selected/observed cross-matches, missing binding selection and unchecked
result candidates. After correction, matched candidates reach the existing daemon,
guardian and root-launch checks; mismatches stop at the tuple guard. The tests
stop at controlled later refusals and never fabricate a runtime success.

```sh
python3 -m unittest discover -s experiments/compatibility/desktop-runtime \
  -p test_candidate_callsite.py
```

Speculative hypotheses, bisection and new native instrumentation were skipped
because the retained controller error and source comparison already identify the
cause. The minimized caller regression replaces the native feedback loop for
this implementation phase. Re-running the original native scenario is deliberately
pending: its artifact is now stale and fresh measurement is not authorized here.
No original failed evidence is rewritten, and no debug instrumentation was added.

### Candidate path audit

| Path | Selection and refusal contract |
| --- | --- |
| Observer CLI/default | Only controller-owned IDs are accepted. CLI and callable defaults retain 4.96. `--qualify` passes the same candidate and pinned executable into its fresh loss control and full attempt. |
| Bun preflight | The explicit selected ID chooses one exact source-owned platform, with all existing host/Compose/CLI/component/security pins. Unknown and selected/observed mismatches refuse. Its echoed ID must match the observer selection. |
| Binding construction/parser | Both actual observer binding writes retain selection. The parser requires its exact known ID before role, source or command authority. No arbitrary version string is accepted. |
| Guardian startup/ready | The actual controller parser validates selection; the existing ready hash covers the complete serialized binding. A different selected ID changes that hash and refuses outer readiness. |
| Manager capabilities/qualify | Both use the same actual controller guard. The bound ID selects the expected exact platform. Daemon/boot/source/image/guardian/compiler checks still follow in their original order. |
| Loss manager | Its fixed program uses the same strict binding parser and existing boot/worker/deadline identities. The outer observer has already bound the exact preflight/server tuple. It has no separate Desktop-version literal. |
| Guardian guard | It inherits the validated guardian environment through the fixed launcher, which permits no environment override. Its existing boot, worker, journal and original VM deadline checks remain. It does not select a Desktop platform. |
| Diagnostic lane | It runs the same source-hashed controller `main` with the same binding. Instrumentation does not replace tuple validation and always refuses qualification. |
| Result validation | Controller results retain validated selection; the outer acceptance branch requires that same ID along with all original source/nonce/VM/manager identities. Ready frames bind selection through their existing raw-binding SHA256. |
| Source/preparation | `entry.py`, including its allowlist/parser/guard, is one of the five exact controller sources in the 94-file producer closure. Producer, operator and image-layer bytes must agree. Preparation itself selects no runtime candidate and remains non-admitting. |
| Original runtime/cleanup | No Desktop-version literals occur in the runtime probe. Compiler pins, worker/guardian authority, ownership sweeps, complete inventories, two ordinary/two idle repeats, 11-second pause, 30-second deadlines and 250ms tolerance are unchanged. Both Bun custody fixes are unchanged. |

The audit found Desktop version/build literals only in the observer default,
Bun preflight selection and the controller allowlist within the executable
qualification sources. Other platform/component checks remain exact. Existing
readiness and installer catalogs retain their independently established scope.

### Artifact consequence

Changing producer-bound `entry.py` invalidates artifact `12952360196` for a new
operator payload. Its ZIP, raw origin, manifests and tracked catalog remain
unchanged as historical evidence. The existing payload source check must refuse
those old bytes with `PAYLOAD_SOURCE_BYTES_CHANGED`; no source mismatch is
bypassed. Other 93 payload source hashes remain unchanged by this correction.

After new independent tooling review, the parent must authorize fresh preparation
on the reviewed new commit, audit the resulting exact artifact and separately
commit its approved catalog. Only then can a newly authorized quiet-window
capabilities attempt occur. Fresh manager-loss/full qualification repeats and
packed public readiness/lifecycle proof remain separate gates. Local regression
success does not convert the failed native attempt into a pass.

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
The default remains the user's `.bun/bin/bun`. The observer resolves the path,
requires a bounded regular executable without group/world write permission,
authenticates its bytes before execution and requires exact `1.4.3` version
output. It rechecks identity and bytes after the version command and preflight.
The selected path is an argv element, never shell input, and is omitted from
reports. The Darwin x64 executable SHA256 is
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
| Pinned executable | Explicit path remains one argument; wrong hash or exact-version output refuses before preflight | `test_qualification_inputs.py` |
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

# CI scope and verification

The [approved platform amendment](https://github.com/hazeion/fleur/issues/5#issuecomment-6385377944)
requires Intel macOS, Ubuntu 24.04/26.04 amd64 and Debian 13 amd64 qualification.
Apple Silicon, other ARM64 targets and Arch are deferred and do not block #24 or
v1 release qualification. Keep existing GitHub ARM jobs, useful Arch/ARM fixtures,
historical evidence and all required summary checks. Limited component results
do not imply complete deferred-platform support. This scope change does not
alter assertions, isolation, cleanup, repeats or deadlines for required targets.

CI cost savings must preserve the evidence required for acceptance. Every workflow
runs a small Linux scope job with CI policy tests, followed by a verification
summary. Workflows are never omitted through path filters or skip-CI messages.

## Which checks run

Pull requests may omit the existing platform jobs only when the complete PR diff
contains regular, nonexecutable files in this documentation allowlist:

- Root README.md, AGENTS.md and CONTEXT.md.
- Markdown files under docs/planning/ and research/.
- This CI policy document, docs/ci.md.

Existing workflow files may also qualify when their parsed behavior is identical
apart from top-level concurrency and upload-artifact retention-days. Changes to
commands, action pins, permissions, triggers, matrices, job conditions or other
workflow behavior require the full suite. New or deleted workflows do too.

All other paths require full verification, including runtime code, templates,
packaged documentation, dependency manifests and locks, tests, tooling,
configuration and the scope selector itself. Do not broadly exempt all Markdown
or all workflow files. Push and manual workflow_dispatch events always run the
full suite. Compatibility remains PR-triggered plus manual dispatch; CLI and
native setup also run on every main push.

The selector reads a complete local Git diff from the merge base to the tested
revision, with no GitHub changed-file limit. It includes earlier commits in the
same PR, treats renames as deletion/addition, and checks Git modes. Unknown,
missing or malformed evidence selects full verification. Failure of the scope
job fails its summary rather than silently accepting skipped jobs.

## Required summaries

The stable summary checks are CLI verification, Native setup verification and
Compatibility verification. Each depends on its scope job and every original
job in that workflow. When full verification applies, every dependency must
succeed; failure, cancellation and unexpected skipping fail the summary. When
the documented narrow exemption applies, platform jobs are explicitly skipped.
That is not a runtime/platform pass and cannot establish new release evidence.

Use these summaries as required contexts when repository protection is available;
do not require only a conditionally skipped platform job. Existing platform job
names remain unchanged. No assertion, deadline, architecture, repeat count,
resource limit, isolation or cleanup check is removed.

## Action runtimes

GitHub JavaScript actions use Node 24 internally, with immutable commit pins.
The current checkout and artifact-upload pins declare `runs.using: node24`;
GitHub-hosted runners supply that action runtime. Fleur and its verification
commands continue to use the pinned Bun runtime. Keep checkout credentials
unpersisted and routine artifact retention at seven days when updating actions.

## Cost controls and rollout

Superseded PR runs are cancelled only within the same workflow and PR. Every main
push has an independent run. Routine diagnostic artifacts expire after seven
days, so record durable sanitized evidence before expiry. Rerun only failed jobs
when investigating the same commit; do not rerun a whole matrix without a reason.

Installing or changing this selector requires full verification once. The selector
cannot exempt changes to its own code, tests or integration. Existing test failures
remain failures during rollout; do not hide them with an exemption or weaken their
assertions. Keep unrelated runtime repairs separately reviewable.

Run `bun test tests/ci`, `bun run types` and `bun run lint` before publishing policy
changes. The policy tests also run as part of `bun run test`. Manual dispatch offers
a full verification run even for documentation-only changes.

## Explicit fresh Debian qualification

The native workflow accepts an optional `debian_helpers` manual input containing
only the recorded amd64 helper pair as compact base64 JSON. Empty input preserves
the ordinary x64/ARM readiness run. Nonempty input additionally runs the fixed
Debian 13 x64 KVM verifier inside the existing x64 job. The optional boolean
`debian_recovery` selects the fixed interrupted-recovery verifier and requires
the same helper pair; missing helpers fail before provisioning. Its default is
false. Neither selector changes the ordinary ARM checks. Invalid input fails that
job and its required summary. The payload is read as data from the event file,
never interpolated into a shell. Exact source-owned helper sizes and SHA256 pins
are checked before provisioning. No caller URL, package, profile or command is
accepted.

This explicit case has a 40-minute outer job budget; ordinary jobs retain ten
minutes. Guest boot, session, runtime, repeat and cleanup limits remain unchanged.
The hosted-only harness first proves systemd cgroup containment using harmless
detached children, including stop, timeout and cancellation before execution.
Only then may it install the frozen 18-package QEMU test-tool closure observed on
the exact reviewed runner images. Each image record binds a read-only inventory
report, source commit, run and attempt; unknown image versions remain refused.
It refuses prior tool-package state, upgrades, removals,
changed package plans and unexpected actual package deltas. It checks that the
host Docker daemon identity, service invocation/PID and resource inventories stay
unchanged. This preparation applies to the disposable runner's verification tools,
not Fleur's product setup policy.

Root-managed service cgroups contain both the privileged test-tool transaction
and the unprivileged KVM verifier. Invocation-bound terminal receipts and cgroup
retirement are required. Cancellation, timeout, uncertain cleanup or incomplete
native proof fails qualification, including when the outer harness later removes
its scratch. An uploaded report alone is not passing evidence. This manual lane
adds no ordinary release profile and establishes no human-consent proof.

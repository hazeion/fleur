# CI scope and verification

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

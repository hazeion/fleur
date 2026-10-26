---
status: accepted
date: 2026-10-25
decision-makers: Fleur maintainer
---

# Reuse application containers with fresh restricted processes

Fleur will retain application containers and start a fresh restricted application
process for each operation. The maintainer selected this design during the live
native execution discussion for [#30](https://github.com/hazeion/fleur/issues/30),
prioritizing responsiveness and future runtime control. This accepts the design
direction; it does not qualify an implementation or waive any native gate.

## Context and alternatives

[PR #54](https://github.com/hazeion/fleur/pull/54) implements reactive delivery but
has not passed native qualification. Pinned Bun 1.4.3 on Intel macOS missed the
five-second post-commit refresh assertion even with prepared one-shot workers.
Aggregate query/render timings do not identify which lifecycle stages dominate.
Additional native browser and maintenance failures remain open; unconfirmed guard
cleanup evidence must be investigated independently of performance.

Two designs were compared:

- **A: reuse trusted control infrastructure, fresh application container per
  operation.** This retains more existing configuration, init-process and
  container-disposal proofs, but repeats application-container creation and
  removal. It was the lower-proof-cost alternative.
- **B: reuse application containers, fresh restricted process per operation.**
  This can remove application-container setup from warm operations. It requires
  new process identity, accounting, retirement and contamination proofs. The
  maintainer chose this option for its responsiveness potential. Performance
  improvement remains an unverified hypothesis.

## Required contract

- A reusable container runs at most one application operation at a time.
  Different containers provide independent capacity for healthy siblings.
- Every operation starts a fresh operating-system process with a fresh runtime
  heap and module state. Re-entering a function or recycling a Bun realm does
  not satisfy this requirement.
- Application code evaluates only after all application threads have irreversible
  restrictions, unrelated descriptors are closed, actual descriptor/thread
  inventories pass independent inspection, and its deadline watcher is armed.
- Application processes receive no Docker socket, credentials, writable host
  mount, ambient network, launcher control channel or arbitrary dispatcher.
  The approved application surface and server-only secret boundaries remain.
- Preserve the one-CPU, 512-MiB, 64-PID resource ceilings. Trusted-container
  overhead must be accounted for explicitly. Do not present cumulative container
  counters as per-operation measurements. A container may be reused only after
  the previous operation's processes and descendants are physically absent.
- Each deadline watcher binds one immutable operation identity, container
  identity, boot identity, process start identity and pidfd. No command extends
  an armed deadline or selects another target. Controller loss must not disarm
  the watcher. Preserve the existing five-second operation deadline and
  250-ms physical-exit tolerance, including applicable queueing and scheduling.
- Cancellation affects only its owned operation. Verify application process-tree
  retirement and the absence of unintended residual resources before reuse.
  Any uncertain ownership, admission, retirement or cleanup quarantines the
  entire container, denies further admission and retains durable recovery
  evidence. Quarantine is a terminal availability state until verified recovery.
- Validate operation output and verify physical retirement before mutation
  commit. Database authority stays in the trusted broker. Lost commit
  acknowledgement remains outcome-unknown; recovery never replays a mutation.
- Shutdown first closes admission and creation authority, then drains for the
  existing 30-second bound, verifies owned cleanup and reports uncertainty.
- Preserve all approved platform, repeat, isolation, resource, deadline, disposal
  and freshness gates. No ordinary release path adopts this candidate until its
  native evidence passes independently of protocol mocks.

## Implementation plan

1. Add an isolated retained-container candidate under
   `experiments/native-reuse/`. Reuse immutable build inputs and the existing
   restriction bootstrap; introduce no package or application API dependency.
   Do not change ordinary setup admission or relax existing native profiles.
2. Measure preparation, process launch, restriction/audit, guard arming,
   application execution, retirement, cleanup, commit and browser publication
   separately using monotonic operation identifiers. Report cold setup separately
   from warm work without subtracting required in-operation work.
3. Put ownership, preparation, scheduling, cancellation, quarantine and recovery
   behind one native execution interface beneath `ReadApplication`. The initial
   candidate exposes execution and verified close; application callers do not
   acquire reusable container handles or decide when reuse is safe.
4. Extend proofs currently in `src/runtime/native/host.ts`, `controller.py`,
   `worker_deadline.py`, `lease.ts`, `configuration.py`, `threads.py` and
   `descriptor_audit.py` for an application process that is not container init.
   Keep one-shot guard bindings; durable records distinguish retained container
   ownership from each operation's identity and creation intent.
5. After the candidate passes native gates, replace the prepared one-shot worker
   experiment in `application.ts` with the execution module. Keep transaction
   and public-schema validation in the application/broker layers. Update
   `docs/reactivity.md` and native lifecycle documentation to match final behavior.

## Implementation record

The candidate was developed as `src/runtime/native/execution.ts` and qualified by
`tests/runtime/retained-execution.integration.test.ts` before `ReadApplication`
adopted it, rather than under `experiments/`. Slot ownership lives in
`retained_controller.py`, `retained_guard.py`, `docker_api.py` and
`retained-lease.ts`; one-shot registration and migration-declaration workers keep
the original path. Operations report launch, audit, guard, execute, retire and
total phase timings. Warm processes are exec'd into the retained container
through the Docker Engine API. Retirement requires the guard's pidfd exit plus a
container cgroup holding only the idle init.

## Verification gates

- [ ] Repeated operations use one owned container and distinct application
  process/start identities; application heap/module mutations do not carry over.
- [ ] Existing syscall, inherited-descriptor, thread, environment, mount,
  network and resource negative controls pass before every application entry.
- [ ] Busy, oversized, malformed and cancelled operations cannot stall or kill
  healthy operations in sibling containers.
- [ ] Controller loss, guard loss, delayed creation, PID reuse, startup failure,
  shutdown races and incomplete retirement cannot lead to unsafe reuse.
- [ ] No application processes, descendants, unapproved descriptors or writable
  application state survive across operations; uncertainty quarantines capacity.
- [ ] Real disposable PostgreSQL tests retain rollback, version conflict,
  connection reuse safety and committed-versus-unknown outcome behavior.
- [ ] Real two-view browser tests pass unchanged freshness, state, focus,
  draft, reconnect and maintenance assertions with required repeats.
- [ ] All applicable native platform, types, lint, production build and CI
  checks pass; an independent reviewer challenges isolation and recovery.

## Consequences and non-goals

Retained containers require more lifecycle states and more extensive recovery
proofs. The execution module must expose useful operation identities, timings,
resource attribution and safe failure evidence without exposing secrets.

This decision does not authorize shared application heaps, concurrent operations
inside one retained application container, broader application capabilities,
changed budgets, new dependencies, weaker cleanup, auth or hosted deployment.
Revisit the design if it cannot meet responsiveness and isolation together at the
approved limits. Keep PR #54 unmerged and #30 open until qualification succeeds.

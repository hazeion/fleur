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

The outer native driver and artifact loader remain under implementation/review.
Do not treat preparation, unit fixtures or the earlier capability preflight as
full Desktop runtime qualification or readiness admission.

# Pre-application TSYNC feasibility experiment

This is an issue #23 compatibility probe, not Fleur runtime code. A pass establishes only this small Bun/Preact fixture under this filter. It cannot close the runtime isolation gate.

Run on a disposable Ubuntu 24.04 Linux amd64 Docker runner:

```sh
python3 -m unittest discover -s experiments/compatibility/runtime-probe -p 'test_*.py'
python3 experiments/compatibility/runtime-probe/run.py > runtime-probe-report.json
```

The driver requires the existing runner's GCC 13.3.0 and refuses other versions. It installs nothing on the host. Evidence records the executed compiler version and binary SHA-256, helper SHA-256, host OS/kernel/Docker versions, immutable base manifest and built image ID. This is an experiment compiler candidate, not a verified release compiler or immutable runner image. Compilation uses `-shared -fPIC -O2 -std=c11 -Wall -Wextra -Werror -pthread`. The build uses the rendering experiment's existing frozen Bun lockfile with Preact 11.0.1 and preact-render-to-string 6.8.0. It asserts Bun 1.4.3 in trusted preparation.

Image preparation may download the pinned official Bun manifest and frozen dependencies. Execution uses the resulting image ID with `--pull=never`. No host mounts, Docker socket, credentials, secret environment, capabilities or network are supplied. Execution has a readonly root, UID/GID 65534, one CPU, 512 MiB memory with swap disabled, 64 PIDs, disabled core dumps, no-new-privileges and a 30-second external timeout. The driver attempts removal of owned containers/images and removes its host build context. The JSON report records each cleanup outcome and fails if removal is incomplete. Resources never attempted are reported as never-created. An unfinished build command may leave Docker daemon work pending; removing the current image tag cannot prove cancellation, so that state also prevents successful completion.

Docker's default syscall filter is explicitly disabled for this experiment. Its presence could disguise missing native enforcement. The helper installs its own deny-by-default filter with `SECCOMP_FILTER_FLAG_TSYNC`, permitting memory, timing, synchronization and signal machinery, exit/close, stdin read and stdout/stderr writes. Unknown syscalls, x32 syscall numbers and alternate filesystem/network/process authority paths receive EPERM. Wrong audit architecture kills the process. Every nonzero installation result blocks application execution, including a positive unsynchronizable thread ID.

The trusted bootstrap imports bundled Preact code and the native helper, reads application source as inert text and warms the renderer. It creates a native witness thread and establishes that `/etc/passwd` is readable before restrictions. Only after successful TSYNC does `new Function` compile/evaluate the application fixture. Its top-level body checks direct `openat`, `open`, `unlinkat`, `socket`, `connect`, `execve`, `unshare`, `ptrace`, `setuid` and `io_uring_setup` attempts for EPERM; renders a literal expected Preact paragraph; and tries Bun's file API. The pre-existing witness thread must also receive EPERM opening the previously readable file. A runtime/filter incompatibility is an experiment failure, never permission to relax the asserted authority restrictions.

Exit zero means the complete, correctly typed bounded report passed and owned resource cleanup completed. Installation must be integer zero; boolean false and malformed JSON values cannot pass. Cleanup failures are reported using resource kinds and outcomes without raw cleanup subprocess output. Nonzero means absent prerequisites, compiler mismatch, build/runtime failure, timeout or failed evidence. Both emit a JSON report with `v1_gate_passed: false`. CI must preserve this report even on failure. The driver is bounded at 240 seconds for image build, 30 seconds for container execution, 30 seconds per metadata/build command and 15 seconds per cleanup action.

## Evidence and limits

Locally executed on macOS: the public report acceptance test failed first because the conservative placeholder rejected complete evidence. After implementing complete-report acceptance, both acceptance tests passed. Python syntax compilation passed. The driver rejected macOS with `bounded_probe_passed: false`. Native behavior required the later Linux runs below.

This does not establish broker operations, database-proxy transactions, runtime module/import closure, inherited descriptor inventory/closure, hostile application FFI access, every existing Bun thread's behavior, long-lived async/JIT workload, future thread creation, CPU/memory/PID abuse, client islands or reactive refresh. TSYNC is requested for all existing threads, but this fixture directly witnesses only one pre-existing native thread. New process/thread creation is denied rather than claiming support for restricted future threads. Remaining tests and independent review are required before relying on the architecture. Unsupported platforms remain unresolved.

Independent review fixes: cleanup failure and malformed-report regressions were demonstrated red. After enforcing typed fields and confirmed cleanup, all three report acceptance tests passed. The macOS rejection now reports both resources as never-created with cleanup complete.

## Executed Linux evidence

On October 13, 2026, the [PR run](https://github.com/hazeion/fleur/actions/runs/38428505562) and [push run](https://github.com/hazeion/fleur/actions/runs/38428497621) executed commit `6b74e2a` on Ubuntu 24.04 x86_64, kernel `6.17.0-1022-azure`. Both bounded probes passed. Their reports contained integer-zero installation status, ten integer `-1` native controls, `<p>restricted render</p>`, denied Bun file access and integer `-1` from the pre-existing thread witness. Both owned containers and images were removed, with cleanup complete and `v1_gate_passed: false`.

The executed compiler was GCC `13.3.0-6ubuntu2~24.04.1`; its binary SHA-256 was `1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26`. The compiled helper SHA-256 was `e3c17415630f6f665a115240d8a592ca68ce41349750cadba2d4078e9523fd97`. The immutable Bun base manifest is recorded in the driver; per-run image IDs, Docker versions and full bounded reports are retained as CI artifacts. Generated reports are not tracked source files. These executed results establish the bounded fixture only, with all limitations above still applying.

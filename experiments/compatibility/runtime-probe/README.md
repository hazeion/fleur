# Pre-application TSYNC feasibility experiment

This is an issue #23 compatibility probe, not Fleur runtime code. A pass establishes only this small Bun/Preact fixture under this filter. It cannot close the runtime isolation gate.

Run on a disposable Ubuntu 24.04 Linux amd64 Docker runner:

```sh
python3 -m unittest discover -s experiments/compatibility/runtime-probe -p 'test_*.py'
python3 experiments/compatibility/runtime-probe/run.py > runtime-probe-report.json
```

The driver requires the existing runner's GCC 13.3.0 and refuses other versions. It installs nothing on the host. Evidence records the executed compiler version and binary SHA-256, helper SHA-256, host OS/kernel/Docker versions, immutable base manifest and built image ID. This is an experiment compiler candidate, not a verified release compiler or immutable runner image. Compilation uses `-shared -fPIC -O2 -std=c11 -Wall -Wextra -Werror -pthread`. The build uses the rendering experiment's existing frozen Bun lockfile with Preact 11.0.1 and preact-render-to-string 6.8.0. It asserts Bun 1.4.3 in trusted preparation.

Image preparation may download the pinned official Bun manifest and frozen dependencies. Execution uses the resulting image ID with `--pull=never`. No host mounts, Docker socket, credentials, secret environment, capabilities or network are supplied. Execution has a readonly root, UID/GID 65534, one CPU, 512 MiB memory with swap disabled, 64 PIDs, disabled core dumps, no-new-privileges and a 30-second external timeout. Owned containers/images and host build context are removed, including on failure.

Docker's default syscall filter is explicitly disabled for this experiment. Its presence could disguise missing native enforcement. The helper installs its own deny-by-default filter with `SECCOMP_FILTER_FLAG_TSYNC`, permitting memory, timing, synchronization and signal machinery, exit/close, stdin read and stdout/stderr writes. Unknown syscalls, x32 syscall numbers and alternate filesystem/network/process authority paths receive EPERM. Wrong audit architecture kills the process. Every nonzero installation result blocks application execution, including a positive unsynchronizable thread ID.

The trusted bootstrap imports bundled Preact code and the native helper, reads application source as inert text and warms the renderer. It creates a native witness thread and establishes that `/etc/passwd` is readable before restrictions. Only after successful TSYNC does `new Function` compile/evaluate the application fixture. Its top-level body checks direct `openat`, `open`, `unlinkat`, `socket`, `connect`, `execve`, `unshare`, `ptrace`, `setuid` and `io_uring_setup` attempts for EPERM; renders a literal expected Preact paragraph; and tries Bun's file API. The pre-existing witness thread must also receive EPERM opening the previously readable file. A runtime/filter incompatibility is an experiment failure, never permission to relax the asserted authority restrictions.

Exit zero means the complete bounded report passed. Nonzero means absent prerequisites, compiler mismatch, build/runtime failure, timeout or failed evidence. Both emit a JSON report with `v1_gate_passed: false`. CI must preserve this report even on failure. The driver is bounded at 240 seconds for image build, 30 seconds for container execution, 30 seconds per metadata/build command and 15 seconds per cleanup action.

## Evidence and limits

Locally executed on macOS: the public report acceptance test failed first because the conservative placeholder rejected complete evidence. After implementing complete-report acceptance, both acceptance tests passed. Python syntax compilation passed. The driver rejected macOS with `bounded_probe_passed: false`. Native compilation and Linux execution have not yet occurred.

This does not establish broker operations, database-proxy transactions, runtime module/import closure, inherited descriptor inventory/closure, hostile application FFI access, every existing Bun thread's behavior, long-lived async/JIT workload, future thread creation, CPU/memory/PID abuse, client islands or reactive refresh. TSYNC is requested for all existing threads, but this fixture directly witnesses only one pre-existing native thread. New process/thread creation is denied rather than claiming support for restricted future threads. Remaining tests and independent review are required before relying on the architecture. Unsupported platforms remain unresolved.

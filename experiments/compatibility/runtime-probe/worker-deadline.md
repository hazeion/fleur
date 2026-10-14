# Physical worker deadline proof

The busy-worker operation retains its original 30-second deadline. Before its
startup acknowledgment, the trusted host opens a Linux pidfd for the audited
container init process. It verifies the complete container ID in the process's
cgroup v2 membership and checks process start identity before and after opening.
An exited process or changed identity fails closed. The retained pidfd prevents a
reused numeric PID from redirecting the termination signal to another process.

At the original absolute deadline, the host guard sends SIGKILL through that
pidfd and observes its kernel exit readiness. The probe allows at most 250 ms for
signal dispatch, scheduling, and exit measurement. It never extends application
response acceptance beyond the operation deadline. Late physical termination is
a failure, even if Docker eventually reports exit 137. The evidence reports both
physical exit timing and the separate, potentially later Docker confirmation.

The deadline path launches no Docker or containerd CLI. Docker exit 137, healthy
worker success, both lifecycle repetitions, and removal of every owned container
remain independently required. A failed healthy operation closes the guard's
control pipe, promptly retiring only its already-bound busy worker. A separate
cancellation event retires the owned protocol client without waiting for the
original operation deadline. Helper reaping contributes to lifecycle cleanup.

Local tests use same-user child processes and an explicit OS boundary for pidfd
operations unavailable on macOS. They verify actual child exit, unrelated-child
survival, cancellation, late-termination rejection, exact identity binding, and
PID reuse rejection. The lifecycle fixture models the external host guard and
Docker state, while retaining its original two-second deadline assertions and
half-second late-stop rejection. Native Linux CI exercises the actual root guard
and kernel pidfds; absence of those APIs fails the native probe. These are
compatibility experiments, not a released Fleur runtime or launcher.

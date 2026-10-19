# Experimental VFS kernel network setup

The VFS experiment explicitly creates containers through Docker 28.0.4's Engine
API with `Config.NetworkDisabled=true` and `HostConfig.NetworkMode=none`.
This retains a fresh runc network namespace while avoiding libnetwork's nsfs
sandbox bind mount beneath a shared host parent. The native default-daemon
experiment keeps its existing managed `none` setup. This counterfactual changes
both storage and network setup; it cannot attribute a difference to VFS alone.

The fixed constructor admits only the immutable image and named fixture modes,
UID/GID 65534, no capabilities, no-new-privileges, read-only root, no mounts or
devices, one CPU, 512 MiB memory without swap, and 64 PIDs. It binds the retained
original staging-root descriptor, owned Unix socket identity, daemon owner token,
VFS data-root path, Docker commit and runc version. Its HTTP requests have absolute
deadlines, including slowly delivered headers and connection-close response bodies.

Empty Docker endpoint metadata is accepted only in this explicit mode, with
NetworkDisabled true, no sandbox key/ID, ports or addresses, and independent kernel
proof. The bounded privileged read-only helper binds the exact init PID to the
full container cgroup and a live pidfd, fences process start-time and namespace
identity before and after inspection, and verifies actual UID/GID, capability sets,
no-new-privileges, read-only root and cgroup limits. It reads the target process's
`/proc/PID/net` to require only loopback and no usable external route. The native
forced-live-task gate also runs two simultaneous fixtures and verifies their network
namespaces differ from each other and the host, with independently bound peer
process identity. Published proof contains fixed facts and counts, without raw IDs,
routes, process arguments or credentials.

The render, descriptor negative and concurrent busy/healthy workers retain the
existing pre-application startup and descriptor checks. Trusted resource fixtures
have an explicit optional fixed ready/acknowledgment gate so their original CPU,
memory and PID stress loops start only after host kernel audit. The gate and audit
consume the same 15-second resource budget. The original stress loops, acceptance
assertions and application operation deadline remain unchanged.

The existing forced live-task retirement, task/shim absence, zero-owned-mount,
ordinary-unmount safeguards, original-root removal and unchanged-default-daemon
checks remain mandatory. Shared-parent or unknown mount cleanup remains rejected.
Local transport/kernel-filesystem fixtures establish rejection behavior only;
actual native CI is required for kernel and cleanup acceptance.

Pinned primary sources:

- [Docker initialization and network skip](https://github.com/moby/moby/blob/6430e49a55babd9b8f4d08e70ecb2b68900770fe/daemon/container_operations.go)
- [Docker default network namespace](https://github.com/moby/moby/blob/6430e49a55babd9b8f4d08e70ecb2b68900770fe/oci/defaults.go)
- [Docker namespace overrides](https://github.com/moby/moby/blob/6430e49a55babd9b8f4d08e70ecb2b68900770fe/daemon/oci_linux.go)
- [Docker inspect endpoint and port maps](https://github.com/moby/moby/blob/6430e49a55babd9b8f4d08e70ecb2b68900770fe/daemon/inspect.go)
- [runc namespace clone flags](https://github.com/opencontainers/runc/blob/v1.5.2/libcontainer/configs/namespaces_syscall.go)

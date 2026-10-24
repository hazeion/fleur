/** Fixed trusted Linux-VM capability probe. Never run inside an application worker. */
import { readFileSync, readlinkSync } from "node:fs";
import { machine, release } from "node:os";
import { dlopen, FFIType, ptr } from "bun:ffi";

function probe() {
  if (process.platform !== "linux" || process.arch !== "x64" || machine() !== "x86_64" || process.getuid?.() !== 0 || Bun.version !== "1.4.3") throw new Error("NATIVE_LINUX_MANAGER_REQUIRED");
  const pidText = process.env.FLEUR_CONTROL_PID ?? "";
  const workerId = process.env.FLEUR_CONTROL_WORKER ?? "";
  const nonce = process.env.FLEUR_CONTROL_NONCE ?? "";
  if (!/^[1-9][0-9]{0,9}$/.test(pidText) || Number(pidText) <= 1 || Number(pidText) >= 2 ** 31 || !/^[a-f0-9]{64}$/.test(workerId)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce)) throw new Error("EXACT_OWNED_WORKER_REQUIRED");
  const workerPid = Number(pidText);
  const read = (path: string, limit: number) => {
    const value = readFileSync(path);
    if (value.length > limit) throw new Error("PROC_BOUND_EXCEEDED");
    return value.toString("utf8");
  };
  const snapshot = () => {
    const stat = read(`/proc/${workerPid}/stat`, 4096);
    const end = stat.lastIndexOf(") ");
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    if (!stat.startsWith(`${workerPid} (`) || end < 0 || !/^[1-9][0-9]{0,23}$/.test(fields[19] ?? "")) throw new Error("WORKER_START_IDENTITY_REQUIRED");
    const cgroup = read(`/proc/${workerPid}/cgroup`, 4096);
    if (![ `0::/docker/${workerId}\n`, `0::/system.slice/docker-${workerId}.scope\n` ].includes(cgroup)) throw new Error("WORKER_CGROUP_BINDING_REQUIRED");
    if (!read(`/proc/${workerPid}/cmdline`, 8192).includes(nonce)) throw new Error("WORKER_NONCE_REQUIRED");
    return { startTime: fields[19]!, cgroup, pidNamespace: readlinkSync(`/proc/${workerPid}/ns/pid`) };
  };
  const bootId = read("/proc/sys/kernel/random/boot_id", 64).trim();
  const before = snapshot();
  const library = dlopen("libc.so.6", {
    pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
    pidfd_send_signal: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  let descriptor = -1;
  try {
    descriptor = library.symbols.pidfd_open(workerPid, 0);
    if (descriptor < 0) throw new Error("PIDFD_OPEN_REFUSED");
    const fdInfo = read(`/proc/self/fdinfo/${descriptor}`, 4096);
    const matches = [...fdInfo.matchAll(/^Pid:\s+([1-9][0-9]*)$/gm)];
    if (matches.length !== 1 || Number(matches[0]![1]) !== workerPid) throw new Error("PIDFD_IDENTITY_REQUIRED");
    if (library.symbols.pidfd_send_signal(descriptor, 0, null, 0) !== 0) throw new Error("PIDFD_SIGNAL_PERMISSION_REFUSED");
    const poll = Buffer.alloc(8); poll.writeInt32LE(descriptor); poll.writeInt16LE(1, 4);
    if (library.symbols.poll(ptr(poll), 1, 0) !== 0 || poll.readInt16LE(6) !== 0) throw new Error("LIVE_PIDFD_REQUIRED");
    const clock = new BigInt64Array(2);
    if (library.symbols.clock_gettime(1, ptr(clock)) !== 0 || clock[0]! < 0n || clock[1]! < 0n || clock[1]! >= 1000000000n) throw new Error("VM_MONOTONIC_CLOCK_REQUIRED");
    const after = snapshot();
    if (JSON.stringify(before) !== JSON.stringify(after) || read("/proc/sys/kernel/random/boot_id", 64).trim() !== bootId) throw new Error("WORKER_OR_VM_CHANGED");
    const managerPidNamespace = readlinkSync("/proc/self/ns/pid");
    const hostPidNamespace = readlinkSync("/proc/1/ns/pid");
    if (managerPidNamespace !== hostPidNamespace || managerPidNamespace === before.pidNamespace) throw new Error("HOST_PID_NAMESPACE_REQUIRED");
    if (library.symbols.close(descriptor) !== 0) throw new Error("PIDFD_CLOSE_UNCONFIRMED");
    descriptor = -1;
    return { formatVersion: 1, scope: "desktop-linux-control-capability", ok: true, runtimeAdmission: false,
      nonce, workerId, workerPid, managerPid: process.pid, kernel: release(), architecture: machine(), uid: process.getuid!(), bootId,
      vmMonotonicNs: (clock[0]! * 1000000000n + clock[1]!).toString(), custodyStable: true, worker: before,
      managerPidNamespace, hostPidNamespace, pidfd: { fdInfoPid: workerPid, signalZero: true, pollQuiet: true, closed: true } };
  } finally {
    if (descriptor >= 0) library.symbols.close(descriptor);
    library.close();
  }
}

try {
  process.stdout.write(JSON.stringify(probe()) + "\n");
  // Keep the manager live long enough for a separate Docker PID/ownership readback.
  setTimeout(() => {}, 30000);
} catch (error) {
  const code = error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : "CONTROL_CAPABILITY_UNPROVEN";
  process.stdout.write(JSON.stringify({ formatVersion: 1, scope: "desktop-linux-control-capability", ok: false, runtimeAdmission: false, error: code }) + "\n");
  process.exitCode = 4;
}

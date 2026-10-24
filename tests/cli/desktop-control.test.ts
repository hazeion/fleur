import { expect, test } from "bun:test";
import { acceptDesktopControlProbe, acceptDesktopControlContainer } from "../../scripts/observe-desktop-control.ts";

const binding = { nonce: "a1234567-1234-4234-8234-123456789abc", workerId: "a".repeat(64), workerPid: 123, managerPid: 456, kernel: "7.0.14-linuxkit" };
function complete() {
  return { formatVersion: 1, scope: "desktop-linux-control-capability", ok: true, runtimeAdmission: false,
    ...binding, architecture: "x86_64", uid: 0, bootId: "b1234567-1234-4234-8234-123456789abc", vmMonotonicNs: "123456789000", custodyStable: true,
    worker: { startTime: "12345", cgroup: `0::/docker/${binding.workerId}\n`, pidNamespace: "pid:[222]" },
    managerPidNamespace: "pid:[111]", hostPidNamespace: "pid:[111]",
    pidfd: { fdInfoPid: binding.workerPid, signalZero: true, pollQuiet: true, closed: true } };
}

test("complete native Desktop control capability evidence is scoped separately from runtime admission", () => {
  expect(acceptDesktopControlProbe(complete(), binding)).toBe(true);
  expect(complete().runtimeAdmission).toBe(false);
});

test("Desktop control refuses foreign, incomplete, coercible or uncertain Linux evidence", () => {
  const base = complete();
  const invalid = [null, [], { ...base, extra: true }, { ...base, ok: 1 }, { ...base, runtimeAdmission: true },
    { ...base, nonce: crypto.randomUUID() }, { ...base, workerId: "b".repeat(64) }, { ...base, workerPid: 124 },
    { ...base, managerPid: 457 }, { ...base, uid: 1000 }, { ...base, uid: "0" }, { ...base, architecture: "aarch64" },
    { ...base, kernel: "another-kernel" }, { ...base, vmMonotonicNs: "0" }, { ...base, vmMonotonicNs: 123 },
    { ...base, bootId: "unknown" }, { ...base, custodyStable: false },
    { ...base, worker: { ...base.worker, startTime: "0" } },
    { ...base, worker: { ...base.worker, cgroup: `0::/docker/${"b".repeat(64)}\n` } },
    { ...base, worker: { ...base.worker, pidNamespace: base.managerPidNamespace } },
    { ...base, hostPidNamespace: "pid:[333]" },
    ...["fdInfoPid", "signalZero", "pollQuiet", "closed"].map((field) => ({ ...base, pidfd: { ...base.pidfd, [field]: false } })),
    { ...base, pidfd: { ...base.pidfd, fdInfoPid: 124 } }, { ...base, worker: { ...base.worker, unexpected: true } }];
  for (const value of invalid) expect(acceptDesktopControlProbe(value, binding)).toBe(false);
  for (const field of Object.keys(base)) {
    const value: Record<string, unknown> = { ...base }; delete value[field];
    expect(acceptDesktopControlProbe(value, binding)).toBe(false);
  }
});

test("Desktop control binding must identify two distinct actual native processes", () => {
  for (const changed of [{ ...binding, workerPid: 0 }, { ...binding, managerPid: binding.workerPid }, { ...binding, workerId: "a" }, { ...binding, nonce: "arbitrary" }]) {
    expect(acceptDesktopControlProbe(complete(), changed)).toBe(false);
  }
});

function owned(kind: "manager" | "worker") {
  const expected = { name: `fleur-desktop-${kind}-${binding.nonce}`, id: "b".repeat(64), image: `sha256:${"c".repeat(64)}`, nonce: binding.nonce, kind, command: ["-e", "fixed trusted program"], environment: kind === "manager" ? [`FLEUR_CONTROL_PID=${binding.workerPid}`] : [] };
  const value = { Id: expected.id, Name: `/${expected.name}`, Image: expected.image, Mounts: [], State: { Running: true, Pid: kind === "manager" ? binding.managerPid : binding.workerPid },
    Config: { User: kind === "manager" ? "0:0" : "65534:65534", Entrypoint: ["/usr/local/bin/bun"], Cmd: expected.command, Env: ["PATH=/usr/bin:/bin", ...expected.environment], Volumes: null,
      Labels: { "dev.fleur.desktop-control-owner": expected.nonce, "dev.fleur.desktop-control-role": kind } },
    HostConfig: { Privileged: false, Binds: null, NetworkMode: "none", ReadonlyRootfs: true, PidMode: kind === "manager" ? "host" : "", CgroupnsMode: kind === "manager" ? "host" : "private",
      CapDrop: ["ALL"], CapAdd: kind === "manager" ? ["CAP_KILL", "CAP_SYS_PTRACE"] : null, Memory: kind === "manager" ? 268435456 : 536870912,
      MemorySwap: kind === "manager" ? 268435456 : 536870912, NanoCpus: 1000000000, PidsLimit: 64,
      SecurityOpt: kind === "manager" ? ["no-new-privileges", "seccomp=unconfined"] : ["no-new-privileges"] } };
  return { expected, value };
}

for (const kind of ["manager", "worker"] as const) {
  test(`Desktop ${kind} cleanup requires exact ownership, image, program and confined fixture profile`, () => {
    const { expected, value } = owned(kind);
    expect(acceptDesktopControlContainer(value, expected)).toBe(true);
    for (const changed of [
      { ...value, Id: "d".repeat(64) }, { ...value, Name: "/foreign" }, { ...value, Image: `sha256:${"d".repeat(64)}` },
      { ...value, Mounts: [{}] }, { ...value, Config: { ...value.Config, Labels: {} } },
      { ...value, Config: { ...value.Config, Cmd: ["-e", "another program"] } }, { ...value, Config: { ...value.Config, User: "another" } },
      { ...value, Config: { ...value.Config, Env: [...value.Config.Env, "FLEUR_CONTROL_UNKNOWN=1"] } },
      ...["Privileged", "ReadonlyRootfs", "PidMode", "CgroupnsMode", "Memory", "MemorySwap", "NanoCpus", "PidsLimit", "CapAdd", "CapDrop", "SecurityOpt", "Binds"].map((key) => ({ ...value, HostConfig: { ...value.HostConfig, [key]: "unknown" } }))
    ]) expect(acceptDesktopControlContainer(changed, expected)).toBe(false);
  });
}

test("Desktop host-PID manager recognizes the exact observed SELinux disable option only", () => {
  const { expected, value } = owned("manager");
  const withSecurity = (SecurityOpt: string[]) => ({ ...value, HostConfig: { ...value.HostConfig, SecurityOpt } });
  expect(acceptDesktopControlContainer(withSecurity(["no-new-privileges:true", "seccomp=unconfined", "label=disable"]), expected)).toBe(true);
  for (const options of [
    ["no-new-privileges:true", "seccomp=unconfined", "label=disable", "label=disable"],
    ["no-new-privileges:true", "seccomp=unconfined", "label=disable", "apparmor=unconfined"],
    ["no-new-privileges:true", "seccomp=unconfined", "label=unknown"],
    ["seccomp=unconfined", "label=disable"],
    ["no-new-privileges:true", "label=disable"],
  ]) expect(acceptDesktopControlContainer(withSecurity(options), expected)).toBe(false);
  const worker = owned("worker");
  expect(acceptDesktopControlContainer({ ...worker.value, HostConfig: { ...worker.value.HostConfig, SecurityOpt: ["no-new-privileges:true", "label=disable"] } }, worker.expected)).toBe(false);
});

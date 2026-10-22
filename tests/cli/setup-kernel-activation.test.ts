import { expect, test } from "bun:test";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands, type HostCommandResult } from "../../src/setup/commands.ts";
import { diagnosticTape, kernelTape, diagnosticRecord, diagnosticDone } from "./fixtures/unix-diag.ts";

interface KernelScenarioOptions {
  readonly tape?: Awaited<ReturnType<typeof diagnosticTape>>;
  readonly second?: readonly Buffer[];
  readonly noCapability?: boolean;
  readonly closeFailure?: boolean;
  readonly respond?: (args: readonly string[], occurrence: number) => HostCommandResult | undefined;
}
async function kernelScenario(options: KernelScenarioOptions = {}) {
  const tape = options.tape ?? await diagnosticTape(); const calls: string[][] = []; const channels: ReturnType<typeof kernelTape>[] = [];
  const done = (stdout: string, exitCode = 0, stderr = ""): HostCommandResult => ({ status: "completed", exitCode, stdout, stderr });
  const host = {
    host: async () => ({ system: "linux", architecture: "x64", translated: false, distribution: "ubuntu", release: "24.04", machineId: "a".repeat(64) }),
    unixSocketSnapshot: async (timeout: number) => {
      const { collectUnixSocketSnapshot } = await import("../../src/setup/unix-diag.ts");
      const channel = kernelTape(channels.length && options.second ? options.second : tape.datagrams); channels.push(channel);
      return collectUnixSocketSnapshot(async () => ({ ...channel, close: () => { channel.close(); if (options.closeFailure) throw new Error("Unconfirmed close"); } }), timeout);
    },
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const override = options.respond?.(args, calls.filter((call) => JSON.stringify(call) === JSON.stringify(args)).length);
      if (override) return override;
      if (args[0] === "docker") {
        if (args[1] === "--version") return done("Docker version29.9.1");
        if (args[1] === "context") return args[2] === "show" ? done("default") : done('{"Host":"unix:///run/docker.sock"}');
        if (args.includes("info")) return done('{"ServerVersion":"29.9.1","OSType":"linux","Architecture":"amd64"}');
        if (args.includes("compose")) return done("5.6.0");
        if (args.includes("image")) return done("", 1, "No image");
      }
      if (args[0] === "/usr/bin/stat") return args.at(-1) === "/run/docker.sock" ? done(tape.selected + "|socket\n") : done("", 1, `/usr/bin/stat: cannot statx '${tape.path}': Permission denied\n`);
      if (args.includes("list-units")) return done("guarded.socket loaded active listening Guarded\n");
      if (args.at(-1) === "guarded.socket") return done(`Id=guarded.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=${tape.path} (Stream)\nTriggers=guarded.service\n`);
      throw new Error("Unexpected public kernel fixture command");
    },
  };
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(options.noCapability ? { host: host.host, run: host.run } : host) });
  return { outcome, calls, channels };
}

test("public doctor distinguishes an inaccessible unrelated listener using complete kernel wire evidence", async () => {
  const { outcome, calls, channels } = await kernelScenario();
  expect(outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" }, smoke: { state: "image-required" } } });
  expect(channels).toHaveLength(2); expect(channels.every((channel) => channel.closed === 1)).toBe(true);
  expect(calls.some((args) => args.includes("info"))).toBe(true);
  expect(calls.some((args) => args[0] === "sudo" || args[0] === "/usr/bin/sudo")).toBe(false);
});


test("unconfirmed diagnostic fd cleanup cannot authorize public daemon readiness", async () => {
  const { outcome, calls, channels } = await kernelScenario({ closeFailure: true });
  expect(outcome.result.data).toMatchObject({ components: { service: { state: "activation-unknown" } } });
  expect(calls.some((args) => args.includes("info"))).toBe(false);
  expect(channels).toHaveLength(1); expect(channels[0]!.closed).toBe(1);
});

test("an unrelated rfkill character listener needs neither daemon activation nor kernel fallback", async () => {
  const result = await kernelScenario({ respond: (args) => {
    if (args.at(-1) === "guarded.socket") return { status: "completed", exitCode: 0, stdout: "Id=guarded.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=/dev/rfkill (Special)\nTriggers=guarded.service\n", stderr: "" };
    if (args.at(-1) === "/dev/rfkill") return { status: "completed", exitCode: 0, stdout: "7|2002|character special file\n", stderr: "" };
    return undefined;
  } });
  expect(result.outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" } } });
  expect(result.channels).toHaveLength(0);
});


const protectedPath = "/run/guarded/service.sock";
const syntheticTape = (records = [diagnosticRecord(protectedPath)], selected = "7|1001") => ({ path: protectedPath, selected, datagrams: [...records, diagnosticDone()] });
const commandResult = (stdout: string, exitCode = 0, stderr = ""): HostCommandResult => ({ status: "completed", exitCode, stdout, stderr });
function expectUnknown(result: Awaited<ReturnType<typeof kernelScenario>>) {
  expect(result.outcome.result.data).toMatchObject({ components: { service: { state: "activation-unknown" } } });
  expect(result.calls.some((args) => args.includes("info") || args[0] === "sudo" || args[0] === "/usr/bin/sudo")).toBe(false);
  expect(result.channels.every((channel) => channel.closed === 1)).toBe(true);
}
for (const mode of ["no-capability", "missing", "wrong-type", "timeout", "uncertain", "nonexact-error", "wide-inode"] as const) test(`public ${mode} stat evidence cannot gain kernel fallback authority`, async () => {
  const result = await kernelScenario({ tape: syntheticTape(undefined, mode === "wide-inode" ? "7|4294967296" : "7|1001"), noCapability: mode === "no-capability", respond: (args) => {
    if (args.at(-1) !== protectedPath) return undefined;
    if (mode === "missing") return commandResult("", 1, `/usr/bin/stat: cannot statx '${protectedPath}': No such file or directory\n`);
    if (mode === "wrong-type") return commandResult("7|2002|regular file\n");
    if (mode === "timeout") return { status: "timeout", stdout: "", stderr: "" };
    if (mode === "uncertain") return { ...commandResult("", 1, `/usr/bin/stat: cannot statx '${protectedPath}': Permission denied\n`), terminationUnconfirmed: true };
    if (mode === "nonexact-error") return commandResult("", 1, "some error: Permission denied\n");
    return undefined;
  } });
  expectUnknown(result); expect(result.channels).toHaveLength(0);
});
for (const mode of ["duplicate-name", "missing-name", "missing-vfs", "wrong-kind", "changed-cookie", "changed-selected", "changed-inventory", "changed-unit"] as const) test(`public ${mode} kernel observation remains unknown`, async () => {
  let records = [diagnosticRecord(protectedPath)];
  if (mode === "duplicate-name") records.push(diagnosticRecord(protectedPath, 2002, 7, 92));
  if (mode === "missing-name") records = [diagnosticRecord("/run/other.sock")];
  if (mode === "missing-vfs") { const frame = Buffer.from(records[0]!.subarray(0, records[0]!.length - 12)); frame.writeUInt32LE(frame.length); records = [frame]; }
  if (mode === "wrong-kind") records = [diagnosticRecord(protectedPath, 2002, 7, 90, 2, 7)];
  const result = await kernelScenario({ tape: syntheticTape(records), ...(mode === "changed-cookie" ? { second: [diagnosticRecord(protectedPath, 2002, 7, 92), diagnosticDone()] } : {}), respond: (args, occurrence) => {
    if (occurrence < 2) return undefined;
    if (mode === "changed-selected" && args.at(-1) === "/run/docker.sock") return commandResult("7|9999|socket\n");
    if (mode === "changed-inventory" && args.includes("list-units")) return commandResult("guarded.socket loaded active listening Guarded\nnew.socket loaded active listening New\n");
    if (mode === "changed-unit" && args.at(-1) === "guarded.socket") return commandResult(`Id=guarded.socket\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nListen=${protectedPath} (Stream)\nTriggers=guarded.service\n`);
    return undefined;
  } });
  expectUnknown(result);
});
for (const running of [false, true]) test(`a possibly matching protected binding requires a ${running ? "running" : "stopped"} target check`, async () => {
  const result = await kernelScenario({ tape: syntheticTape([diagnosticRecord(protectedPath, 1001)]), respond: (args) => args.at(-1) === "guarded.service" ? commandResult(`Id=guarded.service\nLoadState=loaded\nActiveState=${running ? "active" : "inactive"}\nSubState=${running ? "running" : "dead"}\n`) : undefined });
  expect(result.outcome.result.data).toMatchObject({ components: running ? { daemon: { state: "ready" } } : { service: { state: "activation-needed", sockets: ["guarded.socket"], triggers: ["guarded.service"] } } });
  expect(result.calls.some((args) => args.includes("info"))).toBe(running);
  expect(result.channels).toHaveLength(2);
});
test("userspace device encoding cannot turn a protected possible match into an unrelated listener", async () => {
  const result = await kernelScenario({ tape: syntheticTape([diagnosticRecord(protectedPath, 1001, 0x12345678)], `${0x45612378n}|1001`), respond: (args) => args.at(-1) === "guarded.service" ? commandResult("Id=guarded.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\n") : undefined });
  expect(result.outcome.result.data).toMatchObject({ components: { service: { state: "activation-needed" } } });
  expect(result.calls.some((args) => args.includes("info"))).toBe(false);
});
test("a matching target that changes during recheck cannot authorize daemon RPC", async () => {
  const result = await kernelScenario({ tape: syntheticTape([diagnosticRecord(protectedPath, 1001)]), respond: (args, occurrence) => args.at(-1) === "guarded.service" ? commandResult(`Id=guarded.service\nLoadState=loaded\nActiveState=${occurrence === 1 ? "active" : "inactive"}\nSubState=${occurrence === 1 ? "running" : "dead"}\n`) : undefined });
  expectUnknown(result);
});
test("a distinct protected listener does not hide a later matching alias", async () => {
  const result = await kernelScenario({ tape: syntheticTape(), respond: (args) => {
    if (args.includes("list-units")) return commandResult("guarded.socket loaded active listening Guarded\nlater.socket loaded active listening Later\n");
    if (args.at(-1) === "later.socket") return commandResult("Id=later.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=/run/alias.sock (Stream)\nTriggers=later.service\n");
    if (args.at(-1) === "/run/alias.sock") return commandResult("7|1001|socket\n");
    if (args.at(-1) === "later.service") return commandResult("Id=later.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\n");
    return undefined;
  } });
  expect(result.outcome.result.data).toMatchObject({ components: { service: { state: "activation-needed", sockets: ["later.socket"] } } });
  expect(result.calls.some((args) => args.includes("info"))).toBe(false);
});
test("accepted stream children sharing NAME and VFS do not duplicate the listening binding", async () => {
  const result = await kernelScenario({ tape: syntheticTape([diagnosticRecord(protectedPath), diagnosticRecord(protectedPath, 2002, 7, 92, 1, 1)]) });
  expect(result.outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" } } });
});
for (const state of [1, 7, 3]) test(`bound datagram kernel state ${state} is handled conservatively`, async () => {
  const result = await kernelScenario({ tape: syntheticTape([diagnosticRecord(protectedPath, 2002, 7, 90, 2, state)]), respond: (args) => args.at(-1) === "guarded.socket" ? commandResult(`Id=guarded.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=${protectedPath} (Datagram)\nTriggers=guarded.service\n`) : undefined });
  if (state === 3) expectUnknown(result);
  else expect(result.outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" } } });
});
for (const mode of ["socket", "same-inode", "inaccessible"] as const) test(`Special listener ${mode} evidence never falls back to a kernel socket dump`, async () => {
  const result = await kernelScenario({ tape: syntheticTape(), respond: (args) => {
    if (args.at(-1) === "guarded.socket") return commandResult("Id=guarded.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=/dev/rfkill (Special)\nTriggers=guarded.service\n");
    if (args.at(-1) === "/dev/rfkill") return mode === "inaccessible" ? commandResult("", 1, "/usr/bin/stat: cannot statx '/dev/rfkill': Permission denied\n") : commandResult(mode === "socket" ? "7|2002|socket\n" : "7|1001|character special file\n");
    return undefined;
  } });
  expectUnknown(result); expect(result.channels).toHaveLength(0);
});

test("a filtered kernel dump cannot authorize public daemon readiness", async () => {
  const frame = diagnosticRecord(protectedPath); frame.writeUInt16LE(0x22, 6);
  expectUnknown(await kernelScenario({ tape: syntheticTape([frame]) }));
});

for (const changing of [true, false]) test(`shared activation targets retain ${changing ? "conflicting" : "stable"} observations across aliases`, async () => {
  const result = await kernelScenario({ tape: syntheticTape([diagnosticRecord(protectedPath, 1001)]), respond: (args, occurrence) => {
    if (args.includes("list-units")) return commandResult("guarded.socket loaded active listening Guarded\nlater.socket loaded active listening Later\n");
    if (args.at(-1) === "later.socket") return commandResult("Id=later.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=/run/alias.sock (Stream)\nTriggers=guarded.service\n");
    if (args.at(-1) === "/run/alias.sock") return commandResult("7|1001|socket\n");
    if (args.at(-1) === "guarded.service") return commandResult(`Id=guarded.service\nLoadState=loaded\nActiveState=${changing && occurrence === 1 ? "inactive" : "active"}\nSubState=${changing && occurrence === 1 ? "dead" : "running"}\n`);
    return undefined;
  } });
  if (changing) expectUnknown(result);
  else expect(result.outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" } } });
});

for (const inactive of [false, true]) test(`an initially ${inactive ? "inactive" : "unrelated"} socket cannot change ownership during kernel observation`, async () => {
  const result = await kernelScenario({ tape: syntheticTape(), respond: (args, occurrence) => {
    if (args.includes("list-units")) return commandResult("other.socket loaded active listening Other\nguarded.socket loaded active listening Guarded\n");
    if (args.at(-1) === "other.socket") return commandResult(`Id=other.socket\nLoadState=loaded\nActiveState=${inactive && occurrence === 1 ? "inactive" : "active"}\nSubState=${inactive && occurrence === 1 ? "dead" : "listening"}\nListen=${occurrence === 1 ? "/run/other.sock" : "/run/docker.sock"} (Stream)\nTriggers=other.service\n`);
    if (args.at(-1) === "/run/other.sock") return commandResult("7|3333|socket\n");
    return undefined;
  } });
  expectUnknown(result);
  expect(result.calls.filter((args) => args.at(-1) === "other.socket")).toHaveLength(2);
});

test("a BOM-prefixed relative kernel NAME cannot supply identity for an absolute listener path", async () => {
  expectUnknown(await kernelScenario({ tape: syntheticTape([diagnosticRecord("\uFEFF" + protectedPath)]) }));
});

// This is a complete modeled public-Doctor host, not invented native suffix
// evidence. The FIFO metadata/EACCES spelling is from the captured guest prefix.
const cloudFifoPath = "/run/cloud-init/share/hook-hotplug-cmd";
const cloudFifoUnit = "Id=cloud-init-hotplugd.socket\nTriggers=cloud-init-hotplugd.service\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=" + cloudFifoPath + " (FIFO)\n";
test("a protected FIFO transport is excluded only after stable manager and selected-socket revalidation", async () => {
  const result = await kernelScenario({ tape: syntheticTape(undefined, "28|2676"), respond: (args) => {
    if (args.includes("list-units")) return commandResult("cloud-init-hotplugd.socket loaded active listening Cloud-init\n");
    if (args.at(-1) === "cloud-init-hotplugd.socket") return commandResult(cloudFifoUnit);
    if (args.at(-1) === cloudFifoPath) return commandResult("", 1, "stat: cannot statx '" + cloudFifoPath + "': Permission denied\n");
    return undefined;
  } });
  expect(result.outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" } } });
  expect(result.channels).toHaveLength(0);
  expect(result.calls.filter((args) => args.includes("list-units"))).toHaveLength(2);
  expect(result.calls.filter((args) => args.at(-1) === "cloud-init-hotplugd.socket")).toHaveLength(2);
  expect(result.calls.filter((args) => args.at(-1) === "/run/docker.sock")).toHaveLength(2);
  expect(result.calls.some((args) => args.at(-1) === cloudFifoPath)).toBe(true);
  expect(result.calls.filter((args) => args.includes("info"))).toHaveLength(1);
  expect(result.calls.some((args) => args[0] === "sudo" || args[0] === "/usr/bin/sudo")).toBe(false);
});

async function protectedFifoScenario(options: KernelScenarioOptions = {}) {
  return kernelScenario({ ...options, tape: options.tape ?? syntheticTape(undefined, "28|2676"), respond: (args, occurrence) => {
    const override = options.respond?.(args, occurrence);
    if (override) return override;
    if (args.includes("list-units")) return commandResult("cloud-init-hotplugd.socket loaded active listening Cloud-init\n");
    if (args.at(-1) === "cloud-init-hotplugd.socket") return commandResult(cloudFifoUnit);
    if (args.at(-1) === cloudFifoPath) return commandResult("", 1, "stat: cannot statx '" + cloudFifoPath + "': Permission denied\n");
    return undefined;
  } });
}
for (const mode of ["uncertain", "timeout", "missing", "generic", "wrong-path", "extra-error", "stdout", "exit", "socket", "regular", "same-identity"] as const) test(`protected FIFO ${mode} evidence remains unknown without RPC`, async () => {
  const result = await protectedFifoScenario({ respond: (args) => {
    if (args.at(-1) !== cloudFifoPath) return undefined;
    const denied = commandResult("", 1, "stat: cannot statx '" + cloudFifoPath + "': Permission denied\n");
    if (mode === "uncertain") return { ...denied, terminationUnconfirmed: true };
    if (mode === "timeout" || mode === "missing") return { status: mode, stdout: "", stderr: "" };
    if (mode === "generic") return commandResult("", 1, "Permission denied");
    if (mode === "wrong-path") return commandResult("", 1, "stat: cannot statx '/run/other': Permission denied\n");
    if (mode === "extra-error") return { ...denied, stderr: denied.stderr + "additional error\n" };
    if (mode === "stdout") return { ...denied, stdout: "unexpected" };
    if (mode === "exit") return { ...denied, exitCode: 2 };
    return commandResult(mode === "socket" ? "28|3000|socket\n" : mode === "regular" ? "28|3000|regular file\n" : "028|2676|fifo\n");
  } });
  expectUnknown(result); expect(result.channels).toHaveLength(0);
});
for (const mode of ["unloaded", "transitional", "missing-listen", "duplicate", "relative", "unknown-kind"] as const) test(`protected FIFO ${mode} manager metadata cannot authorize RPC`, async () => {
  expectUnknown(await protectedFifoScenario({ respond: (args) => {
    if (args.at(-1) !== "cloud-init-hotplugd.socket") return undefined;
    let metadata = cloudFifoUnit;
    if (mode === "unloaded") metadata = metadata.replace("LoadState=loaded", "LoadState=not-found");
    if (mode === "transitional") metadata = metadata.replace("ActiveState=active", "ActiveState=activating");
    if (mode === "missing-listen") metadata = metadata.replace("Listen=" + cloudFifoPath + " (FIFO)\n", "");
    if (mode === "duplicate") metadata += "ActiveState=active\n";
    if (mode === "relative") metadata = metadata.replace(cloudFifoPath, "relative-fifo");
    if (mode === "unknown-kind") metadata = metadata.replace("(FIFO)", "(Unreviewed)");
    return commandResult(metadata);
  } }));
});
for (const mode of ["selected", "selected-missing", "selected-type", "inventory", "inventory-malformed", "fifo-kind", "fifo-state", "fifo-listen", "fifo-triggers"] as const) test(`protected FIFO ${mode} drift is rejected before RPC`, async () => {
  expectUnknown(await protectedFifoScenario({ respond: (args, occurrence) => {
    if (occurrence !== 2) return undefined;
    if (args.at(-1) === "/run/docker.sock") {
      if (mode === "selected") return commandResult("28|3000|socket\n");
      if (mode === "selected-missing") return commandResult("", 1, "No such file or directory");
      if (mode === "selected-type") return commandResult("28|2676|fifo\n");
    }
    if (args.includes("list-units")) {
      if (mode === "inventory") return commandResult("cloud-init-hotplugd.socket loaded active listening Cloud-init\nother.socket loaded active listening Other\n");
      if (mode === "inventory-malformed") return commandResult("malformed\n");
    }
    if (args.at(-1) === "cloud-init-hotplugd.socket") {
      if (mode === "fifo-kind") return commandResult(cloudFifoUnit.replace("(FIFO)", "(Stream)"));
      if (mode === "fifo-state") return commandResult(cloudFifoUnit.replace("ActiveState=active", "ActiveState=inactive").replace("SubState=listening", "SubState=dead"));
      if (mode === "fifo-listen") return commandResult(cloudFifoUnit.replace(cloudFifoPath, "/run/changed.fifo"));
      if (mode === "fifo-triggers") return commandResult(cloudFifoUnit.replace("cloud-init-hotplugd.service", "changed.service"));
    }
    return undefined;
  } }));
});
test("an initially inactive unit participates in a protected FIFO revalidation bracket", async () => {
  const result = await protectedFifoScenario({ respond: (args, occurrence) => {
    if (args.includes("list-units")) return commandResult("other.socket loaded inactive dead Other\ncloud-init-hotplugd.socket loaded active listening Cloud-init\n");
    if (args.at(-1) === "other.socket") return commandResult(`Id=other.socket\nLoadState=loaded\nActiveState=${occurrence === 1 ? "inactive" : "active"}\nSubState=${occurrence === 1 ? "dead" : "listening"}\nListen=/run/other.sock (Stream)\nTriggers=other.service\n`);
    return undefined;
  } });
  expectUnknown(result);
  expect(result.calls.filter((args) => args.at(-1) === "other.socket")).toHaveLength(2);
});
for (const path of ["/run/docker.sock", "/var/run/docker.sock"]) test(`the selected pathname ${path} cannot use protected FIFO exclusion`, async () => {
  expectUnknown(await protectedFifoScenario({ respond: (args) => {
    if (args.at(-1) === "cloud-init-hotplugd.socket") return commandResult(cloudFifoUnit.replace(cloudFifoPath, path));
    if (args[0] === "/usr/bin/stat" && args.at(-1) === path && path !== "/run/docker.sock") return commandResult("", 1, "stat: cannot statx '" + path + "': Permission denied\n");
    return undefined;
  } }));
});
for (const mixed of [false, true]) test(`a protected FIFO cannot hide a ${mixed ? "mixed Listen" : "later"} UNIX alias with a stopped target`, async () => {
  const result = await protectedFifoScenario({ respond: (args) => {
    if (args.includes("list-units")) return commandResult("cloud-init-hotplugd.socket loaded active listening Cloud-init\n" + (mixed ? "" : "later.socket loaded active listening Later\n"));
    if (mixed && args.at(-1) === "cloud-init-hotplugd.socket") return commandResult(cloudFifoUnit + "Listen=/run/alias.sock (Stream)\n");
    if (args.at(-1) === "later.socket") return commandResult("Id=later.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=/run/alias.sock (Stream)\nTriggers=later.service\n");
    if (args.at(-1) === "/run/alias.sock") return commandResult("28|2676|socket\n");
    if (args.at(-1) === (mixed ? "cloud-init-hotplugd.service" : "later.service")) return commandResult(`Id=${mixed ? "cloud-init-hotplugd.service" : "later.service"}\nLoadState=loaded\nActiveState=inactive\nSubState=dead\n`);
    return undefined;
  } });
  expect(result.outcome.result.data).toMatchObject({ components: { service: { state: "activation-needed", sockets: [mixed ? "cloud-init-hotplugd.socket" : "later.socket"], triggers: [mixed ? "cloud-init-hotplugd.service" : "later.service"] } } });
  expect(result.calls.some((args) => args.includes("info") || args[0] === "sudo" || args[0] === "/usr/bin/sudo")).toBe(false);
});
for (const fail of [false, true]) test(`a protected FIFO preserves ${fail ? "uncertain" : "both"} real UNIX kernel snapshots for bare stat errors`, async () => {
  const result = await protectedFifoScenario({ closeFailure: fail, respond: (args) => {
    if (args.includes("list-units")) return commandResult("cloud-init-hotplugd.socket loaded active listening Cloud-init\nguarded.socket loaded active listening Guarded\n");
    if (args.at(-1) === protectedPath) return commandResult("", 1, "stat: cannot statx '" + protectedPath + "': Permission denied\n");
    return undefined;
  } });
  if (fail) expectUnknown(result);
  else {
    expect(result.outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" } } });
    expect(result.channels).toHaveLength(2);
  }
});

test("a protected running FIFO accepts only the exact absolute stat error spelling", async () => {
  const result = await protectedFifoScenario({ respond: (args) => {
    if (args.at(-1) === "cloud-init-hotplugd.socket") return commandResult(cloudFifoUnit.replace("SubState=listening", "SubState=running"));
    if (args.at(-1) === cloudFifoPath) return commandResult("", 1, "/usr/bin/stat: cannot statx '" + cloudFifoPath + "': Permission denied\n");
    return undefined;
  } });
  expect(result.outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" } } });
  expect(result.channels).toHaveLength(0);
});
for (const mode of ["inventory-timeout", "metadata-uncertain"] as const) test(`protected FIFO ${mode} revalidation never gains grace or RPC`, async () => {
  expectUnknown(await protectedFifoScenario({ respond: (args, occurrence) => {
    if (occurrence !== 2) return undefined;
    if (mode === "inventory-timeout" && args.includes("list-units")) return { status: "timeout", stdout: "", stderr: "" };
    if (mode === "metadata-uncertain" && args.at(-1) === "cloud-init-hotplugd.socket") return { ...commandResult(cloudFifoUnit), terminationUnconfirmed: true };
    return undefined;
  } }));
});
for (const mode of ["missing-capability", "missing-binding", "wrong-kind", "filtered", "changed-cookie"] as const) test(`protected FIFO cannot hide ${mode} UNIX kernel evidence`, async () => {
  let records = [diagnosticRecord(protectedPath)];
  if (mode === "missing-binding") records = [];
  if (mode === "wrong-kind") records = [diagnosticRecord(protectedPath, 2002, 7, 90, 2, 7)];
  if (mode === "filtered") records[0]!.writeUInt16LE(0x22, 6);
  const result = await protectedFifoScenario({ noCapability: mode === "missing-capability", tape: syntheticTape(records, "28|2676"), ...(mode === "changed-cookie" ? { second: [diagnosticRecord(protectedPath, 2002, 7, 92), diagnosticDone()] } : {}), respond: (args) => {
    if (args.includes("list-units")) return commandResult("cloud-init-hotplugd.socket loaded active listening Cloud-init\nguarded.socket loaded active listening Guarded\n");
    if (args.at(-1) === protectedPath) return commandResult("", 1, "stat: cannot statx '" + protectedPath + "': Permission denied\n");
    return undefined;
  } });
  expectUnknown(result);
});

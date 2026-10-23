import { expect, spyOn, test } from "bun:test";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands, type SetupHost, type HostCommandResult } from "../../src/setup/commands.ts";

const image = "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e";
const policy = {
  id: "darwin-15.7.7-x64-desktop-4.96.1",
  host: { system: "darwin", distribution: null, release: "15.7.7", architecture: "x64" },
  bun: "1.4.3",
  cli: { version: "29.9.2", commit: "a82e528" },
  engine: { version: "29.9.2", commit: "0367cbe", kernel: "7.0.14-linuxkit", platform: "Docker Desktop 4.96.1 (244132)", cgroupDriver: "cgroupfs", cgroupVersion: "2", operatingMode: "rootful", securityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"] },
  containerd: { version: "v2.4.2", commit: "b7a25261e029d68978bbf290df0a62fc819b3c51" },
  runc: { version: "1.5.2", commit: "v1.5.2-0-g29dd3dc2" },
  compose: "5.6.0", image,
  // Trusted test-catalog evidence, not real platform admission or native proof.
  evidence: { readinessSha256: "1".repeat(64), isolationSha256: "2".repeat(64) },
} as const;

function desktopFixture() {
  const commands: string[][] = [];
  const containers = new Map<string, { name: string; owner: string; finished: boolean }>();
  const id = "a".repeat(64);
  const imageId = "sha256:" + "b".repeat(64);
  const info = { CgroupVersion: "2", CgroupDriver: "cgroupfs", MemoryLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true, SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"], ID: "fixture-engine-identity", KernelVersion: "7.0.14-linuxkit", ServerVersion: "29.9.2", OSType: "linux", Architecture: "x86_64" };
  const server = {
    Version: "29.9.2", GitCommit: "0367cbe", KernelVersion: "7.0.14-linuxkit", Os: "linux", Arch: "amd64",
    Platform: { Name: "Docker Desktop 4.96.1 (244132)" },
    Components: [
      { Name: "Engine", Version: "29.9.2", Details: { GitCommit: "0367cbe" } },
      { Name: "containerd", Version: "v2.4.2", Details: { GitCommit: "b7a25261e029d68978bbf290df0a62fc819b3c51" } },
      { Name: "runc", Version: "1.5.2", Details: { GitCommit: "v1.5.2-0-g29dd3dc2" } },
    ],
  };
  const completed = (stdout: string): HostCommandResult => ({ status: "completed", exitCode: 0, stdout, stderr: "" });
  const host: SetupHost = {
    host: async () => ({ system: "darwin", architecture: "x64", translated: false, release: "15.7.7" }),
    environment: {},
    run: async (args) => {
      commands.push([...args]);
      const command = args.join(" ");
      if (command === "docker --version") return completed("Docker version 29.9.2, build a82e528\n");
      if (command === "docker context show") return completed("desktop-linux\n");
      if (command === "docker context inspect desktop-linux --format {{json .Endpoints.docker}}") return completed('{"Host":"unix:///tmp/fleur-qualified-desktop.sock"}');
      if (args[0] !== "docker" || args[1] !== "--host" || args[2] !== "unix:///tmp/fleur-qualified-desktop.sock") throw new Error("Only the frozen local endpoint is permitted");
      if (args[3] === "info") return completed(JSON.stringify(info));
      if (args[3] === "compose") return completed("5.6.0\n");
      if (args[3] === "version") return completed(JSON.stringify(server));
      if (args[3] === "image") return completed(JSON.stringify({ Id: imageId, RepoDigests: [image], Os: "linux", Architecture: "amd64" }));
      if (args[3] === "create") {
        containers.set(id, { name: args[args.indexOf("--name") + 1]!, owner: args[args.indexOf("--label") + 1]!.split("=")[1]!, finished: false });
        return completed(id);
      }
      const container = containers.get(id);
      if (args[3] === "inspect" && args[4] === id && container) return completed(JSON.stringify({ Id: id, Name: "/" + container.name, Image: imageId, Config: { Labels: { "dev.fleur.doctor-owner": container.owner } }, State: { Running: false, ExitCode: 0, FinishedAt: container.finished ? "2026-10-21T00:00:00Z" : "0001-01-01T00:00:00Z" } }));
      if (args[3] === "start" && args.at(-1) === id && container) { container.finished = true; return completed("fleur-doctor-smoke"); }
      if (args[3] === "rm" && args.at(-1) === id && container) { containers.delete(id); return completed(id); }
      throw new Error("Unexpected operation or unowned container");
    },
  };
  return { host, commands, containers, info, server };
}

test("doctor succeeds for an exactly qualified runtime only after owned smoke cleanup", async () => {
  const fixture = desktopFixture();
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, [], [policy]) });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.result).toMatchObject({ command: "doctor", ok: true, error: null, data: { components: { cli: { state: "ready" }, daemon: { state: "ready" }, compose: { state: "ready" }, smoke: { state: "ready", cleanup: true }, release: { state: "verified", profile: "darwin-15.7.7-x64-desktop-4.96.1" } } } });
  expect(fixture.containers.size).toBe(0);
});


test("doctor refuses runtime kernel drift on the same daemon identity after smoke", async () => {
  const fixture = desktopFixture();
  let infoReads = 0;
  const host: SetupHost = { ...fixture.host, run: async (args, timeout, context) => {
    if (args[3] === "info" && ++infoReads === 2) fixture.info.KernelVersion = "7.1.0-linuxkit";
    return fixture.host.run(args, timeout, context);
  } };
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(host, [], [policy]) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result).toMatchObject({ ok: false, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "unverified" } } } });
  expect(infoReads).toBe(2);
  expect(fixture.containers.size).toBe(0);
});

test("an architecture-image contradiction invalidates the compiled readiness catalog before qualification RPC", async () => {
  const fixture = desktopFixture();
  const contradictory = { ...policy, id: "contradictory-x64-image", image: "oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023" };
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, [], [policy, contradictory]) });
  expect(outcome.exitCode).toBe(4);
  expect(fixture.commands.some((args) => args[3] === "version")).toBe(false);
  expect(fixture.containers.size).toBe(0);
});

test("duplicate runtime components cannot qualify an otherwise matching installation", async () => {
  const fixture = desktopFixture();
  fixture.server.Components.push({ ...fixture.server.Components[1]!, Details: { ...fixture.server.Components[1]!.Details } });
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, [], [policy]) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result).toMatchObject({ ok: false, data: { components: { smoke: { cleanup: true }, release: { state: "unverified" } } } });
  expect(fixture.containers.size).toBe(0);
});

test("qualified versions never turn unconfirmed smoke cleanup into success", async () => {
  const fixture = desktopFixture();
  const host: SetupHost = { ...fixture.host, run: async (args, timeout, context) => args[3] === "rm"
    ? { status: "completed", exitCode: 1, stdout: "", stderr: "cleanup denied" }
    : fixture.host.run(args, timeout, context) };
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(host, [], [policy]) });
  expect(outcome.exitCode).toBe(5);
  expect(outcome.result).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" }, data: { components: { smoke: { cleanup: false }, release: { state: "unverified" } } } });
  expect(fixture.containers.size).toBe(1);
  expect(fixture.commands.some((args) => args[3] === "version")).toBe(false);
});

test("mutating the caller catalog after command construction cannot authorize a different build", async () => {
  const fixture = desktopFixture();
  const mutable = { ...policy, engine: { ...policy.engine, commit: String(policy.engine.commit) } };
  const handlers = setupCommands(fixture.host, [], [mutable]);
  mutable.engine.commit = "f00beef";
  fixture.server.GitCommit = "f00beef";
  fixture.server.Components[0]!.Details.GitCommit = "f00beef";
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result).toMatchObject({ ok: false, data: { components: { release: { state: "unverified" } } } });
  expect(fixture.containers.size).toBe(0);
});

test("setup reuses a qualified existing installation without confirmation or acquisition", async () => {
  const fixture = desktopFixture();
  const host: SetupHost = { ...fixture.host, interactive: true, confirmHuman: async () => { throw new Error("Ready tools require no new grant"); } };
  const outcome = await runCli(["setup"], { cwd: "/tmp", handlers: setupCommands(host, [], [policy]) });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.result).toMatchObject({ command: "setup", ok: true, error: null, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "verified", profile: "darwin-15.7.7-x64-desktop-4.96.1" } } } });
  expect(fixture.commands.some((args) => args.includes("pull") || args.includes("install"))).toBe(false);
  expect(fixture.containers.size).toBe(0);
});


test("a late authoritative version response cannot restart the doctor deadline", async () => {
  const fixture = desktopFixture();
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const host: SetupHost = { ...fixture.host, run: async (args, timeout, context) => {
      const result = await fixture.host.run(args, timeout, context);
      if (args[3] === "version") now = 1001;
      return result;
    } };
    const outcome = await runCli(["doctor", "--json", "--timeout", "1"], { cwd: "/tmp", handlers: setupCommands(host, [], [policy]) });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result).toMatchObject({ error: { code: "READINESS_TIMEOUT" }, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "unverified" } } } });
    expect(fixture.containers.size).toBe(0);
  } finally { clock.mockRestore(); }
});

test("decoding final daemon metadata still consumes the original deadline", async () => {
  const fixture = desktopFixture();
  let now = 0;
  let infoReads = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const host: SetupHost = { ...fixture.host, run: async (args, timeout, context) => {
      const result = await fixture.host.run(args, timeout, context);
      if (args[3] === "info" && ++infoReads === 2) return { ...result, get stdout() { now = 1001; return result.stdout; } };
      return result;
    } };
    const outcome = await runCli(["doctor", "--json", "--timeout", "1"], { cwd: "/tmp", handlers: setupCommands(host, [], [policy]) });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result).toMatchObject({ error: { code: "READINESS_TIMEOUT" }, data: { components: { smoke: { cleanup: true }, release: { state: "unverified" } } } });
    expect(fixture.containers.size).toBe(0);
  } finally { clock.mockRestore(); }
});


test("qualified versions cannot hide disabled daemon memory enforcement", async () => {
  const fixture = desktopFixture();
  fixture.info.MemoryLimit = false;
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, [], [policy]) });
  expect(outcome.exitCode).toBe(4);
  expect(fixture.commands.some((args) => args[3] === "version")).toBe(false);
  expect(fixture.containers.size).toBe(0);
});

test("an unqualified rootless daemon cannot inherit a rootful runtime policy", async () => {
  const fixture = desktopFixture();
  fixture.info.SecurityOptions.push("name=rootless");
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, [], [policy]) });
  expect(outcome.exitCode).toBe(4);
  expect(fixture.commands.some((args) => args[3] === "version")).toBe(false);
  expect(fixture.containers.size).toBe(0);
});

test("a separately qualified rootless runtime can match its own exact policy", async () => {
  const fixture = desktopFixture();
  fixture.info.SecurityOptions.push("name=rootless");
  const rootless = { ...policy, id: "synthetic-qualified-rootless", engine: { ...policy.engine, operatingMode: "rootless" as const, securityOptions: [...policy.engine.securityOptions, "name=rootless"] } };
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, [], [rootless]) });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { release: { state: "verified", profile: "synthetic-qualified-rootless" } } } });
  expect(fixture.containers.size).toBe(0);
});

test("nested security policy arrays are copied before command execution", async () => {
  const fixture = desktopFixture();
  const options: string[] = [...policy.engine.securityOptions];
  const mutable = { ...policy, engine: { ...policy.engine, securityOptions: options } };
  const handlers = setupCommands(fixture.host, [], [mutable]);
  options.push("name=userns");
  fixture.info.SecurityOptions.push("name=userns");
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers });
  expect(outcome.exitCode).toBe(4);
  expect(fixture.commands.some((args) => args[3] === "version")).toBe(false);
  expect(fixture.containers.size).toBe(0);
});

function ubuntuFixture(release: "24.04" | "26.04" = "24.04") {
  const kernel = release === "24.04" ? "6.8.0-147-generic" : "7.0.0-38-generic";
  const fixture = desktopFixture();
  Object.assign(fixture.info, { ServerVersion: "29.9.1", KernelVersion: kernel, CgroupDriver: "systemd", SecurityOptions: ["name=apparmor,profile=default", "name=seccomp,profile=builtin", "name=cgroupns"] });
  Object.assign(fixture.server, { Version: "29.9.1", GitCommit: "b26fb77", KernelVersion: kernel, Platform: { Name: "Docker Engine - Community" } });
  fixture.server.Components[0]!.Version = "29.9.1";
  fixture.server.Components[0]!.Details.GitCommit = "b26fb77";
  const host: SetupHost = {
    ...fixture.host,
    host: async () => ({ system: "linux", distribution: "ubuntu", architecture: "x64", translated: false, release, machineId: "c".repeat(64) }),
    run: async (args, timeout, context) => args.join(" ") === "docker --version"
      ? { status: "completed", exitCode: 0, stdout: "Docker version 29.9.1, build dfc520d", stderr: "" }
      : fixture.host.run(args, timeout, context),
  };
  return { ...fixture, host };
}

test("ordinary doctor recognizes only the source-mapped Ubuntu qualification without a profile override", async () => {
  const fixture = ubuntuFixture();
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host) });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { release: { state: "verified", profile: "ubuntu-24.04-x64-docker-29.9.1", evidence: { readinessSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2", isolationSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2" } } } } });
  expect(fixture.containers.size).toBe(0);
});


test("ordinary setup exposes the source-mapped Ubuntu plan but never installs without separate human grants", async () => {
  const { mkdtemp, rm, readdir } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-source-owned-apt-");
  const commands: string[][] = [];
  try {
    const host: SetupHost = {
      stateDirectory: directory,
      host: async () => ({ system: "linux", distribution: "ubuntu", release: "24.04", architecture: "x64", translated: false, machineId: "c".repeat(64) }),
      run: async (args) => {
        commands.push([...args]);
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "dpkg-query") return { status: "completed", exitCode: 1, stdout: "", stderr: "" };
        throw new Error("Unexpected host operation without human grants");
      },
    };
    const outcome = await runCli(["setup", "--json"], { cwd: "/tmp", handlers: setupCommands(host) });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result).toMatchObject({ error: { code: "AUTHORITY_REQUIRED" }, data: { plan: { verified: true, requiredAuthorities: ["install", "configuration", "docker-access", "service-start", "service-enable"] } } });
    expect(commands.map((args) => args[0])).toEqual(["docker", "dpkg-query"]);
    expect(await readdir(directory)).toEqual(["setup.lock"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("ordinary doctor recognizes the exact default AppArmor descriptor emitted by the recorded Engine build", async () => {
  const fixture = ubuntuFixture();
  fixture.info.SecurityOptions = ["name=apparmor,profile=default", "name=seccomp,profile=builtin", "name=cgroupns"];
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host) });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { release: { state: "verified", profile: "ubuntu-24.04-x64-docker-29.9.1" } } } });
  expect(fixture.containers.size).toBe(0);
});


for (const descriptor of ["name=apparmor", "name=apparmor,profile=unconfined", "name=apparmor,profile=docker-default", "name=apparmor,profile=/private/custom-profile"]) {
  test(`the exact Ubuntu default profile cannot admit a different AppArmor descriptor: ${descriptor}`, async () => {
    const fixture = ubuntuFixture();
    fixture.info.SecurityOptions[0] = descriptor;
    const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host) });
    expect(outcome.exitCode).toBe(4);
    expect(fixture.commands.some((args) => args[3] === "version")).toBe(false);
    expect(fixture.containers.size).toBe(0);
  });
}

test("legacy and default-profile AppArmor descriptors cannot become two distinct mechanisms in a trusted policy", async () => {
  const fixture = desktopFixture();
  const descriptors = ["name=apparmor", "name=apparmor,profile=default"];
  fixture.info.SecurityOptions.push(...descriptors);
  const duplicated = { ...policy, engine: { ...policy.engine, securityOptions: [...policy.engine.securityOptions, ...descriptors] } };
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, [], [duplicated]) });
  expect(outcome.exitCode).toBe(4);
  expect(fixture.commands.some((args) => args[3] === "version")).toBe(false);
  expect(fixture.containers.size).toBe(0);
});

test("ordinary Doctor admits the measured Ubuntu 26 x64 tuple only after smoke cleanup", async () => {
  const fixture = ubuntuFixture("26.04");
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host) });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "verified", profile: "ubuntu-26.04-x64-docker-29.9.1", evidence: { readinessSha256: "5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07", isolationSha256: "5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07" } } } } });
  expect(fixture.containers.size).toBe(0);
});
test.each(["kernel", "engine-build", "rootless", "cgroup-driver"])("Ubuntu 26 qualification refuses unmeasured %s drift", async (kind) => {
  const fixture = ubuntuFixture("26.04");
  if (kind === "kernel") { fixture.info.KernelVersion = "7.0.0-39-generic"; fixture.server.KernelVersion = "7.0.0-39-generic"; }
  if (kind === "engine-build") { fixture.server.GitCommit = "f00beef"; fixture.server.Components[0]!.Details.GitCommit = "f00beef"; }
  if (kind === "rootless") fixture.info.SecurityOptions.push("name=rootless");
  if (kind === "cgroup-driver") fixture.info.CgroupDriver = "cgroupfs";
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result).toMatchObject({ ok: false, data: { components: { release: { state: "unverified" } } } });
  expect(fixture.containers.size).toBe(0);
});
test.each(["x64", "arm64"])("ordinary Ubuntu 26 %s setup retains exact installer admission and separate grants", async (architecture) => {
  const { mkdtemp, rm, readdir } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-source-owned-resolute-");
  const commands: string[][] = [];
  try {
    const host: SetupHost = {
      stateDirectory: directory,
      host: async () => ({ system: "linux", distribution: "ubuntu", release: "26.04", architecture, translated: false, machineId: "c".repeat(64) }),
      run: async (args) => { commands.push([...args]); return args[0] === "docker" ? { status: "missing", stdout: "", stderr: "" } : { status: "completed", exitCode: 1, stdout: "", stderr: "" }; },
    };
    const outcome = await runCli(["setup", "--json"], { cwd: "/tmp", handlers: setupCommands(host) });
    expect(outcome.exitCode).toBe(3);
    if (architecture === "x64") {
      expect(outcome.result).toMatchObject({ error: { code: "AUTHORITY_REQUIRED" }, data: { plan: { verified: true, requiredAuthorities: ["install", "configuration", "docker-access", "service-start", "service-enable"] } } });
      expect(commands.map((args) => args[0])).toEqual(["docker", "dpkg-query"]);
      expect(await readdir(directory)).toEqual(["setup.lock"]);
    } else {
      expect(outcome.result).toMatchObject({ error: { code: "HUMAN_ACTION_REQUIRED" }, data: { plan: { verified: false } } });
      expect(commands).toEqual([["docker", "--version"]]);
      expect(await readdir(directory)).toEqual([]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

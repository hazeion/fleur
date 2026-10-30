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
    host: async () => ({ system: "linux", distribution: "ubuntu", architecture: "x64", translated: false, release, bootId: "11111111-1111-4111-8111-111111111111", machineId: "c".repeat(64) }),
    run: async (args, timeout, context) => args.join(" ") === "docker --version"
      ? { status: "completed", exitCode: 0, stdout: "Docker version 29.9.1, build dfc520d", stderr: "" }
      : fixture.host.run(args, timeout, context),
  };
  return { ...fixture, host };
}

function debianFixture() {
  const fixture = ubuntuFixture();
  fixture.info.KernelVersion = "6.12.113+deb13-cloud-amd64";
  fixture.server.KernelVersion = "6.12.113+deb13-cloud-amd64";
  const host: SetupHost = { ...fixture.host, host: async () => ({
    system: "linux", distribution: "debian", release: "13", architecture: "x64", translated: false,
    bootId: "11111111-1111-4111-8111-111111111111", machineId: "c".repeat(64),
  }) };
  return { ...fixture, host };
}

test("ordinary Debian Doctor uses the exact measured compiled tuple after owned smoke cleanup", async () => {
  const fixture = debianFixture();
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host) });
  expect(outcome.exitCode).toBe(0);
  const evidence = "6b4066ed5c199006695d769d07ec5d813fa8cddff1d396a089e1749d6c27231e";
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "verified", profile: "debian-13-x64-docker-29.9.1", evidence: { readinessSha256: evidence, isolationSha256: evidence } } } } });
  expect(fixture.containers.size).toBe(0);
});

test("ordinary ready Debian setup reuses the measured tuple without new authority or package work", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-debian-ready-");
  try {
    const fixture = debianFixture();
    const host: SetupHost = { ...fixture.host, stateDirectory: directory, interactive: true,
      confirmHuman: async () => { throw new Error("Ready installation requires no new grant"); } };
    const outcome = await runCli(["setup", "--json"], { cwd: directory, handlers: setupCommands(host) });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toMatchObject({ ok: true, data: { components: { release: { state: "verified", profile: "debian-13-x64-docker-29.9.1" } } } });
    expect(fixture.commands.some((args) => ["sudo", "apt-get", "dpkg", "systemctl"].includes(args[0]!) || args.includes("pull"))).toBe(false);
    expect(fixture.containers.size).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["x64", "arm64"])("ordinary Debian %s setup keeps exact dependency scope and separate human authority", async (architecture) => {
  const { mkdtemp, rm, readdir } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-debian-authority-");
  const commands: string[][] = [];
  try {
    const host: SetupHost = {
      stateDirectory: directory,
      host: async () => ({ system: "linux", distribution: "debian", release: "13", architecture, translated: false, bootId: "11111111-1111-4111-8111-111111111111", machineId: "c".repeat(64) }),
      run: async (args) => {
        commands.push([...args]);
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "dpkg-query") return { status: "completed", exitCode: 1, stdout: "nftables\t\tnot-installed\tok\n", stderr: "" };
        if (args[0] === "stat" && args.at(-1) === "/etc/nftables.conf") return { status: "completed", exitCode: 1, stdout: "", stderr: "No such file or directory" };
        if (args[0] === "find") return { status: "completed", exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "systemctl") return { status: "completed", exitCode: 0, stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\nFragmentPath=\nDropInPaths=\nTransient=no\n", stderr: "" };
        throw new Error("Package work requires separate human authority");
      },
    };
    const outcome = await runCli(["setup", "--json"], { cwd: directory, handlers: setupCommands(host) });
    expect(outcome.exitCode, JSON.stringify(outcome.result)).toBe(3);
    if (architecture === "x64") {
      expect(outcome.result).toMatchObject({ error: { code: "AUTHORITY_REQUIRED" }, data: { plan: { verified: true, requiredAuthorities: ["install", "configuration", "docker-access", "service-start", "service-enable"], target: expect.stringContaining("Debian dependencies libjansson4=2.14-2+b3, libnftables1=1.1.3-1, nftables=1.1.3-1; nftables configuration and helper state, systemd daemon-reload, ldconfig") } } });
      expect(commands.map((args) => args[0])).toEqual(["docker", "dpkg-query", "stat", "find", "systemctl"]);
      expect(await readdir(directory)).toEqual(["setup.lock"]);
    } else {
      expect(outcome.result).toMatchObject({ error: { code: "HUMAN_ACTION_REQUIRED" }, data: { plan: { verified: false } } });
      expect(commands).toEqual([["docker", "--version"]]);
      expect(await readdir(directory)).toEqual([]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["kernel", "architecture", "release", "translated", "engine-build", "containerd-build", "cgroup-driver", "cgroup-version", "rootless", "security-profile"])("Debian admission refuses unmeasured %s drift", async (kind) => {
  const fixture = debianFixture();
  const identity = { ...await fixture.host.host() };
  if (kind === "kernel") { fixture.info.KernelVersion = "6.12.114+deb13-cloud-amd64"; fixture.server.KernelVersion = fixture.info.KernelVersion; }
  if (kind === "architecture") identity.architecture = "arm64";
  if (kind === "release") identity.release = "14";
  if (kind === "translated") identity.translated = true;
  if (kind === "engine-build") { fixture.server.GitCommit = "f00beef"; fixture.server.Components[0]!.Details.GitCommit = "f00beef"; }
  if (kind === "containerd-build") fixture.server.Components[1]!.Details.GitCommit = "f00beef";
  if (kind === "cgroup-driver") fixture.info.CgroupDriver = "cgroupfs";
  if (kind === "cgroup-version") fixture.info.CgroupVersion = "1";
  if (kind === "rootless") fixture.info.SecurityOptions.push("name=rootless");
  if (kind === "security-profile") fixture.info.SecurityOptions[0] = "name=apparmor";
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({ ...fixture.host, host: async () => identity }) });
  expect(outcome.exitCode).toBe(4);
  expect(fixture.containers.size).toBe(0);
});

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
      host: async () => ({ system: "linux", distribution: "ubuntu", release: "24.04", architecture: "x64", translated: false, bootId: "11111111-1111-4111-8111-111111111111", machineId: "c".repeat(64) }),
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
      host: async () => ({ system: "linux", distribution: "ubuntu", release: "26.04", architecture, translated: false, bootId: "11111111-1111-4111-8111-111111111111", machineId: "c".repeat(64) }),
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

for (const command of ["doctor", "setup"] as const) {
  test(`an unresolved package transaction blocks otherwise-ready ${command} without RPC or new authority`, async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const directory = await mkdtemp("/tmp/fleur-pending-ready-");
    const fixture = ubuntuFixture();
    const calls: string[][] = [];
    let confirmations = 0;
    const host: SetupHost = {
      ...fixture.host, stateDirectory: directory, interactive: true,
      confirmHuman: async () => { confirmations++; return "once"; },
      run: async (args, timeout, context) => { calls.push([...args]); return fixture.host.run(args, timeout, context); },
    };
    try {
      const grants = '{"formatVersion":1,"grants":[]}\n';
      await writeFile(join(directory, "grants.json"), grants, { mode: 0o600 });
      await writeFile(join(directory, "retained-artifact"), "preserve this evidence", { mode: 0o600 });
      const baseline = await runCli(["doctor", "--json"], { cwd: directory, handlers: setupCommands(host) });
      expect(baseline.exitCode).toBe(0);
      calls.length = 0;
      const marker = JSON.stringify({ formatVersion: 1, checksum: "d".repeat(64) }) + "\n";
      await writeFile(join(directory, "apt-transaction-pending.json"), marker, { mode: 0o600 });
      const outcome = await runCli([command, "--json"], { cwd: directory, handlers: setupCommands(host) });
      expect(outcome.exitCode).toBe(5);
      expect(outcome.result).toMatchObject({ command, ok: false, error: { code: "RECOVERY_REQUIRED" } });
      expect(calls).toEqual([]);
      expect(confirmations).toBe(0);
      expect(fixture.containers.size).toBe(0);
      expect(await readFile(join(directory, "apt-transaction-pending.json"), "utf8")).toBe(marker);
      expect(await readFile(join(directory, "grants.json"), "utf8")).toBe(grants);
      expect(await readFile(join(directory, "retained-artifact"), "utf8")).toBe("preserve this evidence");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

for (const distribution of ["ubuntu", "debian", "arch"] as const) {
  for (const shape of ["malformed", "directory", "dangling-symlink"] as const) {
    test(`${distribution} preserves ${shape} package-pending state before any host command`, async () => {
      const { mkdtemp, mkdir, lstat, readFile, readlink, readdir, rm, symlink, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const directory = await mkdtemp("/tmp/fleur-unsafe-package-pending-");
      const path = join(directory, distribution === "arch" ? "arch-transaction-pending.json" : "apt-transaction-pending.json");
      let calls = 0;
      const host: SetupHost = {
        stateDirectory: directory,
        host: async () => ({ system: "linux", distribution, release: distribution === "ubuntu" ? "24.04" : distribution === "debian" ? "13" : "rolling", architecture: "x64", translated: false }),
        run: async () => { calls++; throw new Error("Pending state must prevent host commands"); },
      };
      try {
        if (shape === "malformed") await writeFile(path, "incomplete record", { mode: 0o600 });
        else if (shape === "directory") await mkdir(path);
        else await symlink("absent-record", path);
        const original = await lstat(path);
        for (const command of ["doctor", "setup"]) {
          const outcome = await runCli([command, "--json"], { cwd: directory, handlers: setupCommands(host) });
          expect(outcome.exitCode).toBe(5);
          expect(outcome.result).toMatchObject({ command, error: { code: "RECOVERY_REQUIRED" } });
        }
        expect(calls).toBe(0);
        const retained = await lstat(path);
        expect([retained.dev, retained.ino, retained.mode]).toEqual([original.dev, original.ino, original.mode]);
        if (shape === "malformed") expect(await readFile(path, "utf8")).toBe("incomplete record");
        else if (shape === "directory") expect(await readdir(path)).toEqual([]);
        else expect(await readlink(path)).toBe("absent-record");
        expect(await readdir(directory)).toEqual([path.split("/").at(-1)!]);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
}

function azureRunnerFixture(architecture: "x64" | "arm64") {
  const fixture = desktopFixture();
  const armImage = "oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023";
  Object.assign(fixture.info, { ServerVersion: "28.0.4", KernelVersion: "6.17.0-1022-azure", Architecture: architecture === "x64" ? "x86_64" : "aarch64", CgroupDriver: "systemd", SecurityOptions: ["name=apparmor", "name=cgroupns", "name=seccomp,profile=builtin"] });
  Object.assign(fixture.server, { Version: "28.0.4", GitCommit: "6430e49", KernelVersion: "6.17.0-1022-azure", Os: "linux", Arch: architecture === "x64" ? "amd64" : "arm64", Platform: { Name: "Docker Engine - Community" } });
  Object.assign(fixture.server.Components[0]!, { Version: "28.0.4", Details: { GitCommit: "6430e49" } });
  Object.assign(fixture.server.Components[1]!, { Version: "v2.4.1", Details: { GitCommit: "f2551031d7276a770f65f98c9b52e57e7dad07e8" } });
  const done = (stdout: string): HostCommandResult => ({ status: "completed", exitCode: 0, stdout, stderr: "" });
  const host: SetupHost = {
    ...fixture.host,
    stateDirectory: `/tmp/fleur-absent-runner-state-${crypto.randomUUID()}`,
    host: async () => ({ system: "linux", distribution: "ubuntu", architecture, translated: false, release: "24.04" }),
    run: async (args, timeout, context) => {
      if (args.join(" ") === "docker --version") return done("Docker version 28.0.4, build b8034c0");
      if (args[3] === "compose") return done("2.38.2");
      if (args[3] === "image" && architecture === "arm64") return done(JSON.stringify({ Id: "sha256:" + "b".repeat(64), RepoDigests: [armImage], Os: "linux", Architecture: "arm64" }));
      return fixture.host.run(args, timeout, context);
    },
  };
  return { ...fixture, host };
}

for (const architecture of ["x64", "arm64"] as const) {
  for (const command of ["doctor", "setup"] as const) {
    test(`ordinary ${command} recognizes the measured Ubuntu Azure ${architecture} readiness tuple without installing`, async () => {
      const fixture = azureRunnerFixture(architecture);
      const outcome = await runCli([command, "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host) });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.result).toMatchObject({ command, ok: true, data: { components: { release: { state: "verified", profile: `ubuntu-24.04-${architecture}-docker-28.0.4-azure`, evidence: architecture === "arm64" ? { readinessSha256: "15db2e603e2cdfccd8549aa78bcc7a1bf53a22f962012449297460608d0332e9", isolationSha256: "17e7c7a80b9bff706368f2d19ac52538a20bee6725abaf902ab97220d33c7c48" } : { readinessSha256: "2c29e92c1eba819c44f33361b8ac5ba319ae9343dc9cba4e64973b304774c7fd", isolationSha256: "a3f687541d7438b370b8c2dcbf74d2cf8c2b7a248f385257b68d31c72eba9402" } }, smoke: { state: "ready", cleanup: true } } } });
      expect(fixture.containers.size).toBe(0);
      expect(fixture.commands.some((args) => ["apt-get", "sudo"].includes(args[0]!))).toBe(false);
    });
  }
}

for (const architecture of ["x64", "arm64"] as const) {
  for (const change of ["kernel", "containerd", "rootless", "client"] as const) {
    test(`the ${architecture} runner admission refuses neighboring ${change} metadata`, async () => {
      const fixture = azureRunnerFixture(architecture);
      const baseline = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host) });
      expect(baseline.exitCode).toBe(0);
      if (change === "kernel") { fixture.info.KernelVersion = "6.17.0-1023-azure"; fixture.server.KernelVersion = "6.17.0-1023-azure"; }
      if (change === "containerd") fixture.server.Components[1]!.Details.GitCommit = "unmeasured-containerd-build";
      if (change === "rootless") fixture.info.SecurityOptions.push("name=rootless");
      const host: SetupHost = change === "client" ? { ...fixture.host, run: async (args, timeout, context) => args.join(" ") === "docker --version" ? { status: "completed", exitCode: 0, stdout: "Docker version 28.0.4, build b8034c1", stderr: "" } : fixture.host.run(args, timeout, context) } : fixture.host;
      const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(host) });
      expect(outcome.exitCode).toBe(4);
      expect(outcome.result).toMatchObject({ ok: false, data: { components: { release: { state: "unverified" }, smoke: { cleanup: true } } } });
      expect(fixture.containers.size).toBe(0);
    });
  }
}

for (const command of ["doctor", "setup"] as const) test(`ordinary ${command} admits only the independently qualified Intel Desktop tuple`, async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { readGrants } = await import("../../src/setup/grants.ts");
  const directory = await mkdtemp("/tmp/fleur-intel-ready-");
  try {
    const fixture = desktopFixture();
    const host: SetupHost = { ...fixture.host, stateDirectory: directory, interactive: true, confirmHuman: async () => { throw new Error("Ready Desktop requires no new authority"); } };
    const outcome = await runCli([command, "--json"], { cwd: directory, handlers: setupCommands(host) });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toMatchObject({ command, ok: true, error: null, data: { components: { release: { state: "verified", profile: "darwin-15.7.7-x64-desktop-4.96.1", evidence: { readinessSha256: "b2b1565746e8a1a56785db75594f38dc1f942dc28609a1e151a1c8bb10c63571", isolationSha256: "17b2fe0503493c0273806e482ed7c008c595861c646850b458880344e49b2787" } }, smoke: { state: "ready", cleanup: true } } } });
    expect(fixture.containers.size).toBe(0);
    expect(await readGrants(host)).toEqual([]);
    expect(fixture.commands.some((args) => ["sudo", "installer", "hdiutil", "codesign", "spctl", "launchctl"].includes(args[0]!) || args.includes("pull") || args.includes("install") || args.includes("use"))).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// The Intel Desktop profile is a version floor (human decision 2026-10-30): Docker components below the measured
// baseline, a different kernel flavor, host drift and isolation drift still refuse; newer Docker versions are covered above.
for (const field of ["release", "translation", "architecture", "cli", "compose", "engine", "kernel", "kernel-flavor", "containerd", "runc", "security", "cgroup"] as const) test(`compiled Intel Desktop admission refuses ${field} drift without acquisition`, async () => {
  const fixture = desktopFixture();
  let host: SetupHost = fixture.host;
  if (field === "release") host = { ...host, host: async () => ({ ...await fixture.host.host(), release: "15.7.8" }) };
  if (field === "translation") host = { ...host, host: async () => ({ ...await fixture.host.host(), translated: true }) };
  if (field === "architecture") host = { ...host, host: async () => ({ ...await fixture.host.host(), architecture: "arm64" }) };
  if (field === "kernel") fixture.info.KernelVersion = fixture.server.KernelVersion = "7.0.13-linuxkit";
  if (field === "kernel-flavor") fixture.info.KernelVersion = fixture.server.KernelVersion = "7.0.14-generic";
  if (field === "engine") { fixture.info.ServerVersion = fixture.server.Version = "29.9.1"; fixture.server.Components[0]!.Version = "29.9.1"; }
  if (field === "containerd") fixture.server.Components[1]!.Version = "v2.4.1";
  if (field === "runc") fixture.server.Components[2]!.Version = "1.5.1";
  if (field === "security") fixture.info.SecurityOptions.push("name=userns");
  if (field === "cgroup") fixture.info.CgroupDriver = "systemd";
  if (field === "cli" || field === "compose") host = { ...host, run: async (args, timeout, context) => {
    if (field === "cli" && args.join(" ") === "docker --version") return { status: "completed", exitCode: 0, stdout: "Docker version 29.9.1, build a82e528", stderr: "" };
    if (field === "compose" && args[3] === "compose") return { status: "completed", exitCode: 0, stdout: "5.5.9", stderr: "" };
    return fixture.host.run(args, timeout, context);
  } };
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(host) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.ok).toBe(false);
  expect(fixture.containers.size).toBe(0);
  expect(fixture.commands.some((args) => args.includes("pull") || args.includes("install") || args.includes("use"))).toBe(false);
});

test("compiled Intel Desktop policy retains exact Bun version admission", async () => {
  const { nativeReadinessProfiles, readinessCandidates } = await import("../../src/setup/readiness.ts");
  const fixture = desktopFixture();
  const identity = await fixture.host.host();
  const candidates = (bun: string) => readinessCandidates(nativeReadinessProfiles, identity, bun, "Docker version 29.9.2, build a82e528", "5.6.0", image, fixture.info);
  expect(candidates("1.4.3").map((candidate) => candidate.id)).toEqual(["darwin-15.7.7-x64-desktop-4.96.1"]);
  expect(candidates("1.4.4")).toEqual([]);
});

// Human decision 2026-10-30: Intel macOS admits Docker Desktop at or above the measured 4.96.1 baseline rather than one exact build.
function newerDesktopFixture() {
  const fixture = desktopFixture();
  fixture.info.ServerVersion = "29.9.3";
  fixture.info.KernelVersion = "7.0.15-linuxkit";
  fixture.server.Version = "29.9.3";
  fixture.server.GitCommit = "1111111";
  fixture.server.KernelVersion = "7.0.15-linuxkit";
  fixture.server.Platform = { Name: "Docker Desktop 4.97.0 (244584)" };
  fixture.server.Components = [
    { Name: "Engine", Version: "29.9.3", Details: { GitCommit: "1111111" } },
    { Name: "containerd", Version: "v2.4.3", Details: { GitCommit: "2222222222222222222222222222222222222222" } },
    { Name: "runc", Version: "1.5.3", Details: { GitCommit: "v1.5.3-0-g3333333" } },
  ];
  const run = fixture.host.run;
  const host: SetupHost = { ...fixture.host, run: async (args, timeout, context) => {
    if (args.join(" ") === "docker --version") return { status: "completed", exitCode: 0, stdout: "Docker version 29.9.3, build 4444444\n", stderr: "" };
    if (args[3] === "compose") return { status: "completed", exitCode: 0, stdout: "5.6.1\n", stderr: "" };
    return run(args, timeout, context);
  } };
  return { ...fixture, host };
}

test("compiled Intel Desktop policy admits a newer Docker Desktop, Engine, Compose, containerd, runc and linuxkit kernel", async () => {
  const fixture = newerDesktopFixture();
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, []) });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.result).toMatchObject({ command: "doctor", ok: true, error: null, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "verified", profile: "darwin-15.7.7-x64-desktop-4.96.1" } } } });
  expect(fixture.containers.size).toBe(0);
});

test("compiled Intel Desktop policy still refuses Docker components below the measured baseline", async () => {
  const { nativeReadinessProfiles, readinessCandidates, matchReadinessServer } = await import("../../src/setup/readiness.ts");
  const fixture = newerDesktopFixture();
  const identity = await fixture.host.host();
  const candidates = (cli: string, compose: string, info: typeof fixture.info) => readinessCandidates(nativeReadinessProfiles, identity, "1.4.3", cli, compose, image, info).map((candidate) => candidate.id);
  expect(candidates("Docker version 29.9.3, build 4444444", "5.6.1", fixture.info)).toEqual(["darwin-15.7.7-x64-desktop-4.96.1"]);
  expect(candidates("Docker version 29.9.1, build 4444444", "5.6.1", fixture.info)).toEqual([]);
  expect(candidates("Docker version 29.9.3, build 4444444", "5.5.9", fixture.info)).toEqual([]);
  expect(candidates("Docker version 29.9.3, build 4444444", "5.6.1", { ...fixture.info, ServerVersion: "29.9.1" })).toEqual([]);
  expect(candidates("Docker version 29.9.3, build 4444444", "5.6.1", { ...fixture.info, KernelVersion: "7.0.13-linuxkit" })).toEqual([]);
  expect(candidates("Docker version 29.9.3, build 4444444", "5.6.1", { ...fixture.info, KernelVersion: "7.0.15-generic" })).toEqual([]);
  expect(candidates("Docker version 29.9.3, build 4444444", "5.6.1", { ...fixture.info, SecurityOptions: ["name=seccomp,profile=builtin"] })).toEqual([]);
  const profiles = nativeReadinessProfiles.filter((profile) => profile.id === "darwin-15.7.7-x64-desktop-4.96.1");
  expect(matchReadinessServer(profiles, identity, fixture.server)?.id).toBe("darwin-15.7.7-x64-desktop-4.96.1");
  expect(matchReadinessServer(profiles, identity, { ...fixture.server, Platform: { Name: "Docker Desktop 4.95.9 (244000)" } })).toBeUndefined();
  expect(matchReadinessServer(profiles, identity, { ...fixture.server, Platform: { Name: "Docker Engine - Community" } })).toBeUndefined();
  expect(matchReadinessServer(profiles, identity, { ...fixture.server, Components: fixture.server.Components.map((row) => row.Name === "runc" ? { ...row, Version: "1.5.1" } : row) })).toBeUndefined();
  expect(matchReadinessServer(profiles, identity, { ...fixture.server, Components: fixture.server.Components.map((row) => row.Name === "containerd" ? { ...row, Version: "v2.4.1" } : row) })).toBeUndefined();
});

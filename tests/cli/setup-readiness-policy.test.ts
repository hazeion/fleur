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
      if (args[0] === process.execPath && args[1] === "--revision") return completed(`${Bun.version}+38afee6c8\n`);
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
  expect(outcome.result).toMatchObject({ command: "doctor", ok: true, error: null, data: { components: { cli: { state: "ready" }, daemon: { state: "ready" }, compose: { state: "ready" }, smoke: { state: "ready", cleanup: true }, release: { state: "verified", floor: "darwin-x64-desktop", admission: "measured", measuredRows: ["darwin-15.7.7-x64-desktop-4.96.1"] } } } });
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

test("mutating the caller catalog after command construction cannot authorize a different Docker product", async () => {
  const fixture = desktopFixture();
  const mutable = { ...policy, engine: { ...policy.engine, platform: String(policy.engine.platform) } };
  const handlers = setupCommands(fixture.host, [], [mutable]);
  mutable.engine.platform = "Docker Engine - Community";
  fixture.server.Platform = { Name: "Docker Engine - Community" };
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
  expect(outcome.result).toMatchObject({ command: "setup", ok: true, error: null, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "verified", floor: "darwin-x64-desktop", admission: "measured", measuredRows: ["darwin-15.7.7-x64-desktop-4.96.1"] } } } });
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
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { release: { state: "verified", floor: "darwin-x64-desktop", admission: "measured", measuredRows: ["synthetic-qualified-rootless"] } } } });
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
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "verified", floor: "debian-x64-engine", admission: "measured", measuredRows: ["debian-13-x64-docker-29.9.1"], evidence: { readinessSha256: evidence, isolationSha256: evidence } } } } });
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
    expect(outcome.result).toMatchObject({ ok: true, data: { components: { release: { state: "verified", floor: "debian-x64-engine", measuredRows: ["debian-13-x64-docker-29.9.1"] } } } });
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

// Version floors (#137): a kernel, release, Engine or containerd below the Debian floor refuses as older; identity drift still refuses.
test.each(["kernel", "kernel-flavour", "architecture", "release", "release-unparseable", "translated", "engine-version", "containerd-version", "cgroup-driver", "cgroup-version", "rootless", "security-profile"])("Debian admission refuses %s drift below or outside the measured floor", async (kind) => {
  const fixture = debianFixture();
  const identity = { ...await fixture.host.host() };
  if (kind === "kernel") { fixture.info.KernelVersion = "6.12.112+deb13-cloud-amd64"; fixture.server.KernelVersion = fixture.info.KernelVersion; }
  if (kind === "kernel-flavour") { fixture.info.KernelVersion = "6.12.113+deb13-amd64"; fixture.server.KernelVersion = fixture.info.KernelVersion; }
  if (kind === "architecture") identity.architecture = "arm64";
  if (kind === "release") identity.release = "12";
  if (kind === "release-unparseable") identity.release = "rolling";
  if (kind === "translated") identity.translated = true;
  if (kind === "engine-version") { fixture.info.ServerVersion = fixture.server.Version = "29.9.0"; fixture.server.Components[0]!.Version = "29.9.0"; }
  if (kind === "containerd-version") fixture.server.Components[1]!.Version = "v2.4.1";
  if (kind === "cgroup-driver") fixture.info.CgroupDriver = "cgroupfs";
  if (kind === "cgroup-version") fixture.info.CgroupVersion = "1";
  if (kind === "rootless") fixture.info.SecurityOptions.push("name=rootless");
  if (kind === "security-profile") fixture.info.SecurityOptions[0] = "name=apparmor";
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({ ...fixture.host, host: async () => identity }) });
  expect(outcome.exitCode).toBe(4);
  expect(fixture.containers.size).toBe(0);
});

// Debian point releases keep VERSION_ID 13; a newer kernel ABI serial is admitted above the measured row.
test("ordinary Debian Doctor admits a newer kernel ABI serial above the Debian 13 floor", async () => {
  const fixture = debianFixture();
  fixture.info.KernelVersion = fixture.server.KernelVersion = "6.12.120+deb13.1-cloud-amd64";
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host) });
  expect(outcome.exitCode, JSON.stringify(outcome.result)).toBe(0);
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "verified", floor: "debian-x64-engine", admission: "above-floor", measuredRows: ["debian-13-x64-docker-29.9.1"] } } } });
  expect(fixture.containers.size).toBe(0);
});

test("ordinary doctor recognizes only the source-mapped Ubuntu qualification without a profile override", async () => {
  const fixture = ubuntuFixture();
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host) });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { release: { state: "verified", floor: "ubuntu-x64-engine", admission: "measured", measuredRows: ["ubuntu-24.04-x64-docker-29.9.1", "ubuntu-26.04-x64-docker-29.9.1"], evidence: { readinessSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2", isolationSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2" } } } } });
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
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { release: { state: "verified", floor: "ubuntu-x64-engine", measuredRows: ["ubuntu-24.04-x64-docker-29.9.1", "ubuntu-26.04-x64-docker-29.9.1"] } } } });
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
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "verified", floor: "ubuntu-x64-engine", admission: "measured", measuredRows: ["ubuntu-24.04-x64-docker-29.9.1", "ubuntu-26.04-x64-docker-29.9.1"], evidence: { readinessSha256: "5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07", isolationSha256: "5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07" } } } } });
  expect(fixture.containers.size).toBe(0);
});
test.each(["kernel", "engine-version", "rootless", "cgroup-driver"])("Ubuntu 26 qualification refuses %s drift below or outside the measured floor", async (kind) => {
  const fixture = ubuntuFixture("26.04");
  // The target floor is the 24.04 row's 6.8.0-147-generic; a 26.04 host with an older 7.0.0 ABI is still above it (#127).
  if (kind === "kernel") { fixture.info.KernelVersion = "6.8.0-146-generic"; fixture.server.KernelVersion = "6.8.0-146-generic"; }
  if (kind === "engine-version") { fixture.info.ServerVersion = fixture.server.Version = "29.9.0"; fixture.server.Components[0]!.Version = "29.9.0"; }
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
      expect(outcome.result).toMatchObject({ command, ok: true, data: { components: { release: { state: "verified", floor: `ubuntu-${architecture}-engine-azure`, admission: "measured", measuredRows: [`ubuntu-24.04-${architecture}-docker-28.0.4-azure`], evidence: architecture === "arm64" ? { readinessSha256: "15db2e603e2cdfccd8549aa78bcc7a1bf53a22f962012449297460608d0332e9", isolationSha256: "17e7c7a80b9bff706368f2d19ac52538a20bee6725abaf902ab97220d33c7c48" } : { readinessSha256: "2c29e92c1eba819c44f33361b8ac5ba319ae9343dc9cba4e64973b304774c7fd", isolationSha256: "a3f687541d7438b370b8c2dcbf74d2cf8c2b7a248f385257b68d31c72eba9402" } }, smoke: { state: "ready", cleanup: true } } } });
      expect(fixture.containers.size).toBe(0);
      expect(fixture.commands.some((args) => ["apt-get", "sudo"].includes(args[0]!))).toBe(false);
    });
  }
}

// GitHub-hosted runner profiles are version floors (#118): older components, a
// different kernel flavor and isolation drift refuse; newer components admit.
for (const architecture of ["x64", "arm64"] as const) {
  for (const change of ["kernel", "kernel-flavor", "containerd", "rootless", "client"] as const) {
    test(`the ${architecture} runner admission refuses ${change} drift below or outside the measured floor`, async () => {
      const fixture = azureRunnerFixture(architecture);
      const baseline = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host) });
      expect(baseline.exitCode).toBe(0);
      if (change === "kernel") { fixture.info.KernelVersion = "6.17.0-1021-azure"; fixture.server.KernelVersion = "6.17.0-1021-azure"; }
      if (change === "kernel-flavor") { fixture.info.KernelVersion = "6.17.0-1022-generic"; fixture.server.KernelVersion = "6.17.0-1022-generic"; }
      if (change === "containerd") fixture.server.Components[1]!.Version = "v2.4.0";
      if (change === "rootless") fixture.info.SecurityOptions.push("name=rootless");
      const host: SetupHost = change === "client" ? { ...fixture.host, run: async (args, timeout, context) => args.join(" ") === "docker --version" ? { status: "completed", exitCode: 0, stdout: "Docker version 28.0.3, build b8034c1", stderr: "" } : fixture.host.run(args, timeout, context) } : fixture.host;
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
    expect(outcome.result).toMatchObject({ command, ok: true, error: null, data: { components: { release: { state: "verified", floor: "darwin-x64-desktop", admission: "measured", measuredRows: ["darwin-15.7.7-x64-desktop-4.96.1"], evidence: { readinessSha256: "b2b1565746e8a1a56785db75594f38dc1f942dc28609a1e151a1c8bb10c63571", isolationSha256: "17b2fe0503493c0273806e482ed7c008c595861c646850b458880344e49b2787" } }, smoke: { state: "ready", cleanup: true } } } });
    expect(fixture.containers.size).toBe(0);
    expect(await readGrants(host)).toEqual([]);
    expect(fixture.commands.some((args) => ["sudo", "installer", "hdiutil", "codesign", "spctl", "launchctl"].includes(args[0]!) || args.includes("pull") || args.includes("install") || args.includes("use"))).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// The Intel Desktop profile is a version floor (human decision 2026-10-30): Docker components below the measured
// baseline, a different kernel flavor, host drift and isolation drift still refuse; newer Docker versions are covered above.
for (const field of ["release", "translation", "architecture", "cli", "compose", "engine", "kernel", "kernel-flavor", "containerd", "runc", "security", "cgroup"] as const) test(`compiled Intel Desktop admission refuses ${field} drift below or outside the floor without acquisition`, async () => {
  const fixture = desktopFixture();
  let host: SetupHost = fixture.host;
  if (field === "release") host = { ...host, host: async () => ({ ...await fixture.host.host(), release: "15.7.6" }) };
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

test("compiled Intel Desktop policy admits Bun at or above the floor and refuses an older Bun as older", async () => {
  const { nativeReadinessProfiles, readinessCandidates, compareReadiness } = await import("../../src/setup/readiness.ts");
  const fixture = desktopFixture();
  const identity = await fixture.host.host();
  const candidates = (bun: string) => readinessCandidates(nativeReadinessProfiles, identity, bun, "Docker version 29.9.2, build a82e528", "5.6.0", image, fixture.info);
  expect(candidates("1.4.3").map((candidate) => candidate.id)).toEqual(["darwin-15.7.7-x64-desktop-4.96.1"]);
  expect(candidates("1.4.4").map((candidate) => candidate.id)).toEqual(["darwin-15.7.7-x64-desktop-4.96.1"]);
  expect(candidates("1.4.2")).toEqual([]);
  const refused = compareReadiness(nativeReadinessProfiles, { ...await observe(fixture), bun: "1.4.2" });
  expect(refused).toMatchObject({ state: "unverified", admission: null, floor: "darwin-x64-desktop", blocking: { tool: "bun", floor: "1.4.3", detected: "1.4.2", comparison: "older" } });
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
  expect(outcome.result).toMatchObject({ command: "doctor", ok: true, error: null, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "verified", floor: "darwin-x64-desktop", admission: "above-floor", measuredRows: ["darwin-15.7.7-x64-desktop-4.96.1"] } } } });
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

for (const architecture of ["x64", "arm64"] as const) test(`the ${architecture} runner admission accepts a newer Docker tuple on the same kernel flavor and isolation options`, async () => {
  const fixture = azureRunnerFixture(architecture);
  Object.assign(fixture.info, { ServerVersion: "29.1.0", KernelVersion: "6.17.0-1030-azure" });
  Object.assign(fixture.server, { Version: "29.1.0", GitCommit: "abcdef1", KernelVersion: "6.17.0-1030-azure" });
  Object.assign(fixture.server.Components[0]!, { Version: "29.1.0", Details: { GitCommit: "abcdef1" } });
  Object.assign(fixture.server.Components[1]!, { Version: "v2.4.3", Details: { GitCommit: "fedcba9876543210fedcba9876543210fedcba98" } });
  Object.assign(fixture.server.Components[2]!, { Version: "1.5.3", Details: { GitCommit: "v1.5.3-0-g0000000" } });
  const host: SetupHost = { ...fixture.host, run: async (args, timeout, context) => {
    if (args.join(" ") === "docker --version") return { status: "completed", exitCode: 0, stdout: "Docker version 29.1.0, build 1234567", stderr: "" };
    if (args[3] === "compose") return { status: "completed", exitCode: 0, stdout: "2.40.0", stderr: "" };
    return fixture.host.run(args, timeout, context);
  } };
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(host) });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.result).toMatchObject({ ok: true, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "verified", floor: `ubuntu-${architecture}-engine-azure`, admission: "above-floor", measuredRows: [`ubuntu-24.04-${architecture}-docker-28.0.4-azure`] } } } });
  expect(fixture.containers.size).toBe(0);
});

// Version floors (#137): one floor per target, derived from the lowest measured row; versions compare per tool grammar, identity stays exact.
import type { HostIdentity } from "../../src/setup/commands.ts";
import { smokeImages } from "../../src/setup/profiles.ts";
import type { FloorComparison, ReadinessTool as FloorTool } from "../../src/setup/readiness.ts";
type Fixture = ReturnType<typeof desktopFixture>;
interface Observation { identity: HostIdentity; bun: string | { version: string; revision?: string }; cli: string; compose: string; image: string; info: Record<string, unknown>; server: Record<string, unknown> }
async function observe(fixture: Fixture): Promise<Observation> {
  const identity = await fixture.host.host();
  const endpoint = "unix:///tmp/fleur-qualified-desktop.sock";
  const cli = (await fixture.host.run(["docker", "--version"], 1000)).stdout;
  const compose = (await fixture.host.run(["docker", "--host", endpoint, "compose", "version", "--short"], 1000)).stdout;
  return { identity, bun: "1.4.3", cli, compose, image: smokeImages[identity.architecture]!, info: structuredClone(fixture.info), server: structuredClone(fixture.server) };
}
function withTool(observation: Observation, tool: FloorTool, value: string): Observation {
  const next: Observation = { ...observation, identity: { ...observation.identity }, info: structuredClone(observation.info), server: structuredClone(observation.server) };
  const components = next.server.Components as { Name: string; Version: string }[];
  if (tool === "release") next.identity = { ...next.identity, release: value };
  if (tool === "kernel") { next.info.KernelVersion = value; next.server.KernelVersion = value; }
  if (tool === "bun") next.bun = value;
  if (tool === "desktop") next.server.Platform = { Name: `Docker Desktop ${value} (999999)` };
  if (tool === "cli") next.cli = `Docker version ${value}, build abcdef0\n`;
  if (tool === "engine") { next.info.ServerVersion = value; next.server.Version = value; components.find((row) => row.Name === "Engine")!.Version = value; }
  if (tool === "compose") next.compose = `${value}\n`;
  if (tool === "containerd" || tool === "runc") components.find((row) => row.Name === tool)!.Version = value;
  return next;
}
const floorTargets: { readonly floor: string; readonly rows: readonly string[]; readonly fixture: () => Fixture; readonly tools: Readonly<Partial<Record<FloorTool, readonly [floor: string, newer: string, older: string]>>> }[] = [
  { floor: "darwin-x64-desktop", rows: ["darwin-15.7.7-x64-desktop-4.96.1"], fixture: () => desktopFixture(), tools: { release: ["15.7.7", "15.7.8", "15.7.6"], kernel: ["7.0.14-linuxkit", "7.0.15-linuxkit", "7.0.13-linuxkit"], bun: ["1.4.3", "1.4.4", "1.4.2"], desktop: ["4.96.1", "4.97.0", "4.95.9"], cli: ["29.9.2", "29.9.3", "29.9.1"], engine: ["29.9.2", "29.9.3", "29.9.1"], compose: ["5.6.0", "5.6.1", "5.5.9"], containerd: ["v2.4.2", "v2.4.3", "v2.4.1"], runc: ["1.5.2", "1.5.3", "1.5.1"] } },
  { floor: "ubuntu-x64-engine", rows: ["ubuntu-24.04-x64-docker-29.9.1", "ubuntu-26.04-x64-docker-29.9.1"], fixture: () => ubuntuFixture(), tools: { release: ["24.04", "24.10", "22.04"], kernel: ["6.8.0-147-generic", "6.8.0-150-generic", "6.8.0-146-generic"], bun: ["1.4.3", "1.4.4", "1.4.2"], cli: ["29.9.1", "29.9.2", "29.9.0"], engine: ["29.9.1", "29.9.2", "29.9.0"], compose: ["5.6.0", "5.6.1", "5.5.9"], containerd: ["v2.4.2", "v2.4.3", "v2.4.1"], runc: ["1.5.2", "1.5.3", "1.5.1"] } },
  { floor: "debian-x64-engine", rows: ["debian-13-x64-docker-29.9.1"], fixture: () => debianFixture(), tools: { release: ["13", "13.1", "12"], kernel: ["6.12.113+deb13-cloud-amd64", "6.12.120+deb13.1-cloud-amd64", "6.12.112+deb13-cloud-amd64"], bun: ["1.4.3", "1.4.4", "1.4.2"], cli: ["29.9.1", "29.9.2", "29.9.0"], engine: ["29.9.1", "29.9.2", "29.9.0"], compose: ["5.6.0", "5.6.1", "5.5.9"], containerd: ["v2.4.2", "v2.4.3", "v2.4.1"], runc: ["1.5.2", "1.5.3", "1.5.1"] } },
  { floor: "ubuntu-x64-engine-azure", rows: ["ubuntu-24.04-x64-docker-28.0.4-azure"], fixture: () => azureRunnerFixture("x64"), tools: { release: ["24.04", "24.10", "22.04"], kernel: ["6.17.0-1022-azure", "6.17.0-1030-azure", "6.17.0-1021-azure"], bun: ["1.4.3", "1.4.4", "1.4.2"], cli: ["28.0.4", "28.0.5", "28.0.3"], engine: ["28.0.4", "28.0.5", "28.0.3"], compose: ["2.38.2", "2.40.0", "2.38.1"], containerd: ["v2.4.1", "v2.4.2", "v2.4.0"], runc: ["1.5.2", "1.5.3", "1.5.1"] } },
  { floor: "ubuntu-arm64-engine-azure", rows: ["ubuntu-24.04-arm64-docker-28.0.4-azure"], fixture: () => azureRunnerFixture("arm64"), tools: { release: ["24.04", "24.10", "22.04"], kernel: ["6.17.0-1022-azure", "6.17.0-1030-azure", "6.17.0-1021-azure"], bun: ["1.4.3", "1.4.4", "1.4.2"], cli: ["28.0.4", "28.0.5", "28.0.3"], engine: ["28.0.4", "28.0.5", "28.0.3"], compose: ["2.38.2", "2.40.0", "2.38.1"], containerd: ["v2.4.1", "v2.4.2", "v2.4.0"], runc: ["1.5.2", "1.5.3", "1.5.1"] } },
];

for (const target of floorTargets) for (const [tool, [floor, newer, older]] of Object.entries(target.tools) as [FloorTool, readonly [string, string, string]][]) {
  test(`${target.floor} admits ${tool} ${newer} above the ${floor} floor and refuses ${older} as older`, async () => {
    const { compareReadiness, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
    const base = await observe(target.fixture());
    const measured = compareReadiness(nativeReadinessProfiles, base);
    expect(measured).toMatchObject({ state: "verified", admission: "measured", floor: target.floor, measuredRows: target.rows, blocking: null, identity: { matched: true, mismatches: [] } });
    expect(measured.machineTools.find((row) => row.tool === tool)).toEqual({ tool, status: "verified", floor, detected: floor, comparison: "equal" });
    const admitted = compareReadiness(nativeReadinessProfiles, withTool(base, tool, newer));
    expect(admitted).toMatchObject({ state: "verified", admission: "above-floor", floor: target.floor, blocking: null });
    expect(admitted.machineTools.find((row) => row.tool === tool)).toEqual({ tool, status: "admitted", floor, detected: newer, comparison: "newer" });
    const refused = compareReadiness(nativeReadinessProfiles, withTool(base, tool, older));
    expect(refused).toMatchObject({ state: "unverified", admission: null, floor: target.floor, blocking: { tool, floor, detected: older, comparison: "older" } });
    expect(refused.machineTools.find((row) => row.tool === tool)).toEqual({ tool, status: "unverified", floor, detected: older, comparison: "older" });
  });
}

test("engine targets publish no Docker Desktop product row and the Desktop target lists every tool once", async () => {
  const { compareReadiness, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const engine = compareReadiness(nativeReadinessProfiles, await observe(ubuntuFixture()));
  expect(engine.machineTools.map((row) => row.tool)).toEqual(["release", "kernel", "bun", "cli", "engine", "compose", "containerd", "runc"]);
  const desktop = compareReadiness(nativeReadinessProfiles, await observe(desktopFixture()));
  expect(desktop.machineTools.map((row) => row.tool)).toEqual(["release", "kernel", "bun", "desktop", "cli", "engine", "compose", "containerd", "runc"]);
});

test("the first blocking tool is reported in tool order when several tools are below the floor", async () => {
  const { compareReadiness, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const base = await observe(ubuntuFixture());
  const result = compareReadiness(nativeReadinessProfiles, withTool(withTool(base, "runc", "1.5.1"), "compose", "5.5.9"));
  expect(result.blocking).toEqual({ tool: "compose", status: "unverified", floor: "5.6.0", detected: "5.5.9", comparison: "older" });
  expect(result.machineTools.filter((row) => row.status === "unverified").map((row) => row.tool)).toEqual(["compose", "runc"]);
});

// Interim Ubuntu (#134), Debian point releases and newer macOS are admitted; a host without VERSION_ID has nothing to compare.
// 26.04 is a measured release of the Ubuntu target and is covered by its own test below; these releases were not measured on any row.
test.each([["ubuntu", "24.10"], ["ubuntu", "25.04"], ["ubuntu", "25.10"], ["debian", "13.1"], ["debian", "14"], ["darwin", "26.1"], ["darwin", "26.0"]])("%s release %s is admitted above its floor", async (family, release) => {
  const { compareReadiness, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const base = await observe(family === "ubuntu" ? ubuntuFixture() : family === "debian" ? debianFixture() : desktopFixture());
  const result = compareReadiness(nativeReadinessProfiles, withTool(base, "release", release));
  expect(result).toMatchObject({ state: "verified", admission: "above-floor", blocking: null });
  expect(result.machineTools[0]).toMatchObject({ tool: "release", status: "admitted", detected: release, comparison: "newer" });
});

test("a Linux host without VERSION_ID refuses as unparseable, distinct from older", async () => {
  const { compareReadiness, compareMachineTool, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const result = compareReadiness(nativeReadinessProfiles, withTool(await observe(debianFixture()), "release", "rolling"));
  expect(result).toMatchObject({ state: "unverified", floor: "debian-x64-engine", blocking: { tool: "release", floor: "13", detected: "rolling", comparison: "unparseable" } });
  expect(compareMachineTool("release", "24.04", "rolling")).toBe("unparseable");
  expect(compareMachineTool("release", "24.04", "")).toBe("unparseable");
  expect(compareMachineTool("release", "24.04", "24.04.1")).toBe("newer");
  expect(compareMachineTool("release", "15.7.7", "26.0")).toBe("newer");
  expect(compareMachineTool("release", "15.7.7", "15.7")).toBe("older");
  expect(compareMachineTool("release", "13", "13.0.0")).toBe("equal");
});

// Kernel grammars: Ubuntu X.Y.Z-ABI-flavour, Debian X.Y.Z+debN[.serial]-flavour, localversion X.Y[.Z]-name; flavour tails are exact identity.
const kernelCases: readonly (readonly [floor: string, detected: string, expected: FloorComparison])[] = [
  ["6.8.0-147-generic", "6.8.0-150-generic", "newer"],
  ["6.8.0-147-generic", "6.8.0-147-generic", "equal"],
  ["6.8.0-147-generic", "6.8.0-146-generic", "older"],
  ["6.8.0-147-generic", "6.17.0-14-generic", "newer"],
  ["6.8.0-147-generic", "7.0.0-38-generic", "newer"],
  ["6.6.13-linuxkit", "7.0-linuxkit", "newer"],
  ["7.0.14-linuxkit", "7.0-linuxkit", "older"],
  ["7.0.14-linuxkit", "7.0.15-linuxkit", "newer"],
  ["6.12.113+deb13-cloud-amd64", "6.12.120+deb13.1-cloud-amd64", "newer"],
  ["6.12.113+deb13-cloud-amd64", "6.12.113+deb13.1-cloud-amd64", "newer"],
  ["6.12.113+deb13-cloud-amd64", "6.12.113+deb13-cloud-amd64", "equal"],
  ["6.12.113+deb13-cloud-amd64", "7.2.11+deb13-cloud-amd64", "newer"],
  ["6.12.113+deb13-cloud-amd64", "6.12.113+deb14-cloud-amd64", "identity"],
  ["6.12.113+deb13-cloud-amd64", "6.12.113+deb13-amd64", "identity"],
  ["6.17.0-1022-azure", "6.17.0-1030-azure", "newer"],
  ["6.17.0-1022-azure", "6.17.0-1022-generic", "identity"],
  ["6.8.0-147-generic", "6.17.0-1022-azure", "identity"],
  ["7.0.14-linuxkit", "7.0.14-generic", "identity"],
  ["6.8.0-147-generic", "6.8.0-147-linuxkit", "identity"],
  ["6.8.0-147-generic", "6.8.0-rc3-generic", "pre-release"],
  ["7.0.14-linuxkit", "6.18-rc3", "pre-release"],
  ["7.0.14-linuxkit", "7.1-rc1-linuxkit", "pre-release"],
  ["6.8.0-147-generic", "6.1.0-14595-g292a089d78d3", "unparseable"],
  ["6.8.0-147-generic", "6.8.0-147-generic+", "unparseable"],
  ["6.8.0-147-generic", "6.8.0-147-generic-dirty", "unparseable"],
  ["7.0.14-linuxkit", "7.0.14-linuxkit-dirty", "unparseable"],
  ["7.0.14-linuxkit", "7.0.14", "unparseable"],
  ["6.8.0-147-generic", "fixture-kernel", "unparseable"],
  ["6.8.0-147-generic", "", "unparseable"],
];
test.each(kernelCases)("kernel floor %s compared with %s is %s", async (floor, detected, expected) => {
  const { compareMachineTool } = await import("../../src/setup/readiness.ts");
  expect(compareMachineTool("kernel", floor, detected)).toBe(expected);
});

test("a kernel flavour change refuses as an identity mismatch and a pre-release kernel refuses as pre-release", async () => {
  const { compareReadiness, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const base = await observe(azureRunnerFixture("x64"));
  // The generic kernel matches the required Ubuntu target, whose rows differ from this runner tuple in their security options; the
  // CI-only azure row (kernel mismatch) is equally close but a required target is reported first.
  expect(compareReadiness(nativeReadinessProfiles, withTool(base, "kernel", "6.17.0-1022-generic"))).toMatchObject({ state: "unverified", floor: null, measuredRows: [], machineTools: [], blocking: null, identity: { matched: false, mismatches: ["securityOptions"] } });
  const generic = await observe(ubuntuFixture());
  expect(compareReadiness(nativeReadinessProfiles, withTool(generic, "kernel", "6.8.0-147-azure"))).toMatchObject({ state: "unverified", floor: null, identity: { matched: false, mismatches: ["kernel"] } });
  expect(compareReadiness(nativeReadinessProfiles, withTool(base, "kernel", "6.17.0-1030-azure"))).toMatchObject({ state: "verified", admission: "above-floor", floor: "ubuntu-x64-engine-azure" });
  const ubuntu = await observe(ubuntuFixture());
  expect(compareReadiness(nativeReadinessProfiles, withTool(ubuntu, "kernel", "6.8.0-rc3-generic"))).toMatchObject({ state: "unverified", floor: "ubuntu-x64-engine", blocking: { tool: "kernel", floor: "6.8.0-147-generic", detected: "6.8.0-rc3-generic", comparison: "pre-release" } });
  expect(compareReadiness(nativeReadinessProfiles, withTool(ubuntu, "kernel", "6.8.0-147-generic+"))).toMatchObject({ state: "unverified", floor: "ubuntu-x64-engine", blocking: { tool: "kernel", comparison: "unparseable" } });
});

// Docker components: X.Y.Z with the matched-v rule; pre-release suffixes refuse distinctly; distro repack suffixes and dev builds are unparseable.
const toolCases: readonly (readonly [tool: FloorTool, floor: string, detected: string, expected: FloorComparison])[] = [
  ["containerd", "v2.4.2", "v2.4.3", "newer"],
  ["containerd", "v2.4.2", "2.4.3", "unparseable"],
  ["containerd", "v2.4.2", "v2.4.0-rc.0", "pre-release"],
  ["containerd", "v2.4.2", "v2.4.0-beta.0", "pre-release"],
  ["containerd", "v2.4.2", "2.4.0+unknown", "unparseable"],
  ["containerd", "v2.4.2", "v2.4.2.m", "unparseable"],
  ["engine", "29.9.1", "29.10.0-rc.1", "pre-release"],
  ["engine", "29.9.1", "29.10.0", "newer"],
  ["engine", "29.9.1", "30.0.0", "newer"],
  ["engine", "29.9.1", "26.1.5+dfsg1", "unparseable"],
  ["engine", "29.9.1", "v29.9.1", "unparseable"],
  ["engine", "29.9.1", "dev", "unparseable"],
  ["engine", "29.9.1", "pr-1234", "unparseable"],
  ["cli", "29.9.2", "29.9.1", "older"],
  ["cli", "29.9.2", "20.10.0-beta1", "pre-release"],
  ["runc", "1.5.2", "1.6.0-rc.1", "pre-release"],
  ["runc", "1.5.2", "1.6.0-rc.1+dev", "pre-release"],
  ["runc", "1.5.2", "1.0.0-rc93", "pre-release"],
  ["runc", "1.5.2", "1.3.6+ds1", "unparseable"],
  ["runc", "1.5.2", "1.5.2-dirty", "unparseable"],
  ["compose", "5.6.0", "5.6.1", "newer"],
  ["compose", "5.6.0", "v5.6.1", "unparseable"],
  ["compose", "5.6.0", "5.0.0-alpha.1", "pre-release"],
  ["compose", "2.38.2", "2.40.0", "newer"],
  ["desktop", "4.96.1", "4.97.0", "newer"],
  ["desktop", "4.96.1", "4.96.1", "equal"],
  ["desktop", "4.96.1", "4.95.9", "older"],
  ["bun", "1.4.3", "1.4.4", "newer"],
  ["bun", "1.4.3", "2.0.0", "newer"],
  ["bun", "1.4.3", "1.4.3-canary.1", "pre-release"],
  ["bun", "1.4.3", "1.4.3-debug", "pre-release"],
  ["bun", "1.4.3", "1.4", "unparseable"],
  ["bun", "1.4.3", "1.4.4.1", "unparseable"],
  ["bun", "1.4.3", "v1.4.3", "unparseable"],
];
test.each(toolCases)("%s floor %s compared with %s is %s", async (tool, floor, detected, expected) => {
  const { compareMachineTool } = await import("../../src/setup/readiness.ts");
  expect(compareMachineTool(tool, floor, detected)).toBe(expected);
});

test("a Docker Engine reporting a distro repack version with an empty platform name refuses", async () => {
  const { compareReadiness, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const base = withTool(await observe(debianFixture()), "engine", "26.1.5+dfsg1");
  base.info.ServerVersion = "26.1.5+dfsg1";
  base.server.Platform = { Name: "" };
  const result = compareReadiness(nativeReadinessProfiles, base);
  expect(result).toMatchObject({ state: "unverified", admission: null, identity: { matched: false } });
  expect(result.identity.mismatches).toContain("product");
  const versioned = compareReadiness(nativeReadinessProfiles, withTool(await observe(debianFixture()), "engine", "26.1.5+dfsg1"));
  expect(versioned).toMatchObject({ state: "unverified", floor: "debian-x64-engine", blocking: { tool: "engine", floor: "29.9.1", detected: "26.1.5+dfsg1", comparison: "unparseable" } });
});

test("a Docker Desktop daemon on Linux refuses until a row is measured for it, and an Engine daemon cannot use the Desktop floor", async () => {
  const { compareReadiness, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const linuxDesktop = await observe(ubuntuFixture());
  linuxDesktop.server.Platform = { Name: "Docker Desktop 4.96.1 (244132)" };
  const refused = compareReadiness(nativeReadinessProfiles, linuxDesktop);
  expect(refused).toMatchObject({ state: "unverified", floor: null, identity: { matched: false, mismatches: ["product"] } });
  const macEngine = await observe(desktopFixture());
  macEngine.server.Platform = { Name: "Docker Engine - Community" };
  expect(compareReadiness(nativeReadinessProfiles, macEngine)).toMatchObject({ state: "unverified", floor: null, identity: { matched: false, mismatches: ["product"] } });
  const unversioned = await observe(desktopFixture());
  unversioned.server.Platform = { Name: "Docker Desktop" };
  expect(compareReadiness(nativeReadinessProfiles, unversioned)).toMatchObject({ state: "unverified", floor: "darwin-x64-desktop", blocking: { tool: "desktop", floor: "4.96.1", detected: null, comparison: "unparseable" } });
});

// Bun.version hides the canary tag; bun --revision carries it. Doctor can pass the revision without changing its output yet.
test("a canary Bun revision refuses as pre-release while the same plain version is admitted", async () => {
  const { compareReadiness, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const base = await observe(desktopFixture());
  expect(compareReadiness(nativeReadinessProfiles, { ...base, bun: "1.4.8" })).toMatchObject({ state: "verified", admission: "above-floor" });
  expect(compareReadiness(nativeReadinessProfiles, { ...base, bun: { version: "1.4.8", revision: "1.4.8+38afee6c8" } })).toMatchObject({ state: "verified", admission: "above-floor" });
  const canary = compareReadiness(nativeReadinessProfiles, { ...base, bun: { version: "1.4.8", revision: "1.4.8-canary.3+38afee6c8" } });
  expect(canary).toMatchObject({ state: "unverified", floor: "darwin-x64-desktop", blocking: { tool: "bun", floor: "1.4.3", detected: "1.4.8-canary.3+38afee6c8", comparison: "pre-release" } });
  expect(compareReadiness(nativeReadinessProfiles, { ...base, bun: { version: "1.4.3", revision: "1.4.3-canary.12+0123456ab" } }).blocking).toMatchObject({ tool: "bun", comparison: "pre-release" });
  expect(compareReadiness(nativeReadinessProfiles, { ...base, bun: { version: "1.4.3", revision: "1.4.3-debug+0123456ab" } }).blocking).toMatchObject({ tool: "bun", comparison: "pre-release" });
  // A revision that does not describe the reported version cannot vouch for it.
  expect(compareReadiness(nativeReadinessProfiles, { ...base, bun: { version: "1.4.3", revision: "1.4.4+0123456ab" } }).blocking).toMatchObject({ tool: "bun", detected: "1.4.4+0123456ab", comparison: "unparseable" });
});

// Identity facts never use floor comparison.
test.each([
  ["cgroupDriver", (observation: Observation) => { observation.info.CgroupDriver = "systemd"; }, ["cgroupDriver"]],
  ["cgroupVersion", (observation: Observation) => { observation.info.CgroupVersion = "1"; }, ["daemon"]],
  ["operatingMode", (observation: Observation) => { (observation.info.SecurityOptions as string[]).push("name=rootless"); }, ["operatingMode", "securityOptions"]],
  ["securityOptions", (observation: Observation) => { (observation.info.SecurityOptions as string[]).push("name=userns"); }, ["securityOptions"]],
  ["image", (observation: Observation) => { observation.image = smokeImages.arm64!; }, ["image"]],
  ["architecture", (observation: Observation) => { observation.info.Architecture = "aarch64"; observation.server.Arch = "arm64"; }, ["architecture"]],
  ["translated", (observation: Observation) => { observation.identity = { ...observation.identity, translated: true }; }, ["translated"]],
  ["system", (observation: Observation) => { observation.identity = { ...observation.identity, system: "linux", distribution: "ubuntu", release: "24.04" }; }, ["system", "distribution"]],
  ["daemon limits", (observation: Observation) => { observation.info.MemoryLimit = false; }, ["daemon"]],
] as const)("Intel Desktop identity drift in %s refuses regardless of versions", async (_fact, drift, mismatches) => {
  const { compareReadiness, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const observation = await observe(desktopFixture());
  drift(observation);
  const result = compareReadiness(nativeReadinessProfiles, observation);
  expect(result).toMatchObject({ state: "unverified", admission: null, floor: null, measuredRows: [], machineTools: [], blocking: null, identity: { matched: false } });
  for (const fact of mismatches) expect(result.identity.mismatches).toContain(fact);
});

test("the measured Ubuntu 26.04 row is reported exactly while its floor stays the 24.04 row", async () => {
  const { compareReadiness, nativeReadinessProfiles, readinessCandidates, matchReadinessServer } = await import("../../src/setup/readiness.ts");
  const observation = await observe(ubuntuFixture("26.04"));
  const result = compareReadiness(nativeReadinessProfiles, observation);
  // Every value was measured on the 26.04 row, so the tuple is measured even though release and kernel sit above the floor.
  expect(result).toMatchObject({ state: "verified", admission: "measured", floor: "ubuntu-x64-engine", measuredRows: ["ubuntu-24.04-x64-docker-29.9.1", "ubuntu-26.04-x64-docker-29.9.1"] });
  expect(result.machineTools.filter((row) => row.comparison === "newer").map((row) => [row.tool, row.status, row.floor, row.detected])).toEqual([["release", "verified", "24.04", "26.04"], ["kernel", "verified", "6.8.0-147-generic", "7.0.0-38-generic"]]);
  expect(result.machineTools.every((row) => row.status === "verified")).toBe(true);
  const candidates = readinessCandidates(nativeReadinessProfiles, observation.identity, "1.4.3", observation.cli, observation.compose, observation.image, observation.info);
  expect(candidates.map((row) => row.id)).toEqual(["ubuntu-24.04-x64-docker-29.9.1", "ubuntu-26.04-x64-docker-29.9.1"]);
  expect(matchReadinessServer(candidates, observation.identity, observation.server)?.id).toBe("ubuntu-26.04-x64-docker-29.9.1");
  const interim = withTool(withTool(observation, "release", "24.10"), "kernel", "6.11.0-9-generic");
  expect(matchReadinessServer(readinessCandidates(nativeReadinessProfiles, interim.identity, "1.4.3", interim.cli, interim.compose, interim.image, interim.info), interim.identity, interim.server)?.id).toBe("ubuntu-24.04-x64-docker-29.9.1");
});

// Floor derivation: one floor per target from the lowest measured row; every measured row stays as evidence.
test("the compiled catalog derives one floor per target from its lowest measured rows", async () => {
  const { deriveReadinessFloors, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const floors = deriveReadinessFloors(nativeReadinessProfiles);
  expect(floors.map((floor) => floor.id)).toEqual(["ubuntu-x64-engine", "ubuntu-arm64-engine-azure", "ubuntu-x64-engine-azure", "debian-x64-engine", "darwin-x64-desktop"]);
  expect(floors.find((floor) => floor.id === "ubuntu-x64-engine")).toEqual({
    id: "ubuntu-x64-engine", ciOnly: false, target: { system: "linux", distribution: "ubuntu", architecture: "x64", product: "engine", kernel: "generic" },
    rows: ["ubuntu-24.04-x64-docker-29.9.1", "ubuntu-26.04-x64-docker-29.9.1"],
    versions: { release: "24.04", kernel: "6.8.0-147-generic", bun: "1.4.3", cli: "29.9.1", engine: "29.9.1", compose: "5.6.0", containerd: "v2.4.2", runc: "1.5.2" },
  });
  expect(floors.find((floor) => floor.id === "darwin-x64-desktop")).toEqual({
    id: "darwin-x64-desktop", ciOnly: false, target: { system: "darwin", distribution: null, architecture: "x64", product: "desktop", kernel: "linuxkit" },
    rows: ["darwin-15.7.7-x64-desktop-4.96.1"],
    versions: { release: "15.7.7", kernel: "7.0.14-linuxkit", bun: "1.4.3", desktop: "4.96.1", cli: "29.9.2", engine: "29.9.2", compose: "5.6.0", containerd: "v2.4.2", runc: "1.5.2" },
  });
  expect(floors.find((floor) => floor.id === "debian-x64-engine")).toMatchObject({ ciOnly: false, target: { kernel: "deb13-cloud-amd64" }, versions: { release: "13", kernel: "6.12.113+deb13-cloud-amd64" } });
  expect(floors.find((floor) => floor.id === "ubuntu-x64-engine-azure")).toMatchObject({ ciOnly: true, target: { architecture: "x64", kernel: "azure" }, rows: ["ubuntu-24.04-x64-docker-28.0.4-azure"], versions: { cli: "28.0.4", compose: "2.38.2", containerd: "v2.4.1" } });
  expect(floors.find((floor) => floor.id === "ubuntu-arm64-engine-azure")).toMatchObject({ ciOnly: true, target: { architecture: "arm64", kernel: "azure" }, rows: ["ubuntu-24.04-arm64-docker-28.0.4-azure"] });
});

test("adding a newer measured row does not raise the published floor; the lowest value of each tool defines it", async () => {
  const { deriveReadinessFloors, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const ubuntu = nativeReadinessProfiles.find((row) => row.id === "ubuntu-24.04-x64-docker-29.9.1")!;
  const before = deriveReadinessFloors(nativeReadinessProfiles).find((floor) => floor.id === "ubuntu-x64-engine")!;
  const newer = { ...ubuntu, id: "ubuntu-26.10-x64-docker-30.0.0", host: { ...ubuntu.host, release: "26.10" }, bun: "1.5.0", cli: { version: "30.0.0", commit: "1234567" }, engine: { ...ubuntu.engine, version: "30.0.0", commit: "89abcde", kernel: "7.2.0-12-generic" }, containerd: { version: "v2.5.0", commit: "0".repeat(40) }, runc: { version: "1.6.0", commit: "v1.6.0-0-g0000000" }, compose: "6.0.0", evidence: { readinessSha256: "a".repeat(64), isolationSha256: "b".repeat(64) } };
  const withNewer = deriveReadinessFloors([...nativeReadinessProfiles, newer]).find((floor) => floor.id === "ubuntu-x64-engine")!;
  expect(withNewer.versions).toEqual(before.versions);
  expect(withNewer.rows).toEqual([...before.rows, "ubuntu-26.10-x64-docker-30.0.0"]);
  // A lower row lowers the floor per tool: the floor is the componentwise minimum, not one row's whole tuple.
  const mixed = { ...newer, id: "ubuntu-22.04-x64-docker-30.0.0", host: { ...ubuntu.host, release: "22.04" }, engine: { ...newer.engine, kernel: "6.5.0-10-generic" }, evidence: { readinessSha256: "c".repeat(64), isolationSha256: "d".repeat(64) } };
  const withMixed = deriveReadinessFloors([...nativeReadinessProfiles, mixed]).find((floor) => floor.id === "ubuntu-x64-engine")!;
  expect(withMixed.versions).toEqual({ ...before.versions, release: "22.04", kernel: "6.5.0-10-generic" });
});

// Catalog integrity: floors are the only policy, so rows carry no admission field and every row must parse under its grammars.
test.each([
  ["an admission field", { ...policy, admission: "minimum" }],
  ["an exact admission field", { ...policy, admission: "exact" }],
  ["an unparseable kernel", { ...policy, engine: { ...policy.engine, kernel: "fixture-kernel" } }],
  ["a pre-release kernel", { ...policy, engine: { ...policy.engine, kernel: "7.1.0-rc2-linuxkit" } }],
  ["a release-less host", { ...policy, host: { ...policy.host, release: "rolling" } }],
  ["a pre-release Bun", { ...policy, bun: "1.4.3-canary.1" }],
  ["a versionless Desktop platform", { ...policy, engine: { ...policy.engine, platform: "Docker Desktop" } }],
])("a compiled catalog row with %s invalidates the catalog", async (_shape, row) => {
  const { snapshotReadinessProfiles } = await import("../../src/setup/readiness.ts");
  expect(snapshotReadinessProfiles([row as never])).toEqual([]);
  const fixture = desktopFixture();
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, [], [row as never]) });
  expect(outcome.exitCode).toBe(4);
  expect(fixture.commands.some((args) => args[3] === "version")).toBe(false);
});

// Review finding: a newly measured kernel flavour for a required target must not invalidate the catalog; each flavour is its own floor.
test("a second measured kernel flavour for a required target publishes flavour-qualified floor ids", async () => {
  const { snapshotReadinessProfiles, deriveReadinessFloors, compareReadiness } = await import("../../src/setup/readiness.ts");
  const lowlatency = { ...policy, id: "synthetic-lowlatency", engine: { ...policy.engine, kernel: "7.0.14-lowlatency" }, evidence: { readinessSha256: "3".repeat(64), isolationSha256: "4".repeat(64) } };
  expect(snapshotReadinessProfiles([policy, lowlatency])).toHaveLength(2);
  expect(deriveReadinessFloors([policy, lowlatency]).map((floor) => [floor.id, floor.ciOnly, floor.rows])).toEqual([["darwin-x64-desktop-linuxkit", false, [policy.id]], ["darwin-x64-desktop-lowlatency", false, ["synthetic-lowlatency"]]]);
  expect(deriveReadinessFloors([policy]).map((floor) => floor.id)).toEqual(["darwin-x64-desktop"]);
  expect(compareReadiness([policy, lowlatency], await observe(desktopFixture()))).toMatchObject({ state: "verified", floor: "darwin-x64-desktop-linuxkit", measuredRows: [policy.id] });
});

// Review finding: rows of one target must agree on every non-kernel identity tail; a distro build without containerd's `v` is another identity.
test("rows of one target disagreeing on the containerd version prefix invalidate the catalog instead of hiding the lower row", async () => {
  const { snapshotReadinessProfiles, deriveReadinessFloors } = await import("../../src/setup/readiness.ts");
  const distro = { ...policy, id: "synthetic-distro-containerd", containerd: { version: "2.3.0", commit: "0".repeat(40) }, evidence: { readinessSha256: "5".repeat(64), isolationSha256: "6".repeat(64) } };
  expect(snapshotReadinessProfiles([policy, distro])).toEqual([]);
  expect(deriveReadinessFloors([policy, distro])).toEqual([]);
});

// Review finding: the reported measured row must agree with the host release, not only with the server build.
test("an Ubuntu 24.04 host on the kernel measured by the 26.04 row is attributed to the 24.04 row with the kernel marked measured", async () => {
  const { compareReadiness, nativeReadinessProfiles, readinessCandidates, matchReadinessServer } = await import("../../src/setup/readiness.ts");
  const observation = withTool(await observe(ubuntuFixture()), "kernel", "7.0.0-38-generic");
  const candidates = readinessCandidates(nativeReadinessProfiles, observation.identity, "1.4.3", observation.cli, observation.compose, observation.image, observation.info);
  expect(matchReadinessServer(candidates, observation.identity, observation.server)?.id).toBe("ubuntu-24.04-x64-docker-29.9.1");
  const result = compareReadiness(nativeReadinessProfiles, observation);
  // The kernel equals a measured row's value, so it is verified rather than admitted; the tuple as a whole matches no single row.
  expect(result).toMatchObject({ state: "verified", admission: "above-floor", floor: "ubuntu-x64-engine" });
  expect(result.machineTools.find((row) => row.tool === "kernel")).toEqual({ tool: "kernel", status: "verified", floor: "6.8.0-147-generic", detected: "7.0.0-38-generic", comparison: "newer" });
  expect(result.machineTools.filter((row) => row.status !== "verified")).toEqual([]);
});

// Review finding: an identity report must prefer the required target over a CI-only runner row when they are equally close.
test("an Ubuntu host with the legacy AppArmor descriptor is reported against the required target's security options", async () => {
  const { compareReadiness, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const observation = await observe(ubuntuFixture());
  (observation.info.SecurityOptions as string[])[0] = "name=apparmor";
  expect(compareReadiness(nativeReadinessProfiles, observation)).toMatchObject({ state: "unverified", floor: null, identity: { matched: false, mismatches: ["securityOptions"] } });
});

// Review finding: when a tool is observed in several places, detected must be the value that produced the reported comparison.
test("the detected engine version is the observed value that produced the blocking comparison", async () => {
  const { compareReadiness, nativeReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const base = await observe(ubuntuFixture());
  const serverOlder = structuredClone(base); serverOlder.server.Version = "29.9.0";
  expect(compareReadiness(nativeReadinessProfiles, serverOlder).blocking).toEqual({ tool: "engine", status: "unverified", floor: "29.9.1", detected: "29.9.0", comparison: "older" });
  const daemonOlder = structuredClone(base); daemonOlder.info.ServerVersion = "29.9.0";
  expect(compareReadiness(nativeReadinessProfiles, daemonOlder).blocking).toEqual({ tool: "engine", status: "unverified", floor: "29.9.1", detected: "29.9.0", comparison: "older" });
  const componentNewer = structuredClone(base); (componentNewer.server.Components as { Name: string; Version: string }[]).find((row) => row.Name === "Engine")!.Version = "29.9.2";
  expect(compareReadiness(nativeReadinessProfiles, componentNewer).machineTools.find((row) => row.tool === "engine")).toEqual({ tool: "engine", status: "admitted", floor: "29.9.1", detected: "29.9.2", comparison: "newer" });
});

// Review finding: a pre-release Docker Desktop product version is a desktop pre-release refusal, not a product identity mismatch.
test("a pre-release Docker Desktop product version refuses as pre-release with the product identity intact", async () => {
  const { compareReadiness, nativeReadinessProfiles, snapshotReadinessProfiles } = await import("../../src/setup/readiness.ts");
  const observation = await observe(desktopFixture());
  observation.server.Platform = { Name: "Docker Desktop 4.97.0-beta.1 (244700)" };
  expect(compareReadiness(nativeReadinessProfiles, observation)).toMatchObject({ state: "unverified", floor: "darwin-x64-desktop", identity: { matched: true }, blocking: { tool: "desktop", floor: "4.96.1", detected: "4.97.0-beta.1", comparison: "pre-release" } });
  expect(snapshotReadinessProfiles([{ ...policy, engine: { ...policy.engine, platform: "Docker Desktop 4.97.0-beta.1 (1)" } }])).toEqual([]);
});

// Review finding: only a git-describe tail of seven or more hex digits is an SCM marker; a short hex-like flavour is a flavour.
test("a kernel flavour made of hex letters is an identity difference, not an unreleased build", async () => {
  const { compareMachineTool } = await import("../../src/setup/readiness.ts");
  expect(compareMachineTool("kernel", "6.8.0-147-generic", "6.8.0-148-gface")).toBe("identity");
  expect(compareMachineTool("kernel", "6.8.0-147-generic", "6.8.0-148-gface1234")).toBe("unparseable");
  expect(compareMachineTool("kernel", "6.8.0-147-generic", "6.8.0-147-generic-14595-g292a089d78d3")).toBe("unparseable");
});

// Doctor floor output (#138, decision #131 Variant A): release names the floor and admission, lists one status row per machine tool,
// and a floor refusal names the blocking tool with both numbers. Identity mismatches keep the generic refusal.
const verifiedReleaseKeys = ["state", "floor", "admission", "measuredRows", "machineTools", "evidence"];
const unverifiedReleaseKeys = ["state", "floor", "machineTools"];
const toolRowKeys = ["tool", "status", "floor", "detected", "comparison"];
type ToolRow = { tool: string; status: string; floor: string; detected: string | null; comparison: string };
function releaseOf(outcome: Awaited<ReturnType<typeof runCli>>): Record<string, unknown> & { machineTools?: ToolRow[] } {
  return (outcome.result.data as { components: { release: Record<string, unknown> & { machineTools?: ToolRow[] } } }).components.release;
}
function withRun(fixture: Fixture, override: (args: readonly string[]) => HostCommandResult | undefined): SetupHost {
  return { ...fixture.host, run: async (args, timeout, context) => override(args) ?? fixture.host.run(args, timeout, context) };
}

test("doctor reports an exact Intel Desktop match as measured with every machine tool verified", async () => {
  const fixture = desktopFixture();
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, [], [policy]) });
  expect(outcome.exitCode, JSON.stringify(outcome.result)).toBe(0);
  const release = releaseOf(outcome);
  expect(Object.keys(release)).toEqual(verifiedReleaseKeys);
  expect(release).toMatchObject({ state: "verified", floor: "darwin-x64-desktop", admission: "measured", measuredRows: ["darwin-15.7.7-x64-desktop-4.96.1"], evidence: { readinessSha256: "1".repeat(64), isolationSha256: "2".repeat(64) } });
  expect(release.machineTools!.map((row) => Object.keys(row))).toEqual(release.machineTools!.map(() => toolRowKeys));
  expect(release.machineTools).toEqual([
    { tool: "release", status: "verified", floor: "15.7.7", detected: "15.7.7", comparison: "equal" },
    { tool: "kernel", status: "verified", floor: "7.0.14-linuxkit", detected: "7.0.14-linuxkit", comparison: "equal" },
    { tool: "bun", status: "verified", floor: "1.4.3", detected: "1.4.3", comparison: "equal" },
    { tool: "desktop", status: "verified", floor: "4.96.1", detected: "4.96.1", comparison: "equal" },
    { tool: "cli", status: "verified", floor: "29.9.2", detected: "29.9.2", comparison: "equal" },
    { tool: "engine", status: "verified", floor: "29.9.2", detected: "29.9.2", comparison: "equal" },
    { tool: "compose", status: "verified", floor: "5.6.0", detected: "5.6.0", comparison: "equal" },
    { tool: "containerd", status: "verified", floor: "v2.4.2", detected: "v2.4.2", comparison: "equal" },
    { tool: "runc", status: "verified", floor: "1.5.2", detected: "1.5.2", comparison: "equal" },
  ]);
  expect(fixture.commands).toContainEqual([process.execPath, "--revision"]);
  expect(outcome.human).toContain("release   verified  floor darwin-x64-desktop (measured on darwin-15.7.7-x64-desktop-4.96.1)");
  expect(outcome.human).toMatch(/\n\s+bun\s+verified\s+1\.4\.3\s+= floor\n/);
  expect(outcome.human).toMatch(/\n\s+smoke\s+ready, cleanup confirmed\n/);
  expect(outcome.human).not.toContain("admitted above the measured baseline");
  expect(fixture.containers.size).toBe(0);
});

test("doctor reports a tuple above the Intel Desktop floor as above-floor with admitted rows and a trailing note", async () => {
  const fixture = newerDesktopFixture();
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, []) });
  expect(outcome.exitCode, JSON.stringify(outcome.result)).toBe(0);
  const release = releaseOf(outcome);
  expect(Object.keys(release)).toEqual(verifiedReleaseKeys);
  expect(release).toMatchObject({ state: "verified", floor: "darwin-x64-desktop", admission: "above-floor", measuredRows: ["darwin-15.7.7-x64-desktop-4.96.1"] });
  expect(release.machineTools!.map((row) => [row.tool, row.status, row.floor, row.detected, row.comparison])).toEqual([
    ["release", "verified", "15.7.7", "15.7.7", "equal"], ["kernel", "admitted", "7.0.14-linuxkit", "7.0.15-linuxkit", "newer"], ["bun", "verified", "1.4.3", "1.4.3", "equal"],
    ["desktop", "admitted", "4.96.1", "4.97.0", "newer"], ["cli", "admitted", "29.9.2", "29.9.3", "newer"], ["engine", "admitted", "29.9.2", "29.9.3", "newer"],
    ["compose", "admitted", "5.6.0", "5.6.1", "newer"], ["containerd", "admitted", "v2.4.2", "v2.4.3", "newer"], ["runc", "admitted", "1.5.2", "1.5.3", "newer"],
  ]);
  expect(outcome.human).toMatch(/\n\s+desktop\s+admitted\s+4\.97\.0\s+> floor 4\.96\.1\n/);
  expect(outcome.human).toMatch(/\n\s+release\s+verified\s+15\.7\.7\s+= floor\n/);
  expect(outcome.human).toContain("7 tools admitted above the measured baseline; measured evidence is for the baseline tuple.");
  expect(fixture.containers.size).toBe(0);
});

test("doctor refuses a machine tool below the floor naming the tool and both numbers", async () => {
  const fixture = desktopFixture();
  const host = withRun(fixture, (args) => args[3] === "compose" ? { status: "completed", exitCode: 0, stdout: "5.5.9\n", stderr: "" } : undefined);
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(host, [], [policy]) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result).toMatchObject({ ok: false, error: { code: "PREREQUISITE_UNAVAILABLE", message: "Machine tool compose is 5.5.9, below the floor 5.6.0.", expected: { tool: "compose", floor: "5.6.0" }, actual: { tool: "compose", detected: "5.5.9" }, actions: [{ command: "fleur setup", description: "Inspect the missing actions without replacing existing software." }] }, data: { components: { smoke: { state: "ready", cleanup: true } } } });
  const release = releaseOf(outcome);
  expect(Object.keys(release)).toEqual(unverifiedReleaseKeys);
  expect(release).toMatchObject({ state: "unverified", floor: "darwin-x64-desktop" });
  expect(release.machineTools!.map((row) => Object.keys(row))).toEqual(release.machineTools!.map(() => toolRowKeys));
  expect(release.machineTools!.find((row) => row.tool === "compose")).toEqual({ tool: "compose", status: "unverified", floor: "5.6.0", detected: "5.5.9", comparison: "older" });
  expect(release.machineTools!.filter((row) => row.status !== "verified").map((row) => row.tool)).toEqual(["compose"]);
  expect(outcome.human).toContain("release   unverified  floor darwin-x64-desktop");
  expect(outcome.human).toMatch(/\n\s+compose\s+unverified\s+5\.5\.9\s+< floor 5\.6\.0\n/);
  expect(outcome.human).toContain("PREREQUISITE_UNAVAILABLE: Machine tool compose is 5.5.9, below the floor 5.6.0.");
  expect(outcome.human).toContain("fleur setup   Inspect the missing actions without replacing existing software.");
  expect(fixture.containers.size).toBe(0);
});

test("doctor reads the Bun revision through the host runner and refuses a canary build as pre-release", async () => {
  const fixture = desktopFixture();
  const revision = `${Bun.version}-canary.3+38afee6c8`;
  const host = withRun(fixture, (args) => args[0] === process.execPath && args[1] === "--revision" ? { status: "completed", exitCode: 0, stdout: `${revision}\n`, stderr: "" } : undefined);
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(host, [], [policy]) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result).toMatchObject({ ok: false, error: { code: "PREREQUISITE_UNAVAILABLE", message: `Machine tool bun is a pre-release build (${revision}); release floors admit stable versions only.`, expected: { tool: "bun", floor: "1.4.3" }, actual: { tool: "bun", detected: revision } } });
  expect(releaseOf(outcome)).toMatchObject({ state: "unverified", floor: "darwin-x64-desktop" });
  expect(releaseOf(outcome).machineTools!.find((row) => row.tool === "bun")).toEqual({ tool: "bun", status: "unverified", floor: "1.4.3", detected: revision, comparison: "pre-release" });
  expect(outcome.human).toMatch(/\n\s+bun\s+unverified\s+1\.4\.3-canary\.3\+38afee6c8\s+pre-release, not admitted\n/);
  expect(fixture.containers.size).toBe(0);
});

test("an unreadable Bun revision refuses as release-less rather than admitting the executable", async () => {
  const fixture = desktopFixture();
  const host = withRun(fixture, (args) => args[1] === "--revision" ? { status: "completed", exitCode: 1, stdout: "", stderr: "unavailable" } : undefined);
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(host, [], [policy]) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result).toMatchObject({ ok: false, error: { code: "PREREQUISITE_UNAVAILABLE", message: "Machine tool bun has no parseable version.", expected: { tool: "bun", floor: "1.4.3" }, actual: { tool: "bun" } } });
  expect(releaseOf(outcome).machineTools!.find((row) => row.tool === "bun")).toMatchObject({ tool: "bun", status: "unverified", comparison: "unparseable" });
  expect(JSON.stringify(outcome.result)).not.toContain("unavailable");
});

test("a Debian host without VERSION_ID reaches readiness and refuses as release-less, not as outside the setup matrix", async () => {
  const fixture = debianFixture();
  const identity = { ...await fixture.host.host(), release: "rolling" };
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({ ...fixture.host, host: async () => identity }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result).toMatchObject({ ok: false, error: { code: "PREREQUISITE_UNAVAILABLE", message: "Machine tool release has no parseable version.", expected: { tool: "release", floor: "13" }, actual: { tool: "release", detected: "rolling" } }, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "unverified", floor: "debian-x64-engine" } } } });
  expect(releaseOf(outcome).machineTools![0]).toEqual({ tool: "release", status: "unverified", floor: "13", detected: "rolling", comparison: "unparseable" });
  expect(outcome.human).toMatch(/\n\s+release\s+unverified\s+rolling\s+no parseable version/);
  expect(fixture.containers.size).toBe(0);
});

test("an interim Ubuntu release reaches readiness, is admitted above the Ubuntu floor and ready setup installs nothing", async () => {
  const fixture = ubuntuFixture();
  fixture.info.KernelVersion = fixture.server.KernelVersion = "6.11.0-9-generic";
  const identity = { ...await fixture.host.host(), release: "24.10" };
  const host: SetupHost = { ...fixture.host, host: async () => identity };
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(host) });
  expect(outcome.exitCode, JSON.stringify(outcome.result)).toBe(0);
  const release = releaseOf(outcome);
  expect(release).toMatchObject({ state: "verified", floor: "ubuntu-x64-engine", admission: "above-floor", measuredRows: ["ubuntu-24.04-x64-docker-29.9.1", "ubuntu-26.04-x64-docker-29.9.1"], evidence: { readinessSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2" } });
  expect(release.machineTools!.slice(0, 2)).toEqual([{ tool: "release", status: "admitted", floor: "24.04", detected: "24.10", comparison: "newer" }, { tool: "kernel", status: "admitted", floor: "6.8.0-147-generic", detected: "6.11.0-9-generic", comparison: "newer" }]);
  expect(release.machineTools!.map((row) => row.tool)).toEqual(["release", "kernel", "bun", "cli", "engine", "compose", "containerd", "runc"]);
  expect(outcome.human).toContain("release   verified  floor ubuntu-x64-engine (measured on ubuntu-24.04-x64-docker-29.9.1, ubuntu-26.04-x64-docker-29.9.1)");
  expect(outcome.human).toContain("2 tools admitted above the measured baseline");
  // No credential, machine identity, socket path or executable path is part of the new output.
  const text = JSON.stringify(outcome.result) + outcome.human;
  for (const leak of ["c".repeat(64), "11111111-1111-4111-8111-111111111111", "/tmp/fleur-qualified-desktop.sock", process.execPath]) expect(text).not.toContain(leak);
  const ready = await runCli(["setup", "--json"], { cwd: "/tmp", handlers: setupCommands(host) });
  expect(ready.exitCode, JSON.stringify(ready.result)).toBe(0);
  expect(ready.result).toMatchObject({ command: "setup", ok: true, data: { components: { release: { state: "verified", admission: "above-floor" } } } });
  expect(fixture.commands.some((args) => ["apt-get", "sudo", "dpkg"].includes(args[0]!) || args.includes("pull") || args.includes("install"))).toBe(false);
  expect(fixture.containers.size).toBe(0);
});

test("setup on an interim Ubuntu release without Docker reports manual setup instead of installing from an exact apt row", async () => {
  const fixture = ubuntuFixture();
  const identity = { ...await fixture.host.host(), release: "24.10" };
  const host: SetupHost = { ...fixture.host, host: async () => identity, run: async (args, timeout, context) => args.join(" ") === "docker --version" ? { status: "missing", stdout: "", stderr: "" } : fixture.host.run(args, timeout, context) };
  const outcome = await runCli(["setup", "--json"], { cwd: "/tmp", handlers: setupCommands(host) });
  expect(outcome.exitCode, JSON.stringify(outcome.result)).toBe(3);
  expect(outcome.result).toMatchObject({ ok: false, error: { code: "HUMAN_ACTION_REQUIRED", actions: [{ command: "fleur doctor" }] }, data: { plan: { method: "docker-official-apt", verified: false }, grantsCreated: false } });
  expect(fixture.commands.some((args) => ["apt-get", "sudo", "dpkg"].includes(args[0]!) || args.includes("install"))).toBe(false);
  // The exact 24.04 row still drives assisted installation on its own release.
  const exact = await runCli(["setup", "--json"], { cwd: "/tmp", handlers: setupCommands({ ...host, host: async () => ({ ...identity, release: "24.04" }) }) });
  expect(exact.result.error?.code).not.toBe("HUMAN_ACTION_REQUIRED");
  expect(fixture.commands.some((args) => args.includes("install"))).toBe(false);
});

test("an identity mismatch keeps the generic unverified refusal without floor fields or further RPC", async () => {
  const fixture = desktopFixture();
  fixture.info.CgroupDriver = "systemd";
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(fixture.host, [], [policy]) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result).toMatchObject({ ok: false, error: { code: "PREREQUISITE_UNAVAILABLE", message: "Observed readiness does not yet establish a verified native release profile." }, data: { components: { smoke: { state: "ready", cleanup: true }, release: { state: "unverified" } } } });
  expect(Object.keys(releaseOf(outcome))).toEqual(["state"]);
  expect(outcome.result.error).not.toHaveProperty("expected");
  expect(fixture.commands.some((args) => args[3] === "version" || args[1] === "--revision")).toBe(false);
  expect(fixture.containers.size).toBe(0);
});

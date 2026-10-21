import { expect, spyOn, test } from "bun:test";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands, type SetupHost, type HostCommandResult } from "../../src/setup/commands.ts";

const image = "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e";
const policy = {
  id: "darwin-15.7.7-x64-desktop-4.96.1",
  host: { system: "darwin", distribution: null, release: "15.7.7", architecture: "x64" },
  bun: "1.4.3",
  cli: { version: "29.9.2", commit: "a82e528" },
  engine: { version: "29.9.2", commit: "0367cbe", kernel: "7.0.14-linuxkit", platform: "Docker Desktop 4.96.1 (244132)" },
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
  const info = { ID: "fixture-engine-identity", KernelVersion: "7.0.14-linuxkit", ServerVersion: "29.9.2", OSType: "linux", Architecture: "x86_64" };
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

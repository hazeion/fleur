import { expect, test } from "bun:test";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";

test("doctor reports missing Docker with recovery without modifying the machine", async () => {
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({
    host: async () => ({ system: "darwin", architecture: "x64", translated: false, release: "15.7.9" }),
    run: async () => ({ status: "missing", stdout: "", stderr: "" }),
  }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result).toMatchObject({ command: "doctor", ok: false, error: { code: "PREREQUISITE_UNAVAILABLE", actions: [{ command: "fleur setup" }] }, data: { components: { cli: { state: "missing" } } } });
});

test("doctor rejects a translated Intel process before touching Docker", async () => {
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({
    host: async () => ({ system: "darwin", architecture: "x64", translated: true, release: "15.7.9" }),
    run: async () => { throw new Error("Docker must not run on an unverified native host"); },
  }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.error).toMatchObject({ code: "PREREQUISITE_UNAVAILABLE", expected: "native execution", actual: "translated execution" });
});

test("doctor refuses an effective remote context without contacting its daemon", async () => {
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({
    host: async () => ({ system: "darwin", architecture: "x64", translated: false, release: "15.7.9" }),
    run: async (args) => {
      if (args.join(" ") === "docker --version") return { status: "completed", exitCode: 0, stdout: "Docker version 28.0.4, build b8034c0", stderr: "" };
      if (args.join(" ") === "docker context show") return { status: "completed", exitCode: 0, stdout: "production\n", stderr: "" };
      if (args.join(" ") === "docker context inspect production --format {{json .Endpoints.docker}}") return { status: "completed", exitCode: 0, stdout: '{"Host":"ssh://some-user@private-host"}', stderr: "" };
      throw new Error("Unexpected daemon or mutation operation");
    },
  }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.error).toMatchObject({ code: "PREREQUISITE_UNAVAILABLE", actual: "remote endpoint" });
  expect(JSON.stringify(outcome)).not.toContain("private-host");
});

test("doctor distinguishes denied daemon access from missing software and never installs", async () => {
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({
    host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu" }),
    run: async (args) => {
      const command = args.join(" ");
      if (command === "docker --version") return { status: "completed", exitCode: 0, stdout: "Docker version 28.0.4, build b8034c0", stderr: "" };
      if (command === "docker context show") return { status: "completed", exitCode: 0, stdout: "default\n", stderr: "" };
      if (command.startsWith("docker context inspect")) return { status: "completed", exitCode: 0, stdout: '{"Host":"unix:///var/run/docker.sock"}', stderr: "" };
      if (command === "docker --host unix:///var/run/docker.sock info --format {{json .}}") return { status: "completed", exitCode: 1, stdout: "", stderr: "permission denied while trying to connect" };
      if (command === "docker --host unix:///var/run/docker.sock compose version --short") return { status: "completed", exitCode: 0, stdout: "5.6.0", stderr: "" };
      throw new Error("Unexpected mutation or smoke operation before daemon access");
    },
  }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.data).toMatchObject({ components: { cli: { state: "ready" }, daemon: { state: "denied" }, compose: { state: "ready" }, smoke: { state: "not-checked" } } });
});

test("doctor consumes one operation deadline rather than restarting it for every probe", async () => {
  const outcome = await runCli(["doctor", "--json", "--timeout", "0.01"], { cwd: "/tmp", handlers: setupCommands({
    host: async () => { await Bun.sleep(20); return { system: "darwin", architecture: "x64", translated: false, release: "15.7.9" }; },
    run: async () => { throw new Error("The operation deadline already expired"); },
  }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.error?.code).toBe("READINESS_TIMEOUT");
});

test("doctor uses a local context over DOCKER_HOST when DOCKER_CONTEXT is explicit", async () => {
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({
    environment: { DOCKER_CONTEXT: "local", DOCKER_HOST: "ssh://unrelated-host" },
    host: async () => ({ system: "darwin", architecture: "x64", translated: false, release: "15.7.9" }),
    run: async (args) => {
      const command = args.join(" ");
      if (command === "docker --version") return { status: "completed", exitCode: 0, stdout: "Docker version 28.0.4", stderr: "" };
      if (command === "docker context show") return { status: "completed", exitCode: 0, stdout: "local", stderr: "" };
      if (command.startsWith("docker context inspect local")) return { status: "completed", exitCode: 0, stdout: '{"Host":"unix:///tmp/fixture-docker.sock"}', stderr: "" };
      if (command.startsWith("docker --host unix:///tmp/fixture-docker.sock info")) return { status: "completed", exitCode: 1, stdout: "", stderr: "daemon unavailable" };
      if (command.endsWith("compose version --short")) return { status: "completed", exitCode: 0, stdout: "5.6.0", stderr: "" };
      throw new Error("Endpoint must stay frozen to the selected local context");
    },
  }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.data).toMatchObject({ components: { daemon: { state: "unavailable" }, compose: { state: "ready" } } });
  expect(JSON.stringify(outcome)).not.toContain("unrelated-host");
});

function localHost(extra: (args: readonly string[]) => Promise<import("../../src/setup/commands.ts").HostCommandResult>): import("../../src/setup/commands.ts").SetupHost {
  return {
    host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu" }),
    run: async (args) => {
      const command = args.join(" ");
      const output = command === "docker --version" ? "Docker version 28.0.4" : command === "docker context show" ? "default" : command.startsWith("docker context inspect") ? '{"Host":"unix:///var/run/docker.sock"}' : command.endsWith("info --format {{json .}}") ? '{"ServerVersion":"28.0.4","OSType":"linux","Architecture":"x86_64"}' : command.endsWith("compose version --short") ? "5.6.0" : null;
      return output === null ? extra(args) : { status: "completed", exitCode: 0, stdout: output, stderr: "" };
    },
  };
}

test("doctor reports required smoke image acquisition explicitly without pulling it", async () => {
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(localHost(async (args) => {
    if (args.includes("image") && args.includes("inspect")) return { status: "completed", exitCode: 1, stdout: "", stderr: "No such image" };
    throw new Error("Doctor must not pull an absent smoke image");
  })) });
  expect(outcome.exitCode).toBe(3);
  expect(outcome.result).toMatchObject({ error: { code: "AUTHORITY_REQUIRED" }, data: { components: { smoke: { state: "image-required" } } } });
});

test("doctor runs an owned pinned smoke container and reports cleanup without claiming unverified platform support", async () => {
  let name = "";
  let owner = "";
  const id = "a".repeat(64);
  const imageId = "sha256:" + "b".repeat(64);
  const image = "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e";
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(localHost(async (args) => {
    let stdout = "";
    if (args.includes("image") && args.includes("inspect")) stdout = JSON.stringify({ Id: imageId, RepoDigests: [image], Architecture: "amd64", Os: "linux" });
    else if (args.includes("create")) { name = args[args.indexOf("--name") + 1]!; owner = args[args.indexOf("--label") + 1]!.split("=")[1]!; stdout = id; }
    else if (args.includes("inspect") && args.includes(id)) stdout = JSON.stringify({ Id: id, Name: "/" + name, Image: imageId, Config: { Labels: { "dev.fleur.doctor-owner": owner } }, State: { Running: false, ExitCode: 0, FinishedAt: "2026-10-19T00:00:00Z" } });
    else if (args.includes("start") && args.includes(id)) stdout = "fleur-doctor-smoke";
    else if (args.includes("rm") && args.includes(id)) stdout = id;
    else throw new Error("Unexpected command or foreign resource operation");
    return { status: "completed", exitCode: 0, stdout, stderr: "" };
  })) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.data).toMatchObject({ components: { smoke: { state: "ready", cleanup: true }, release: { state: "unverified" } } });
});

test("production doctor runs through Bun with an empty executable PATH and returns a safe missing-tool result", async () => {
  const program = `import { runCli } from ${JSON.stringify(new URL("../../src/cli/main.ts", import.meta.url).pathname)}; import { setupCommands } from ${JSON.stringify(new URL("../../src/setup/commands.ts", import.meta.url).pathname)}; const result = await runCli(["doctor", "--json"], {cwd:"/tmp",handlers:setupCommands()}); console.log(JSON.stringify(result));`;
  const child = Bun.spawn([process.execPath, "-e", program], { env: { PATH: "/nonexistent", HOME: "/tmp" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({ exitCode: 4, result: { command: "doctor", error: { code: "PREREQUISITE_UNAVAILABLE" } } });
});

test("production doctor honors DOCKER_CONTEXT before freezing the selected endpoint", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "fleur-doctor-context-"));
  try {
    await writeFile(join(directory, "docker"), '#!/bin/sh\ncase "$*" in\n"--version") printf "Docker version 28.0.4";;\n"context show") printf "%s" "${DOCKER_CONTEXT:-default}";;\n"context inspect remote --format {{json .Endpoints.docker}}") printf \'{"Host":"ssh://private-host"}\';;\n*) printf \'{"Host":"unix:///tmp/local.sock"}\';;\nesac\n', { mode: 0o755 });
    const program = `import { runCli } from ${JSON.stringify(new URL("../../src/cli/main.ts", import.meta.url).pathname)}; import { setupCommands } from ${JSON.stringify(new URL("../../src/setup/commands.ts", import.meta.url).pathname)}; console.log(JSON.stringify(await runCli(["doctor"],{cwd:"/tmp",handlers:setupCommands()})));`;
    const child = Bun.spawn([process.execPath, "-e", program], { env: { PATH: directory, HOME: directory, DOCKER_CONTEXT: "remote" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ exitCode: 4, result: { error: { actual: "remote endpoint" } } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("noninteractive setup returns a precise human action without granting or installing", async () => {
  const outcome = await runCli(["setup", "--json"], { cwd: "/tmp", handlers: setupCommands({
    host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu" }),
    run: async () => ({ status: "missing", stdout: "", stderr: "" }),
  }) });
  expect(outcome.exitCode).toBe(3);
  expect(outcome.result).toMatchObject({ command: "setup", ok: false, error: { code: "HUMAN_ACTION_REQUIRED" }, data: { plan: { method: "docker-official-apt", verified: false }, grantsCreated: false } });
});

test("grant inspection is read-only and reports no grants for a fresh per-user state directory", async () => {
  const { mkdtemp, rm, readdir } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-grants-");
  try {
    const host = { ...localHost(async () => { throw new Error("Grant inspection must not invoke Docker"); }), stateDirectory: directory + "/state" };
    const outcome = await runCli(["setup", "grants", "list", "--json"], { cwd: "/tmp", handlers: setupCommands(host) });
    expect(outcome).toMatchObject({ exitCode: 0, result: { command: "setup grants list", data: { grants: [] } } });
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("revoking a remembered grant persists and is visible through grant inspection", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-revoke-");
  const id = "12345678-1234-1234-1234-123456789abc";
  try {
    await writeFile(directory + "/grants.json", JSON.stringify({ formatVersion: 1, grants: [{ id, action: "install", method: "docker-official-apt", target: "ubuntu24.04-x64", planChecksum: "a".repeat(64), machine: "b".repeat(64), user: process.getuid!(), mode: "remembered", revoked: false }] }), { mode: 0o600 });
    const handlers = setupCommands({ ...localHost(async () => { throw new Error("Revocation must not invoke Docker"); }), stateDirectory: directory });
    const revoked = await runCli(["setup", "grants", "revoke", id, "--json"], { cwd: "/tmp", handlers });
    expect(revoked).toMatchObject({ exitCode: 0, result: { data: { id, revoked: true } } });
    const inspected = await runCli(["setup", "grants", "list", "--json"], { cwd: "/tmp", handlers });
    expect(inspected.result.data).toMatchObject({ grants: [{ id, revoked: true }] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("doctor reports a timed-out executable as READINESS_TIMEOUT", async () => {
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({
    host: async () => ({ system: "darwin", architecture: "x64", translated: false, release: "15.7.9" }),
    run: async () => ({ status: "timeout", stdout: "", stderr: "" }),
  }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.error?.code).toBe("READINESS_TIMEOUT");
});

test("interactive human image-acquisition permission is scoped and remembered; setup re-probes rather than reinstalling", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-image-grant-");
  let present = false;
  try {
    const host = localHost(async (args) => {
      if (args.includes("pull")) { present = true; return { status: "completed", exitCode: 0, stdout: "", stderr: "" }; }
      if (args.includes("image") && args.includes("inspect")) return { status: "completed", exitCode: present ? 0 : 1, stdout: present ? '{"Id":"invalid-image-fixture"}' : "", stderr: "" };
      throw new Error("No other machine mutation is authorized");
    });
    const handlers = setupCommands({ ...host, stateDirectory: directory, interactive: true, host: async () => ({ ...(await host.host()), machineId: "c".repeat(64) }), confirmHuman: async () => "remembered" });
    const first = await runCli(["setup"], { cwd: "/tmp", handlers });
    expect(first.result.data).toMatchObject({ setupAction: { action: "image-acquire", state: "completed" } });
    const grants = await runCli(["setup", "grants", "list", "--json"], { cwd: "/tmp", handlers });
    expect(grants.result.data).toMatchObject({ grants: [{ action: "image-acquire", method: "docker-digest-pull", mode: "remembered", revoked: false }] });
    const second = await runCli(["setup", "--json"], { cwd: "/tmp", handlers });
    expect(second.result.data).not.toHaveProperty("setupAction");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a once grant is consumed before a failed acquisition and cannot replay noninteractively", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-once-");
  let attempted = false;
  try {
    const host = localHost(async (args) => {
      if (args.includes("image") && args.includes("inspect")) return { status: "completed", exitCode: 1, stdout: "", stderr: "No such image" };
      if (args.includes("pull") && !attempted) { attempted = true; return { status: "completed", exitCode: 1, stdout: "", stderr: "registry download failed" }; }
      throw new Error("Consumed once authority must not cause another pull");
    });
    const handlers = setupCommands({ ...host, stateDirectory: directory, interactive: true, host: async () => ({ ...(await host.host()), machineId: "d".repeat(64) }), confirmHuman: async () => "once" });
    const first = await runCli(["setup"], { cwd: "/tmp", handlers });
    expect(first).toMatchObject({ exitCode: 1, result: { data: { setupAction: { state: "failed" } } } });
    const listed = await runCli(["setup", "grants", "list", "--json"], { cwd: "/tmp", handlers });
    const grants = (listed.result.data as { grants: { id: string; mode: string; revoked: boolean }[] }).grants;
    expect(grants).toMatchObject([{ mode: "once", revoked: true }]);
    const replay = await runCli(["setup", "--grant", grants[0]!.id, "--json"], { cwd: "/tmp", handlers });
    expect(replay).toMatchObject({ exitCode: 3, result: { error: { code: "AUTHORITY_REQUIRED" } } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("JSON setup never creates or broadens grants even if an interactive capability exists", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-no-json-grant-");
  try {
    const host = localHost(async (args) => {
      if (args.includes("image") && args.includes("inspect")) return { status: "completed", exitCode: 1, stdout: "", stderr: "No such image" };
      throw new Error("Unauthorized image acquisition");
    });
    const handlers = setupCommands({ ...host, stateDirectory: directory, interactive: true, host: async () => ({ ...(await host.host()), machineId: "c".repeat(64) }), confirmHuman: async () => { throw new Error("JSON cannot open human confirmation"); } });
    const outcome = await runCli(["setup", "--json"], { cwd: "/tmp", handlers });
    expect(outcome).toMatchObject({ exitCode: 3, result: { data: { grantsCreated: false } } });
    const listed = await runCli(["setup", "grants", "list", "--json"], { cwd: "/tmp", handlers });
    expect(listed.result.data).toEqual({ grants: [] });
    const forged = await runCli(["setup", "--yes", "--json"], { cwd: "/tmp", handlers });
    expect(forged.exitCode).toBe(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a timed-out smoke creation still removes the nonce-owned container and reports actual cleanup", async () => {
  const id = "e".repeat(64);
  const imageId = "sha256:" + "f".repeat(64);
  const image = "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e";
  let name = "";
  let owner = "";
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands(localHost(async (args) => {
    if (args.includes("image") && args.includes("inspect")) return { status: "completed", exitCode: 0, stdout: JSON.stringify({ Id: imageId, RepoDigests: [image], Architecture: "amd64", Os: "linux" }), stderr: "" };
    if (args.includes("create")) { name = args[args.indexOf("--name") + 1]!; owner = args[args.indexOf("--label") + 1]!.split("=")[1]!; return { status: "timeout", stdout: "", stderr: "" }; }
    if (args.includes("inspect") && (args.includes(name) || args.includes(id))) return { status: "completed", exitCode: 0, stdout: JSON.stringify({ Id: id, Name: "/" + name, Image: imageId, Config: { Labels: { "dev.fleur.doctor-owner": owner } }, State: { Running: false, ExitCode: 0, FinishedAt: "2026-10-19T00:00:00Z" } }), stderr: "" };
    if (args.includes("rm") && args.includes(id)) return { status: "completed", exitCode: 0, stdout: id, stderr: "" };
    throw new Error("A timed-out creation cannot start application code");
  })) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.data).toMatchObject({ components: { smoke: { state: "failed", cleanup: true } } });
});

test("doctor rejects Arch ARM before any Docker operation", async () => {
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({
    host: async () => ({ system: "linux", architecture: "arm64", translated: false, release: "rolling", distribution: "arch" }),
    run: async () => { throw new Error("Arch ARM is outside the supported target matrix"); },
  }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.error).toMatchObject({ code: "PREREQUISITE_UNAVAILABLE", actual: "unsupported platform" });
});

test("production setup identifies this machine but piped execution still cannot authorize acquisition", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-production-authority-");
  try {
    await writeFile(directory + "/docker", '#!/bin/sh\ncase "$*" in\n"--version") printf "Docker version 28.0.4";;\n"context show") printf "default";;\n"context inspect default --format {{json .Endpoints.docker}}") printf \'{"Host":"unix:///tmp/fleur-fixture.sock"}\';;\n*"info --format {{json .}}") printf \'{"ServerVersion":"28.0.4","OSType":"linux","Architecture":"x86_64"}\';;\n*"compose version --short") printf "5.6.0";;\n*"image inspect"*) exit 1;;\n*) exit 90;;\nesac\n'.replace('"Architecture":"x86_64"', `"Architecture":"${process.arch === "arm64" ? "aarch64" : "x86_64"}"`), { mode: 0o755 });
    const program = `import { runCli } from ${JSON.stringify(new URL("../../src/cli/main.ts", import.meta.url).pathname)}; import { setupCommands } from ${JSON.stringify(new URL("../../src/setup/commands.ts", import.meta.url).pathname)}; console.log(JSON.stringify(await runCli(["setup","--json"],{cwd:${JSON.stringify(directory)},handlers:setupCommands()})));`;
    const child = Bun.spawn([process.execPath, "-e", program], { env: { PATH: directory, HOME: directory, FLEUR_GRANT: "yes" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ exitCode: 3, result: { error: { code: "AUTHORITY_REQUIRED" }, data: { grantsCreated: false } } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("doctor rejects malformed daemon identity instead of running a smoke container", async () => {
  const base = localHost(async () => { throw new Error("No smoke may run without verified daemon identity"); });
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({ ...base, run: async (args, timeout) => args.includes("info") ? { status: "completed", exitCode: 0, stdout: '{"ServerVersion":"28.0.4","OSType":"not-linux"}', stderr: "" } : base.run(args, timeout) }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.data).toMatchObject({ components: { daemon: { state: "incompatible" }, smoke: { state: "not-checked" } } });
});

test("production doctor deadline closes inherited output pipes instead of waiting for a plugin descendant", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-output-deadline-");
  try {
    await writeFile(directory + "/docker", '#!/bin/sh\n/bin/sleep 4 &\nprintf "Docker version 28.0.4"\nexit 0\n', { mode: 0o755 });
    const program = `import { runCli } from ${JSON.stringify(new URL("../../src/cli/main.ts", import.meta.url).pathname)}; import { setupCommands } from ${JSON.stringify(new URL("../../src/setup/commands.ts", import.meta.url).pathname)}; console.log(JSON.stringify(await runCli(["doctor","--json","--timeout","0.1"],{cwd:"/tmp",handlers:setupCommands()})));`;
    const start = performance.now();
    const child = Bun.spawn([process.execPath, "-e", program], { env: { PATH: directory, HOME: directory }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ exitCode: 4, result: { error: { code: "READINESS_TIMEOUT" } } });
    expect(performance.now() - start).toBeLessThan(3000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("filesystem durability failure blocks authorized image acquisition instead of treating renamed grants as durable", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-grant-durability-");
  let pulled = false;
  try {
    const host = localHost(async (args) => {
      if (args.includes("image") && args.includes("inspect")) return { status: "completed", exitCode: 1, stdout: "", stderr: "No such image" };
      if (args.includes("pull")) { pulled = true; return { status: "completed", exitCode: 0, stdout: "", stderr: "" }; }
      throw new Error("Unexpected external mutation");
    });
    const handlers = setupCommands({ ...host, stateDirectory: directory, interactive: true, host: async () => ({ ...(await host.host()), machineId: "a".repeat(64) }), confirmHuman: async () => "once", syncDirectory: async () => { throw Object.assign(new Error("Simulated filesystem durability error"), { code: "EIO" }); } });
    const outcome = await runCli(["setup"], { cwd: "/tmp", handlers });
    expect(outcome).toMatchObject({ exitCode: 5, result: { error: { code: "RECOVERY_REQUIRED" } } });
    expect(pulled).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent setup cannot race a confirmation and a released lock permits a fresh reprobe", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-setup-contention-");
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const host = localHost(async (args) => {
    if (args.includes("image") && args.includes("inspect")) return { status: "completed", exitCode: 1, stdout: "", stderr: "No such image" };
    throw new Error("No concurrent setup may acquire an image without permission");
  });
  const handlers = setupCommands({ ...host, stateDirectory: directory, interactive: true, host: async () => ({ ...(await host.host()), machineId: "e".repeat(64) }), confirmHuman: async () => { entered(); await gate; return "deny"; } });
  const first = runCli(["setup"], { cwd: "/tmp", handlers });
  try {
    await Promise.race([ready, Bun.sleep(2000).then(() => { throw new Error("Setup confirmation was not reached"); })]);
    const competing = await runCli(["setup", "--json"], { cwd: "/tmp", handlers });
    expect(competing).toMatchObject({ exitCode: 5, result: { error: { code: "MAINTENANCE_BUSY" } } });
    release();
    expect(await first).toMatchObject({ exitCode: 3, result: { error: { code: "AUTHORITY_REQUIRED" } } });
    const retry = await runCli(["setup", "--json"], { cwd: "/tmp", handlers });
    expect(retry).toMatchObject({ exitCode: 3, result: { error: { code: "AUTHORITY_REQUIRED" } } });
  } finally { release(); await first; await rm(directory, { recursive: true, force: true }); }
});

test("remembered acquisition authority cannot follow a different machine or endpoint and revocation blocks reuse", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-grant-scope-");
  let initial = true;
  try {
    const fixture = localHost(async (args) => {
      if (args.includes("image") && args.includes("inspect")) return { status: "completed", exitCode: 1, stdout: "", stderr: "No such image" };
      if (args.includes("pull") && initial) { initial = false; return { status: "completed", exitCode: 1, stdout: "", stderr: "fixture acquisition failure" }; }
      throw new Error("Mismatched or revoked permission cannot acquire an image");
    });
    const base = { ...fixture, stateDirectory: directory, interactive: true, host: async () => ({ ...(await fixture.host()), machineId: "1".repeat(64) }), confirmHuman: async () => "remembered" as const };
    expect((await runCli(["setup"], { cwd: "/tmp", handlers: setupCommands(base) })).exitCode).toBe(1);
    const listed = await runCli(["setup", "grants", "list", "--json"], { cwd: "/tmp", handlers: setupCommands(base) });
    const id = (listed.result.data as { grants: { id: string }[] }).grants[0]!.id;
    const otherMachine = { ...base, host: async () => ({ ...(await fixture.host()), machineId: "2".repeat(64) }) };
    expect((await runCli(["setup", "--grant", id, "--json"], { cwd: "/tmp", handlers: setupCommands(otherMachine) })).exitCode).toBe(3);
    const otherEndpoint = { ...base, environment: { DOCKER_HOST: "unix:///tmp/other-fixture.sock" } };
    expect((await runCli(["setup", "--grant", id, "--json"], { cwd: "/tmp", handlers: setupCommands(otherEndpoint) })).exitCode).toBe(3);
    expect((await runCli(["setup", "grants", "revoke", id, "--json"], { cwd: "/tmp", handlers: setupCommands(base) })).exitCode).toBe(0);
    expect((await runCli(["setup", "--grant", id, "--json"], { cwd: "/tmp", handlers: setupCommands(base) })).exitCode).toBe(3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("doctor rejects control characters in a local endpoint before displaying or contacting it", async () => {
  const fixture = localHost(async () => { throw new Error("Malformed local endpoints cannot reach image operations"); });
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({ ...fixture, environment: { DOCKER_HOST: "unix:///tmp/socket\nmisleading-confirmation" } }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.error).toMatchObject({ code: "PREREQUISITE_UNAVAILABLE", actual: "malformed endpoint" });
  expect(JSON.stringify(outcome)).not.toContain("misleading-confirmation");
});

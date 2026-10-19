import { expect, test } from "bun:test";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";

test("missing Docker exposes repository configuration separately from package installation", async () => {
  const calls: string[][] = [];
  const outcome = await runCli(["setup", "--json"], { cwd: "/tmp", handlers: setupCommands({
    host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
    run: async (args) => { calls.push([...args]); return { status: "missing", stdout: "", stderr: "" }; },
  }) });
  expect(outcome.exitCode).toBe(3);
  expect(outcome.result.data).toMatchObject({ plan: { steps: [
    { action: "repository-configuration", method: "docker-official-apt", state: "unverified" },
    { action: "install", method: "docker-official-apt", state: "unverified", requires: ["service-start", "service-enable"] },
  ] } });
  expect(calls).toEqual([["docker", "--version"]]);
});

test("verified apt installation requires separate service side-effect authority before invoking apt", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "fleur-native-"));
  const calls: string[][] = [];
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: "/tmp", handlers: setupCommands({
      stateDirectory: join(directory, "state"),
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args) => { calls.push([...args]); return args[0] === "docker" ? { status: "missing", stdout: "", stderr: "" } : { status: "completed", exitCode: 1, stdout: "", stderr: "" }; },
    }, [{ method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64", repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages: { "docker-ce": "5:29.9.1-1~ubuntu.24.04~noble", "docker-ce-cli": "5:29.9.1-1~ubuntu.24.04~noble", "containerd.io": "2.4.2-2~ubuntu.24.04~noble", "docker-buildx-plugin": "0.33.0-1~ubuntu.24.04~noble", "docker-compose-plugin": "5.6.0-1~ubuntu.24.04~noble" } }]) });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(outcome.result.data).toMatchObject({ plan: { verified: true, requiredAuthorities: ["install", "configuration", "docker-access", "service-start", "service-enable"] } });
    expect(calls.some((args) => args[0] === "apt-get" || args[0] === "sudo")).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("authorized apt setup installs exact missing packages only after repository and simulation checks", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "fleur-native-"));
  const packages = { "docker-ce": "5:29.9.1-1~ubuntu.24.04~noble", "docker-ce-cli": "5:29.9.1-1~ubuntu.24.04~noble", "containerd.io": "2.4.2-2~ubuntu.24.04~noble", "docker-buildx-plugin": "0.33.0-1~ubuntu.24.04~noble", "docker-compose-plugin": "5.6.0-1~ubuntu.24.04~noble" };
  const calls: string[][] = [];
  const authorized: string[] = [];
  let installed = false;
  try {
    const outcome = await runCli(["setup"], { cwd: "/tmp", handlers: setupCommands({
      stateDirectory: join(directory, "state"), interactive: true,
      confirmHuman: async ({ action }) => { authorized.push(action); return "once"; },
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args) => {
        calls.push([...args]);
        const done = (stdout = "", exitCode = 0) => ({ status: "completed" as const, exitCode, stdout, stderr: "" });
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "dpkg-query") return installed ? done(Object.entries(packages).map(([name, version]) => `${name}=${version}`).join("\n")) : done("", 1);
        if (args[0] === "cat") return done("Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n");
        if (args[0] === "gpg") return done("pub:-:4096:1:PRIMARY:0:0::-:::scSC:\nfpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\n");
        if (args[0] === "apt-get") return done(Object.entries(packages).map(([name, version]) => `Inst ${name} (${version} Docker:stable [amd64])`).join("\n"));
        if (args[0] === "sudo") { expect(authorized).toEqual(["install", "configuration", "docker-access", "service-start", "service-enable"]); installed = true; return done(); }
        throw new Error("Unexpected native operation");
      },
    }, [{ method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64", repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages }]) });
    expect(outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" }, resumable: true });
    expect(calls.find((args) => args[0] === "sudo")).toEqual(["sudo", "-n", "apt-get", "-o", "Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.sources", "-o", "Dir::Etc::sourceparts=-", "--assume-yes", "--no-remove", "--no-upgrade", "install", ...Object.entries(packages).map(([name, version]) => `${name}=${version}`)]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native setup preserves an existing conflicting package without requesting grants or invoking apt", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "fleur-native-conflict-"));
  const calls: string[][] = [];
  try {
    const outcome = await runCli(["setup"], { cwd: "/tmp", handlers: setupCommands({
      stateDirectory: join(directory, "state"), interactive: true,
      confirmHuman: async () => { throw new Error("Conflicts cannot be authorized away"); },
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args) => {
        calls.push([...args]);
        return args[0] === "docker" ? { status: "missing", stdout: "", stderr: "" } : { status: "completed", exitCode: 0, stdout: "containerd.io=1.0.0\n", stderr: "" };
      },
    }, [{ method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64", repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages: { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" } }]) });
    expect(outcome.exitCode).toBe(4);
    expect(calls.map((args) => args[0])).toEqual(["docker", "dpkg-query"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an explicit unknown native grant never opens a new human permission prompt", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "fleur-native-grant-"));
  let prompts = 0;
  try {
    const outcome = await runCli(["setup", "--grant", "00000000-0000-0000-0000-000000000000"], { cwd: "/tmp", handlers: setupCommands({
      stateDirectory: join(directory, "state"), interactive: true,
      confirmHuman: async () => { prompts++; return "once"; },
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args) => args[0] === "docker" ? { status: "missing", stdout: "", stderr: "" } : { status: "completed", exitCode: 1, stdout: "", stderr: "" },
    }, [{ method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64", repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages: { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" } }]) });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(prompts).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function nativeReviewScenario(mode: "extra-key" | "extra-configuration" | "selected-once") {
  const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const directory = await mkdtemp("/tmp/fleur-native-review-");
  const packages = { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" };
  const profile = { method: "docker-official-apt" as const, verified: true as const, distribution: "ubuntu" as const, release: "24.04", architecture: "x64" as const, repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages };
  const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify(profile), "hex");
  const target = `Docker ubuntu 24.04 x64 profile ${checksum}`;
  const grants = ["install", "configuration", "docker-access", "service-start", "service-enable"].map((action) => ({ id: crypto.randomUUID(), action, method: profile.method, target, planChecksum: checksum, machine: "a".repeat(64), user: process.getuid!(), mode: "once", revoked: false }));
  const selected = grants[0]!.id;
  if (mode === "selected-once") grants.unshift({ ...grants[0]!, id: crypto.randomUUID(), mode: "remembered" });
  let installs = 0;
  let installed = false;
  try {
    await writeFile(join(directory, "grants.json"), JSON.stringify({ formatVersion: 1, grants }), { mode: 0o600 });
    const outcome = await runCli(mode === "selected-once" ? ["setup", "--grant", selected, "--json"] : ["setup", "--json"], { cwd: "/tmp", handlers: setupCommands({
      stateDirectory: directory,
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args) => {
        const done = (stdout = "", exitCode = 0) => ({ status: "completed" as const, exitCode, stdout, stderr: "" });
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "dpkg-query") return installed ? done(Object.entries(packages).map(([name, version]) => `${name}=${version}`).join("\n")) : done("", 1);
        if (args[0] === "cat") return done("Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n");
        if (args[0] === "gpg") return done("pub:-:4096:1:PRIMARY:0:0::-:::scSC:\nfpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\nsub:-:4096:1:BOUND:0:0:::::s:\nfpr:::::::::D3306A018370199E527AE7997EA0A9C3F273FCD8:\n" + (mode === "extra-key" ? "pub:-:4096:1:OTHER:0:0::-:::scSC:\nfpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:\n" : ""));
        if (args[0] === "apt-get") return done(Object.entries(packages).flatMap(([name, version]) => [`Inst ${name} (${version} Docker:stable [amd64])`, `Conf ${name} (${version} Docker:stable [amd64])`]).join("\n") + (mode === "extra-configuration" ? "\nConf unrelated-existing-service (1 vendor [amd64])\n" : ""));
        if (args[0] === "sudo") { installs++; installed = true; return done(); }
        throw new Error("Unexpected native operation");
      },
    }, [profile]) });
    const after = JSON.parse(await readFile(join(directory, "grants.json"), "utf8")) as { grants: { id: string; revoked: boolean }[] };
    return { outcome, installs, selectedRevoked: after.grants.find((grant) => grant.id === selected)?.revoked };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("native apt rejects an unreviewed second primary key while allowing the reviewed key's bound subkey", async () => {
  const result = await nativeReviewScenario("extra-key");
  expect(result.installs).toBe(0);
  expect(result.selectedRevoked).toBe(false);
});
test("native apt rejects configuration of an unrelated existing package", async () => {
  const result = await nativeReviewScenario("extra-configuration");
  expect(result.installs).toBe(0);
  expect(result.selectedRevoked).toBe(false);
});
test("the explicitly selected once installation grant is consumed even when remembered authority sorts first", async () => {
  const result = await nativeReviewScenario("selected-once");
  expect(result.installs).toBe(1);
  expect(result.selectedRevoked).toBe(true);
});

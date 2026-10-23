import { aptFixtureArtifacts, aptArtifactProtocol, aptGuardProtocol, aptFixturePackageTargets, aptHealthProtocol } from "./fixtures/apt-artifacts.ts";
import { expect, test } from "bun:test";
import { runCli } from "../../src/cli/main.ts";
import { dockerRepositoryKey } from "../../src/setup/docker-key.ts";
import { setupCommands } from "../../src/setup/commands.ts";

test("missing Docker exposes repository configuration separately from package installation", async () => {
  const calls: string[][] = [];
  const outcome = await runCli(["setup", "--json"], { cwd: "/tmp", handlers: setupCommands({
    host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", bootId: "11111111-1111-4111-8111-111111111111", machineId: "a".repeat(64) }),
    run: async (args) => { calls.push([...args]); return { status: "missing", stdout: "", stderr: "" }; },
  }, []) });
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
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", bootId: "11111111-1111-4111-8111-111111111111", machineId: "a".repeat(64) }),
      run: async (args) => { calls.push([...args]); return args[0] === "docker" ? { status: "missing", stdout: "", stderr: "" } : { status: "completed", exitCode: 1, stdout: "", stderr: "" }; },
    }, [{ method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64", repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages: { "docker-ce": "5:29.9.1-1~ubuntu.24.04~noble", "docker-ce-cli": "5:29.9.1-1~ubuntu.24.04~noble", "containerd.io": "2.4.2-2~ubuntu.24.04~noble", "docker-buildx-plugin": "0.33.0-1~ubuntu.24.04~noble", "docker-compose-plugin": "5.6.0-1~ubuntu.24.04~noble" }, artifacts: aptFixtureArtifacts({ "docker-ce": "5:29.9.1-1~ubuntu.24.04~noble", "docker-ce-cli": "5:29.9.1-1~ubuntu.24.04~noble", "containerd.io": "2.4.2-2~ubuntu.24.04~noble", "docker-buildx-plugin": "0.33.0-1~ubuntu.24.04~noble", "docker-compose-plugin": "5.6.0-1~ubuntu.24.04~noble" }) }]) });
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
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", bootId: "11111111-1111-4111-8111-111111111111", machineId: "a".repeat(64) }),
      run: async (args, _timeout, context) => {
        calls.push([...args]);
        const health = aptHealthProtocol(args, installed ? Object.entries(packages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`) : []);
        if (health) return health;
        const artifact = await aptArtifactProtocol(args, context, packages);
        if (artifact) return artifact;
        const done = (stdout = "", exitCode = 0) => ({ status: "completed" as const, exitCode, stdout, stderr: "" });
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "dpkg-query") return installed ? done(Object.entries(packages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`).join("\n")) : done("", 1);
        if (args[0] === "stat") return done(args.at(-1)?.endsWith("docker.asc") || args.at(-1)?.endsWith("docker.sources") ? "regular file|0|644|1\n" : "directory|0|755|2\n");
        if (args[0] === "cat" && args.at(-1)?.endsWith("docker.asc")) return done(dockerRepositoryKey);
        if (args[0] === "cat") return done("Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n");
        if (args[0] === "gpg") return done("pub:-:4096:1:PRIMARY:0:0::-:::scSC:\nfpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\n");
        if (args[0] === "apt-cache") return done(Object.entries(packages).map(([name, version]) => `Package: ${name}\nVersion: ${version}\n`).join("\n"));
        if (args[0] === "apt-get") return done(Object.entries(packages).map(([name, version]) => `Inst ${name} (${version} Docker:stable [amd64])`).join("\n"));
        if (args[0] === "sudo" && args.includes("--simulate")) return done(aptFixturePackageTargets(args, packages).map((entry) => { const [name, version] = entry.split("="); return `Inst ${name} (${version} Docker:stable [amd64])`; }).join("\n"));
        if (args[0] === "sudo") { expect(authorized).toEqual(["install", "configuration", "docker-access", "service-start", "service-enable"]); const result = await aptGuardProtocol(args, packages, []); if (result.exitCode === 0) installed = true; return result; }
        throw new Error("Unexpected native operation");
      },
    }, [{ method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64", repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages, artifacts: aptFixtureArtifacts(packages) }]) });
    expect(outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" }, resumable: true });
    const installation = calls.find((args) => args[0] === "sudo" && !args.includes("--simulate"))!;
    expect(installation.slice(0, 3)).toEqual(["sudo", "-n", "apt-get"]);
    expect(installation).toContain("--assume-yes"); expect(installation).toContain("--no-download");
    expect(installation).toContain("--no-remove"); expect(installation).toContain("--no-upgrade");
    expect(aptFixturePackageTargets(installation, packages)).toEqual(Object.entries(packages).map(([name, version]) => `${name}=${version}`));
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
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", bootId: "11111111-1111-4111-8111-111111111111", machineId: "a".repeat(64) }),
      run: async (args) => {
        calls.push([...args]);
        return args[0] === "docker" ? { status: "missing", stdout: "", stderr: "" } : { status: "completed", exitCode: 0, stdout: "containerd.io\t1.0.0\tinstalled\tok\n", stderr: "" };
      },
    }, [{ method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64", repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages: { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" }, artifacts: aptFixtureArtifacts({ "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" }) }]) });
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
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", bootId: "11111111-1111-4111-8111-111111111111", machineId: "a".repeat(64) }),
      run: async (args) => args[0] === "docker" ? { status: "missing", stdout: "", stderr: "" } : { status: "completed", exitCode: 1, stdout: "", stderr: "" },
    }, [{ method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64", repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages: { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" }, artifacts: aptFixtureArtifacts({ "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" }) }]) });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(prompts).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function nativeReviewScenario(mode: "extra-key" | "extra-configuration" | "selected-once" | "repo-missing" | "repo-create" | "repo-conflict" | "repo-race" | "repo-update-failure") {
  const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const directory = await mkdtemp("/tmp/fleur-native-review-");
  const packages = { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" };
  const profile = { method: "docker-official-apt" as const, verified: true as const, distribution: "ubuntu" as const, release: "24.04", architecture: "x64" as const, repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages, artifacts: aptFixtureArtifacts(packages) };
  const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify(profile), "hex");
  const target = `Docker ubuntu 24.04 x64 profile ${checksum}`;
  const grants = ["install", "configuration", "docker-access", "service-start", "service-enable"].map((action) => ({ id: crypto.randomUUID(), action, method: profile.method, target, planChecksum: checksum, machine: "a".repeat(64), user: process.getuid!(), mode: "once", revoked: false }));
  const selected = grants[0]!.id;
  if (mode === "selected-once") grants.unshift({ ...grants[0]!, id: crypto.randomUUID(), mode: "remembered" });
  let installs = 0;
  let installed = false;
  const protectedFiles = new Map<string, string>();
  if (mode === "repo-conflict") protectedFiles.set("/etc/apt/sources.list.d/docker.sources", "unrelated preexisting source\n");
  let indexUpdates = 0;
  try {
    await writeFile(join(directory, "grants.json"), JSON.stringify({ formatVersion: 1, grants }), { mode: 0o600 });
    const outcome = await runCli(mode === "selected-once" ? ["setup", "--grant", selected, "--json"] : ["repo-create", "repo-race", "repo-update-failure"].includes(mode) ? ["setup"] : ["setup", "--json"], { cwd: "/tmp", handlers: setupCommands({
      stateDirectory: directory,
      interactive: ["repo-create", "repo-race", "repo-update-failure"].includes(mode),
      confirmHuman: async ({ action }) => { expect(action).toBe("repository-configuration"); return "once"; },
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", bootId: "11111111-1111-4111-8111-111111111111", machineId: "a".repeat(64) }),
      run: async (args, _timeout, context) => {
        const done = (stdout = "", exitCode = 0) => ({ status: "completed" as const, exitCode, stdout, stderr: "" });
        const health = aptHealthProtocol(args, installed ? Object.entries(packages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`) : []);
        if (health) return health;
        const artifact = await aptArtifactProtocol(args, context, packages);
        if (artifact) return artifact;
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "dpkg-query") return installed ? done(Object.entries(packages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`).join("\n")) : done("", 1);
        if (args[0] === "stat") return args.at(-1) === "/etc" || args.at(-1) === "/etc/apt" || args.at(-1) === "/etc/apt/keyrings" || args.at(-1) === "/etc/apt/sources.list.d" ? done("directory|0|755|2\n") : (protectedFiles.has(args.at(-1)!) || !["repo-missing", "repo-create", "repo-race", "repo-update-failure", "repo-conflict"].includes(mode)) ? done("regular file|0|644|1\n") : { status: "completed", exitCode: 1, stdout: "", stderr: "No such file or directory" };
        if (args[0] === "cat" && protectedFiles.has(args.at(-1)!)) return done(protectedFiles.get(args.at(-1)!));
        if (args[0] === "cat" && ["repo-missing", "repo-create", "repo-race", "repo-update-failure", "repo-conflict"].includes(mode)) return { status: "completed", exitCode: 1, stdout: "", stderr: "No such file or directory" };
        if (args[0] === "cat" && args.at(-1)?.endsWith("docker.asc")) return done(dockerRepositoryKey + (mode === "extra-key" ? "\nunreviewed key bytes\n" : ""));
        if (args[0] === "cat") return done("Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n");
        if (args[0] === "apt-cache") return indexUpdates > 0 || !["repo-missing", "repo-create", "repo-race", "repo-update-failure", "repo-conflict"].includes(mode)
          ? done(Object.entries(packages).map(([name, version]) => `Package: ${name}\nVersion: ${version}\n`).join("\n")) : done("", 100);
        if (args[0] === "gpg") return done("pub:-:4096:1:PRIMARY:0:0::-:::scSC:\nfpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\nsub:-:4096:1:BOUND:0:0:::::s:\nfpr:::::::::D3306A018370199E527AE7997EA0A9C3F273FCD8:\n" + (mode === "extra-key" ? "pub:-:4096:1:OTHER:0:0::-:::scSC:\nfpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:\n" : ""));
        if (args[0] === "apt-get") return done(Object.entries(packages).flatMap(([name, version]) => [`Inst ${name} (${version} Docker:stable [amd64])`, `Conf ${name} (${version} Docker:stable [amd64])`]).join("\n") + (mode === "extra-configuration" ? "\nConf unrelated-existing-service (1 vendor [amd64])\n" : ""));
        if (args[0] === "sudo" && args[2] === "cp") {
          expect(args.slice(3, 7)).toEqual(["--no-clobber", "--no-target-directory", "--no-dereference", "--"]);
          if (mode === "repo-race" && args.at(-1)?.endsWith("docker.asc")) protectedFiles.set(args.at(-1)!, "racing existing bytes\n");
          if (!protectedFiles.has(args.at(-1)!)) protectedFiles.set(args.at(-1)!, await Bun.file(args.at(-2)!).text());
          return done();
        }
        if (args[0] === "sudo" && args.at(-1) === "update") {
          expect(args).toEqual(["sudo", "-n", "apt-get", "-o", "Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.sources", "-o", "Dir::Etc::sourceparts=-", "update"]);
          indexUpdates++; return done("", mode === "repo-update-failure" ? 1 : 0);
        }
        if (args[0] === "sudo" && args.includes("--simulate")) return done(aptFixturePackageTargets(args, packages).map((entry) => { const [name, version] = entry.split("="); return `Inst ${name} (${version} Docker:stable [amd64])`; }).join("\n"));
        if (args[0] === "sudo") { const result = await aptGuardProtocol(args, packages, []); if (result.exitCode === 0) { installs++; installed = true; } return result; }
        throw new Error("Unexpected native operation");
      },
    }, [profile]) });
    const after = JSON.parse(await readFile(join(directory, "grants.json"), "utf8")) as { grants: { id: string; revoked: boolean }[] };
    return { outcome, installs, indexUpdates, protectedFiles, selectedRevoked: after.grants.find((grant) => grant.id === selected)?.revoked };
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


test("missing apt repository requires its own authority even when every package side effect is authorized", async () => {
  const result = await nativeReviewScenario("repo-missing");
  expect(result.installs).toBe(0);
  expect(result.selectedRevoked).toBe(false);
  expect(result.outcome.result.error?.code).toBe("AUTHORITY_REQUIRED");
  expect(result.outcome.result.data).toMatchObject({ plan: { action: "repository-configuration", method: "docker-official-apt" } });
});


test("authorized native setup creates only exact repository files and refreshes only that repository before installation", async () => {
  const result = await nativeReviewScenario("repo-create");
  expect(result.installs).toBe(1);
  expect(result.indexUpdates).toBe(1);
  expect(Bun.CryptoHasher.hash("sha256", result.protectedFiles.get("/etc/apt/keyrings/docker.asc")!, "hex")).toBe("1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570");
  expect(result.protectedFiles.get("/etc/apt/sources.list.d/docker.sources")).toBe("Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n");
});


test("a differing existing repository source is preserved before any new file or package mutation", async () => {
  const result = await nativeReviewScenario("repo-conflict");
  expect(result.installs).toBe(0);
  expect(result.indexUpdates).toBe(0);
  expect([...result.protectedFiles]).toEqual([["/etc/apt/sources.list.d/docker.sources", "unrelated preexisting source\n"]]);
  expect(result.selectedRevoked).toBe(false);
});
test("a no-clobber repository copy that loses a race fails readback and preserves the winner", async () => {
  const result = await nativeReviewScenario("repo-race");
  expect(result.installs).toBe(0);
  expect(result.indexUpdates).toBe(0);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.protectedFiles.get("/etc/apt/keyrings/docker.asc")).toBe("racing existing bytes\n");
  expect(result.selectedRevoked).toBe(false);
});
test("a failed scoped repository refresh preserves completed files and does not consume package authority", async () => {
  const result = await nativeReviewScenario("repo-update-failure");
  expect(result.installs).toBe(0);
  expect(result.indexUpdates).toBe(1);
  expect(result.protectedFiles.size).toBe(2);
  expect(result.selectedRevoked).toBe(false);
  expect(result.outcome.result.data).toMatchObject({ resumable: true, setupAction: { action: "repository-configuration", state: "incomplete" } });
});

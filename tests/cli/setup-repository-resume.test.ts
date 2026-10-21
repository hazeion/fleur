import { aptFixtureArtifacts, aptArtifactProtocol, aptGuardProtocol, aptFixturePackageTargets, aptHealthProtocol } from "./fixtures/apt-artifacts.ts";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";

test("setup resumes a failed repository refresh with fresh authority without copying completed files again", async () => {
  const directory = await mkdtemp("/tmp/fleur-repository-resume-");
  const files = new Map<string, string>();
  const packages = { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" };
  const profile = { method: "docker-official-apt" as const, verified: true as const, distribution: "ubuntu" as const, release: "24.04", architecture: "x64" as const, repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages, artifacts: aptFixtureArtifacts(packages) };
  let updates = 0;
  let copies = 0;
  let installs = 0;
  let repositoryPrompts = 0;
  let indexReady = false;
  let installed = false;
  const done = (stdout = "", exitCode = 0, stderr = "") => ({ status: "completed" as const, exitCode, stdout, stderr });
  try {
    const handlers = setupCommands({
      stateDirectory: directory, interactive: true,
      confirmHuman: async ({ action }) => { if (action === "repository-configuration") repositoryPrompts++; return "once"; },
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args, _timeout, context) => {
        const path = args.at(-1)!;
        const health = aptHealthProtocol(args, installed ? Object.entries(packages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`) : []);
        if (health) return health;
        const artifact = await aptArtifactProtocol(args, context, packages);
        if (artifact) return artifact;
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "dpkg-query") return installed ? done(Object.entries(packages).map(([name, version]) => args.some((arg) => arg.includes("db:Status-Status")) ? `${name}\t${version}\tinstalled${args.some((arg) => arg.includes("db:Status-Eflag")) ? "\tok" : ""}` : `${name}=${version}`).join("\n")) : done("", 1);
        if (args[0] === "stat") return ["/etc", "/etc/apt", "/etc/apt/keyrings", "/etc/apt/sources.list.d"].includes(path) ? done("directory|0|755|2\n") : files.has(path) ? done("regular file|0|644|1\n") : done("", 1, "No such file or directory");
        if (args[0] === "cat") return files.has(path) ? done(files.get(path)!) : done("", 1, "No such file or directory");
        if (args[0] === "apt-cache") return indexReady ? done(Object.entries(packages).map(([name, version]) => `Package: ${name}\nVersion: ${version}\n`).join("\n")) : done("", 100);
        if (args[0] === "sudo" && args[2] === "cp") { copies++; if (!files.has(path)) files.set(path, await readFile(args.at(-2)!, "utf8")); return done(); }
        if (args[0] === "sudo" && path === "update") { updates++; if (updates === 1) return done("", 1); indexReady = true; return done(); }
        if (args[0] === "apt-get") return indexReady ? done(Object.entries(packages).map(([name, version]) => `Inst ${name} (${version} Docker:stable [amd64])`).join("\n")) : done("", 100);
        if (args[0] === "sudo" && args.includes("--simulate")) return done(aptFixturePackageTargets(args, packages).map((entry) => { const [name, version] = entry.split("="); return `Inst ${name} (${version} Docker:stable [amd64])`; }).join("\n"));
        if (args[0] === "sudo") { const result = await aptGuardProtocol(args, packages, []); if (result.exitCode === 0) { installs++; installed = true; } return result; }
        throw new Error("Unexpected repository operation");
      },
    }, [profile]);
    const first = await runCli(["setup"], { cwd: directory, handlers });
    expect(first.result.data).toMatchObject({ setupAction: { action: "repository-configuration", state: "incomplete" } });
    expect(installs).toBe(0);
    expect(copies).toBe(2);
    const firstGrants = JSON.parse(await readFile(join(directory, "grants.json"), "utf8")) as { grants: { action: string; revoked: boolean }[] };
    expect(firstGrants.grants.filter((grant) => grant.action !== "repository-configuration").every((grant) => !grant.revoked)).toBe(true);
    const unauthorised = await runCli(["setup", "--json"], { cwd: directory, handlers });
    expect(unauthorised.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(updates).toBe(1);
    expect(copies).toBe(2);
    expect(installs).toBe(0);
    const second = await runCli(["setup"], { cwd: directory, handlers });
    expect(updates).toBe(2);
    expect(repositoryPrompts).toBe(2);
    expect(copies).toBe(2);
    expect(installs).toBe(1);
    expect(second.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" } });
    await runCli(["setup", "--json"], { cwd: directory, handlers });
    expect(updates).toBe(2);
    expect(copies).toBe(2);
    expect(installs).toBe(1);
    expect((await readdir(directory)).filter((name) => name.startsWith("repository-"))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

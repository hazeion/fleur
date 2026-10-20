import { aptFixtureArtifacts, aptArtifactProtocol, aptGuardProtocol, aptFixturePackageTargets, aptHealthProtocol } from "./fixtures/apt-artifacts.ts";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";
import type { AptInstallProfile } from "../../src/setup/native.ts";
import { dockerRepositoryKey } from "../../src/setup/docker-key.ts";
import { productionHost } from "../../src/setup/host.ts";

const profile: AptInstallProfile = {
  method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64",
  repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88",
  packages: { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" }, artifacts: aptFixtureArtifacts({ "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" }),
};
async function observeSetup(status: string, probe: { output?: string; exitCode?: number; status?: "completed" | "missing" | "timeout" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fleur-package-state-"));
  const calls: string[][] = [];
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: directory, handlers: setupCommands({
      stateDirectory: join(directory, "state"),
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] !== "dpkg-query") throw new Error("Existing package state cannot authorize machine changes");
        const includesStatus = args.some((arg) => arg.includes("${db:Status-Status}"));
        const stdout = includesStatus
          ? `docker-ce\t1\t${status}\tok\ndocker-ce-cli\t1\tinstalled\tok\ncontainerd.io\t2\tinstalled\tok\ndocker-buildx-plugin\t1\tinstalled\tok\ndocker-compose-plugin\t1\tinstalled\tok\n`
          : "docker-ce=1\ndocker-ce-cli=1\ncontainerd.io=2\ndocker-buildx-plugin=1\ndocker-compose-plugin=1\n";
        return { status: probe.status ?? "completed", exitCode: probe.exitCode ?? 0, stdout: probe.output ?? stdout, stderr: "" };
      },
    }, [profile]) });
    return { outcome, calls };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test("setup observes dpkg configuration status and refuses an exact-version half-configured package", async () => {
  const result = await observeSetup("half-configured");
  expect(result.calls.find((args) => args[0] === "dpkg-query")?.some((arg) => arg.includes("${db:Status-Status}"))).toBe(true);
  expect(result.outcome.exitCode).toBe(4);
  expect(result.outcome.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
  expect(result.outcome.result.data).toMatchObject({ packageState: { state: "conflict", present: [], missing: [] } });
  expect(result.calls.map((args) => args[0])).toEqual(["docker", "dpkg-query"]);
});

async function partialInstallation({ authorize = true, interruptFirst = false, driftBeforeInstall = false, reinstallationRequired = false, foreignCli = false }: { authorize?: boolean; interruptFirst?: boolean; driftBeforeInstall?: boolean; reinstallationRequired?: boolean; foreignCli?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fleur-partial-package-"));
  const present = new Set(["docker-ce-cli", "containerd.io", "docker-buildx-plugin"]);
  if (foreignCli) present.delete("docker-ce-cli");
  const requests: { simulated: string[][]; installed: string[][] } = { simulated: [], installed: [] };
  let queries = 0;
  let drifted = false;
  let interrupted = false;
  try {
    const handlers = setupCommands({
      stateDirectory: join(directory, "state"), interactive: authorize, confirmHuman: async () => "once",
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args, _timeout, context) => {
        const done = (stdout = "", exitCode = 0) => ({ status: "completed" as const, stdout, stderr: "", exitCode });
        const health = aptHealthProtocol(args, Object.entries(profile.packages).filter(([name]) => present.has(name)).map(([name, version]) => `${name}\t${version}\tinstalled\tok`));
        if (health) return health;
        const artifact = await aptArtifactProtocol(args, context, profile.packages);
        if (artifact) return artifact;
        if (args[0] === "docker") {
          if (args[1] === "--version") return done("Docker version 28.0.4");
          if (args[1] === "context" && args[2] === "show") return done("default");
          if (args[1] === "context" && args[2] === "inspect") return done('{"Host":"unix:///var/run/docker.sock"}');
          return done("", 1); // The installed CLI is usable; the incomplete prerequisite set is not ready.
        }
        if (args[0] === "dpkg-query") {
          queries++;
          const withErrorFlag = args.some((arg) => arg.includes("${db:Status-Eflag}"));
          return done(Object.entries(profile.packages).filter(([name]) => present.has(name)).map(([name, version]) => `${name}\t${drifted && name === "docker-ce-cli" ? "99" : version}\tinstalled${withErrorFlag ? `\t${reinstallationRequired && name === "docker-ce-cli" ? "reinstreq" : "ok"}` : ""}`).join("\n") + "\n", present.size === 5 ? 0 : 1);
        }
        if (args[0] === "stat") return done(args.at(-1)?.endsWith(".asc") || args.at(-1)?.endsWith(".sources") ? "regular file|0|644|1" : "directory|0|755|2");
        if (args[0] === "cat") return done(args.at(-1)?.endsWith(".asc") ? dockerRepositoryKey : "Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n");
        if (args[0] === "apt-cache") return done(Object.entries(profile.packages).map(([name, version]) => `Package: ${name}\nVersion: ${version}\n`).join("\n"));
        if (args[0] === "apt-get") {
          const packages = aptFixturePackageTargets(args, profile.packages);
          requests.simulated.push([...packages]);
          drifted = driftBeforeInstall;
          return done(packages.map((entry) => { const [name, version] = entry.split("="); return `Inst ${name} (${version} Docker:stable [amd64])`; }).join("\n"));
        }
        if (args[0] === "sudo" && args.includes("--simulate")) {
          const packages = aptFixturePackageTargets(args, profile.packages); requests.simulated.push([...packages]);
          return done(packages.map((entry) => { const [name, version] = entry.split("="); return `Inst ${name} (${version} Docker:stable [amd64])`; }).join("\n"));
        }
        if (args[0] === "sudo") {
          const packages = aptFixturePackageTargets(args, profile.packages);
          const checked = await aptGuardProtocol(args, profile.packages, Object.entries(profile.packages).filter(([name]) => present.has(name)).map(([name, version]) => `${name}\t${version}\tinstalled\tok`));
          if (checked.exitCode !== 0) return checked;
          requests.installed.push([...packages]);
          if (interruptFirst && !interrupted) { interrupted = true; present.add("docker-ce"); return done("", 1); }
          for (const entry of packages) present.add(entry.split("=")[0]!);
          return checked;
        }
        throw new Error("Unexpected prerequisite operation");
      },
    }, [profile]);
    const first = await runCli(["setup"], { cwd: directory, handlers });
    const outcome = interruptFirst ? await runCli(["setup"], { cwd: directory, handlers }) : first;
    return { outcome, first, requests, queries };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test("setup resumes a partial exact package set without reinstalling already configured packages or ignoring a usable CLI", async () => {
  const result = await partialInstallation();
  expect(result.requests.simulated).toEqual([["docker-ce=1", "docker-compose-plugin=1"], ["docker-ce=1", "docker-compose-plugin=1"]]);
  expect(result.requests.installed).toEqual([["docker-ce=1", "docker-compose-plugin=1"]]);
  expect(result.queries).toBeGreaterThanOrEqual(3);
  expect(result.outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" }, packageState: { state: "compatible", present: ["containerd.io", "docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin"], missing: [] } });
});

test("the setup permission plan reports preserved and missing packages before any machine action", async () => {
  const result = await partialInstallation({ authorize: false });
  expect(result.outcome.exitCode).toBe(3);
  expect(result.outcome.result.data).toMatchObject({ packageState: { state: "compatible", present: ["containerd.io", "docker-buildx-plugin", "docker-ce-cli"], missing: ["docker-ce", "docker-compose-plugin"] } });
  expect(result.requests.simulated).toEqual([]);
  expect(result.requests.installed).toEqual([]);
});

test("fully configured exact versions remain untouched and are distinguished from package conflicts", async () => {
  const result = await observeSetup("installed");
  expect(result.outcome.exitCode).toBe(4); // Package identity alone is not Docker readiness.
  expect(result.outcome.result.data).toMatchObject({ packageState: { state: "compatible", present: ["containerd.io", "docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin"], missing: [] } });
  expect(result.calls.map((args) => args[0])).toEqual(["docker", "dpkg-query"]);
});

test.each(["unpacked", "half-installed", "triggers-pending", "triggers-awaited", "not-installed", "unknown"])("setup refuses observed %s package state without granting or changing packages", async (status) => {
  const result = await observeSetup(status);
  expect(result.outcome.exitCode).toBe(4);
  expect(result.outcome.result.data).toMatchObject({ packageState: { state: "conflict", present: [], missing: [] } });
  expect(result.calls.map((args) => args[0])).toEqual(["docker", "dpkg-query"]);
});

test.each([
  { label: "wrong version", output: "docker-ce\t99\tinstalled\tok\n" },
  { label: "unknown name", output: "unrelated-package\t1\tinstalled\tok\n" },
  { label: "duplicate record", output: "docker-ce\t1\tinstalled\tok\ndocker-ce\t1\tinstalled\tok\n" },
  { label: "unparseable record", output: "docker-ce=1\n" },
  { label: "incomplete successful result", output: "docker-ce\t1\tinstalled\tok\n" },
])("setup refuses $label before package mutation", async ({ output }) => {
  const result = await observeSetup("installed", { output });
  expect(result.outcome.exitCode).toBe(4);
  expect(result.outcome.result.data).toMatchObject({ packageState: { state: "conflict" } });
  expect(result.calls.map((args) => args[0])).toEqual(["docker", "dpkg-query"]);
});

test.each(["missing", "timeout"] as const)("an unavailable dpkg query (%s) cannot authorize package installation", async (status) => {
  const result = await observeSetup("installed", { status });
  expect(result.outcome.exitCode).toBe(4);
  expect(result.outcome.result.data).toMatchObject({ packageState: { state: "unavailable", present: [], missing: [] } });
  expect(result.calls.map((args) => args[0])).toEqual(["docker", "dpkg-query"]);
});

test("retrying an interrupted install re-probes and never repeats the package that already completed", async () => {
  const result = await partialInstallation({ interruptFirst: true });
  expect(result.first.exitCode).toBe(3);
  expect(result.first.result.data).toMatchObject({ setupAction: { action: "install", state: "incomplete" } });
  expect(result.requests.simulated).toEqual([["docker-ce=1", "docker-compose-plugin=1"], ["docker-ce=1", "docker-compose-plugin=1"], ["docker-compose-plugin=1"], ["docker-compose-plugin=1"]]);
  expect(result.requests.installed).toEqual([["docker-ce=1", "docker-compose-plugin=1"], ["docker-compose-plugin=1"]]);
  expect(result.outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed", packages: ["docker-compose-plugin"] }, packageState: { state: "compatible", missing: [] } });
});

test("package drift after simulation stops the action before installation", async () => {
  const result = await partialInstallation({ driftBeforeInstall: true });
  expect(result.outcome.exitCode).toBe(5);
  expect(result.outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
  expect(result.outcome.result.data).toMatchObject({ packageState: { state: "conflict" } });
  expect(result.requests.simulated).toEqual([["docker-ce=1", "docker-compose-plugin=1"]]);
  expect(result.requests.installed).toEqual([]);
});

test("an installed exact-version package with reinstreq blocks partial installation rather than being treated as configured", async () => {
  const result = await partialInstallation({ reinstallationRequired: true });
  expect(result.requests.simulated).toEqual([]);
  expect(result.requests.installed).toEqual([]);
  expect(result.outcome.exitCode).toBe(4);
  expect(result.outcome.result.data).toMatchObject({ packageState: { state: "conflict" } });
});

test.each(["DPKG_ROOT", "DPKG_ADMINDIR"] as const)("package inventory ignores %s redirection and preserves conflicting actual-host packages", async (variable) => {
  const directory = await mkdtemp(join(tmpdir(), "fleur-host-package-root-"));
  const previous = { PATH: process.env.PATH, DPKG_ROOT: process.env.DPKG_ROOT, DPKG_ADMINDIR: process.env.DPKG_ADMINDIR };
  let installs = 0;
  const queries: string[][] = [];
  try {
    const commands = join(directory, "commands");
    const alternate = join(directory, "alternate");
    await mkdir(commands);
    await mkdir(join(alternate, "var", "lib", "dpkg"), { recursive: true });
    await writeFile(join(alternate, "status.tsv"), "");
    await writeFile(join(alternate, "var", "lib", "dpkg", "status.tsv"), "");
    const local = join(directory, "local-status.tsv");
    await writeFile(local, "docker-ce\t99\tinstalled\tok\n");
    const script = `#!${process.execPath}\nconst args=process.argv.slice(2);const actual=args.includes("--root=/")&&args.includes("--admindir=/var/lib/dpkg");const source=actual?${JSON.stringify(local)}:process.env.DPKG_ADMINDIR?process.env.DPKG_ADMINDIR+"/status.tsv":process.env.DPKG_ROOT?process.env.DPKG_ROOT+"/var/lib/dpkg/status.tsv":${JSON.stringify(local)};process.stdout.write(await Bun.file(source).text());process.exit(1);\n`;
    await writeFile(join(commands, "dpkg-query"), script, { mode: 0o755 });
    process.env.PATH = commands;
    delete process.env.DPKG_ROOT;
    delete process.env.DPKG_ADMINDIR;
    process.env[variable] = alternate;
    const production = productionHost();
    const outcome = await runCli(["setup"], { cwd: directory, handlers: setupCommands({
      ...production, stateDirectory: join(directory, "state"), interactive: true, confirmHuman: async () => "once",
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args, timeout) => {
        const done = (stdout = "", exitCode = 0) => ({ status: "completed" as const, stdout, stderr: "", exitCode });
        if (args[0] === "dpkg-query") { queries.push([...args]); return production.run(args, timeout); }
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "stat") return done(args.at(-1)?.endsWith(".asc") || args.at(-1)?.endsWith(".sources") ? "regular file|0|644|1" : "directory|0|755|2");
        if (args[0] === "cat") return done(args.at(-1)?.endsWith(".asc") ? dockerRepositoryKey : "Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n");
        if (args[0] === "apt-cache") return done(Object.entries(profile.packages).map(([name, version]) => `Package: ${name}\nVersion: ${version}\n`).join("\n"));
        if (args[0] === "apt-get") return done(Object.entries(profile.packages).map(([name, version]) => `Inst ${name} (${version} Docker:stable [amd64])`).join("\n"));
        if (args[0] === "sudo") { installs++; return done(); }
        throw new Error("Unexpected prerequisite operation");
      },
    }, [profile]) });
    expect(installs).toBe(0);
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result.data).toMatchObject({ packageState: { state: "conflict" } });
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query).toContain("--root=/");
      expect(query).toContain("--admindir=/var/lib/dpkg");
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["ssh://private-host", "unix:///tmp/socket?redirect=other"])("native package setup preserves the rejected endpoint outcome for %s", async (endpoint) => {
  const directory = await mkdtemp(join(tmpdir(), "fleur-rejected-native-endpoint-"));
  const calls: string[][] = [];
  let prompts = 0;
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: directory, handlers: setupCommands({
      stateDirectory: join(directory, "state"), interactive: true, confirmHuman: async () => { prompts++; return "once"; },
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "dpkg-query") return { status: "completed", exitCode: 1, stdout: "", stderr: "" };
        const command = args.join(" ");
        const stdout = command === "docker --version" ? "Docker version 28.0.4" : command === "docker context show" ? "selected" : command.startsWith("docker context inspect") ? JSON.stringify({ Host: endpoint }) : "";
        return { status: "completed", exitCode: 0, stdout, stderr: "" };
      },
    }, [profile]) });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result.error?.actual).toBe(endpoint.startsWith("ssh:") ? "remote endpoint" : "malformed endpoint");
    expect(outcome.result.data).toBeNull();
    expect(calls.every((args) => args[0] === "docker")).toBe(true);
    expect(prompts).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a usable CLI without its exact configured native package is preserved instead of installing over an unknown tool", async () => {
  const result = await partialInstallation({ foreignCli: true });
  expect(result.requests.simulated).toEqual([]);
  expect(result.requests.installed).toEqual([]);
  expect(result.outcome.exitCode).toBe(4);
  expect(result.outcome.result.data).toMatchObject({ packageState: { state: "conflict" } });
});

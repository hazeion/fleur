import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";
import type { AptInstallProfile } from "../../src/setup/native.ts";
import { dockerRepositoryKey } from "../../src/setup/docker-key.ts";

const profile: AptInstallProfile = {
  method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64",
  repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88",
  packages: { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" },
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

async function partialInstallation({ authorize = true, interruptFirst = false, driftBeforeInstall = false, reinstallationRequired = false }: { authorize?: boolean; interruptFirst?: boolean; driftBeforeInstall?: boolean; reinstallationRequired?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fleur-partial-package-"));
  const present = new Set(["docker-ce-cli", "containerd.io", "docker-buildx-plugin"]);
  const requests: { simulated: string[][]; installed: string[][] } = { simulated: [], installed: [] };
  let queries = 0;
  let drifted = false;
  let interrupted = false;
  try {
    const handlers = setupCommands({
      stateDirectory: join(directory, "state"), interactive: authorize, confirmHuman: async () => "once",
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args) => {
        const done = (stdout = "", exitCode = 0) => ({ status: "completed" as const, stdout, stderr: "", exitCode });
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
          const packages = args.slice(args.indexOf("install") + 1);
          requests.simulated.push([...packages]);
          drifted = driftBeforeInstall;
          return done(packages.map((entry) => { const [name, version] = entry.split("="); return `Inst ${name} (${version} Docker:stable [amd64])`; }).join("\n"));
        }
        if (args[0] === "sudo") {
          const packages = args.slice(args.indexOf("install") + 1);
          requests.installed.push([...packages]);
          if (interruptFirst && !interrupted) { interrupted = true; present.add("docker-ce"); return done("", 1); }
          for (const entry of packages) present.add(entry.split("=")[0]!);
          return done();
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
  expect(result.requests.simulated).toEqual([["docker-ce=1", "docker-compose-plugin=1"]]);
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
  expect(result.requests.simulated).toEqual([["docker-ce=1", "docker-compose-plugin=1"], ["docker-compose-plugin=1"]]);
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

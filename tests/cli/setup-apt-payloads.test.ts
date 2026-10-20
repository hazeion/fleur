import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";
import { dockerRepositoryKey } from "../../src/setup/docker-key.ts";
import { aptArtifactProtocol, aptFixtureArtifacts, aptGuardProtocol, aptHealthProtocol } from "./fixtures/apt-artifacts.ts";

const packages = { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" };
const profile = { method: "docker-official-apt" as const, verified: true as const, distribution: "ubuntu" as const, release: "24.04", architecture: "x64" as const, repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages, artifacts: aptFixtureArtifacts(packages) };

interface PayloadOptions {
  readonly producerPolicy?: boolean;
  readonly rejectedPlan?: "extra-install" | "extra-configure" | "remove" | "wrong-version" | "missing" | "duplicate" | "unknown";
  readonly rejectedPhase?: "initial" | "privileged";
  readonly unrelatedStatus?: string;
  readonly unrelatedError?: string;
  readonly inventoryTruncated?: boolean;
  readonly latePending?: boolean;
  readonly uncertain?: "timeout" | "truncated";
  readonly durability?: "create" | "remove";
}
async function payloadScenario(tamper: boolean, substituteAtHook = false, options: PayloadOptions = {}) {
  const directory = await mkdtemp("/tmp/fleur-apt-payload-");
  let privilegedInstalls = 0;
  let installed = false;
  let prompts = 0;
  let markerSeen = false;
  const calls: string[][] = [];
  const simulation = (args: readonly string[]) => {
    const operations = Object.entries(packages).flatMap(([name, version]) => [`Inst ${name} (${version} Docker CE:noble [amd64])`, `Conf ${name} (${version} Docker CE:noble [amd64])`]).join("\n");
    if (!options.producerPolicy) return Object.entries(packages).map(([name, version]) => `Inst ${name} (${version} Docker:stable [amd64])`).join("\n");
    const note = args.includes("APT::Get::Show-User-Simulation-Note=false") ? "" : "NOTE: This is only a simulation!\n      apt-get needs root privileges for real execution.\n      Keep also in mind that locking is deactivated,\n      so don't depend on the relevance to the real current situation!\n";
    const advisory = args.includes("--quiet=2") ? "" : "Reading package lists...\nBuilding dependency tree...\nReading state information...\nSuggested packages:\n  cgroupfs-mount | cgroup-lite docker-model-plugin\nRecommended packages:\n  docker-ce-rootless-extras pigz\nThe following NEW packages will be installed:\n  containerd.io docker-buildx-plugin docker-ce docker-ce-cli\n  docker-compose-plugin\n0 upgraded, 5 newly installed, 0 to remove and 0 not upgraded.\n";
    const optional = args.includes("--no-install-recommends") && args.includes("--no-install-suggests") ? "" : "\nInst pigz (2.8-1 Ubuntu:noble [amd64])";
    let plan = operations;
    if (options.rejectedPlan && (args[0] === "sudo" ? "privileged" : "initial") === options.rejectedPhase) {
      if (options.rejectedPlan === "extra-install") plan += "\nInst unapproved-package (1 vendor [amd64])";
      if (options.rejectedPlan === "extra-configure") plan += "\nConf unapproved-service (1 vendor [amd64])";
      if (options.rejectedPlan === "remove") plan += "\nRemv existing-application [1]";
      if (options.rejectedPlan === "wrong-version") plan = plan.replace("Inst docker-ce (1 ", "Inst docker-ce (99 ");
      if (options.rejectedPlan === "missing") plan = plan.split("\n").filter((line) => !line.startsWith("Inst docker-ce ")).join("\n");
      if (options.rejectedPlan === "duplicate") plan += "\nInst docker-ce (1 Docker CE:noble [amd64])";
      if (options.rejectedPlan === "unknown") plan += "\nUnrecognized package transaction output";
    }
    return note + advisory + plan + optional;
  };
  const done = (stdout = "", exitCode = 0) => ({ status: "completed" as const, exitCode, stdout, stderr: "" });
  try {
    const handlers = setupCommands({
      stateDirectory: join(directory, "state"), interactive: true, confirmHuman: async () => { prompts++; return "once"; },
      ...(options.durability ? { syncDirectory: async (path: string) => {
        let marker = false;
        try { await lstat(join(path, "apt-transaction-pending.json")); marker = true; } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
        if (options.durability === "create" && marker) throw Object.assign(new Error("Injected pending fence fsync failure"), { code: "EIO" });
        if (options.durability === "remove") { if (marker) markerSeen = true; else if (markerSeen) throw Object.assign(new Error("Injected fence removal fsync failure"), { code: "EIO" }); }
      } } : {}),
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args, _timeout, context?: { readonly cwd?: string; readonly outputLimitBytes?: number }) => {
        calls.push([...args]);
        const health = aptHealthProtocol(args, [...(installed ? Object.entries(packages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`) : []), ...(options.unrelatedStatus || options.unrelatedError ? [`another-application\t1\t${options.unrelatedStatus ?? "installed"}\t${options.unrelatedError ?? "ok"}`] : [])]);
        if (health) { expect(context?.outputLimitBytes).toBe(2097152); return options.inventoryTruncated ? { ...health, exitCode: 1, terminationUnconfirmed: true } : health; }
        if (args[0] === "apt-get" && args.includes("download") && !args.includes("--print-uris")) {
          const inspected = await runCli(["setup", "grants", "list", "--json"], { cwd: directory, handlers });
          const grants = (inspected.result.data as { grants: { action: string; revoked: boolean }[] }).grants;
          expect(grants).toHaveLength(5);
          expect(grants.filter((grant) => grant.action === "install")).toHaveLength(1);
          expect(grants.filter((grant) => grant.action !== "install")).toHaveLength(4);
          expect(grants.filter((grant) => grant.action === "install").every((grant) => grant.revoked)).toBe(true);
          expect(grants.filter((grant) => grant.action !== "install").every((grant) => !grant.revoked)).toBe(true);
        }
        const artifact = await aptArtifactProtocol(args, context, packages, tamper);
        if (artifact) return artifact;
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "dpkg-query") return done(installed ? Object.entries(packages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`).join("\n") : "", installed ? 0 : 1);
        if (args[0] === "stat") return done(args.at(-1)?.endsWith("docker.asc") || args.at(-1)?.endsWith("docker.sources") ? "regular file|0|644|1\n" : "directory|0|755|2\n");
        if (args[0] === "cat") return done(args.at(-1)?.endsWith("docker.asc") ? dockerRepositoryKey : "Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n");
        if (args[0] === "apt-cache") return done(Object.entries(packages).map(([name, version]) => `Package: ${name}\nVersion: ${version}\n`).join("\n"));
        if (args[0] === "apt-get") return done(simulation(args));
        if (args[0] === "sudo" && args.includes("--simulate")) {
          const inspected = await runCli(["setup", "grants", "list", "--json"], { cwd: directory, handlers });
          const grants = (inspected.result.data as { grants: { revoked: boolean }[] }).grants;
          expect(grants).toHaveLength(5);
          expect(grants.every((grant) => grant.revoked)).toBe(true);
          return done(simulation(args));
        }
        if (args[0] === "sudo") {
          if (options.producerPolicy && (!args.includes("--no-install-recommends") || !args.includes("--no-install-suggests") || args.includes("--quiet=2") || args.includes("APT::Get::Show-User-Simulation-Note=false"))) return done("Producer policy does not cover this real installation", 100);
          if (substituteAtHook) {
            const path = args[args.indexOf("install") + 1]!;
            const bytes = await readFile(path); bytes[bytes.length - 2] = 88; await writeFile(path, bytes);
          }
          const guarded = await aptGuardProtocol(args, packages, options.latePending ? ["another-application\t1\tunpacked\tok"] : []);
          if (guarded.exitCode !== 0) return guarded;
          privilegedInstalls++; installed = true;
          if (options.uncertain === "timeout") return { status: "timeout", stdout: "", stderr: "" };
          if (options.uncertain === "truncated") return { ...guarded, terminationUnconfirmed: true };
          return guarded;
        }
        throw new Error("Unexpected payload fixture operation");
      },
    }, [profile]);
    const outcome = await runCli(["setup"], { cwd: directory, handlers });
    const retry = options.uncertain ? await runCli(["setup"], { cwd: directory, handlers }) : undefined;
    return { outcome, retry, privilegedInstalls, calls, prompts, entries: await readdir(join(directory, "state")) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test("a same-version signed-repository package with different payload bytes is rejected before privileged installation", async () => {
  const result = await payloadScenario(true);
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(4);
  expect(result.outcome.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
});

test("unchanged frozen APT payloads install from verified local archives without redownloading", async () => {
  const result = await payloadScenario(false);
  expect(result.privilegedInstalls).toBe(1);
  expect(result.outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" } });
  const installation = result.calls.find((args) => args[0] === "sudo" && !args.includes("--simulate"))!;
  expect(installation).toContain("--no-download");
  expect(installation.slice(installation.indexOf("install") + 1).every((path) => path.startsWith("/") && path.endsWith(".deb"))).toBe(true);
});
test("the actual APT guard rejects changed archive bytes after preflight but before dpkg installs them", async () => {
  const result = await payloadScenario(false, true);
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(5);
});

test.each(["unpacked", "half-configured", "triggers-pending", "triggers-awaited"])("unrelated %s package work blocks acquisition and privileged APT", async (unrelatedStatus) => {
  const result = await payloadScenario(false, false, { unrelatedStatus });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.calls.some((args) => args[0] === "sudo" || args.includes("download"))).toBe(false);
});
test("an unrelated reinstreq package blocks acquisition instead of authorizing repair", async () => {
  const result = await payloadScenario(false, false, { unrelatedError: "reinstreq" });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.calls.some((args) => args[0] === "sudo" || args.includes("download"))).toBe(false);
});
test("a truncated complete-system inventory is never interpreted as healthy", async () => {
  const result = await payloadScenario(false, false, { inventoryTruncated: true });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(5);
});
test("the actual APT hook also refuses unrelated pending work introduced after planning", async () => {
  const result = await payloadScenario(false, false, { latePending: true });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(3);
});
test.each(["timeout", "truncated"] as const)("an uncertain %s privileged result retains APT artifacts and blocks fresh permission on retry", async (uncertain) => {
  const result = await payloadScenario(false, false, { uncertain });
  expect(result.outcome.exitCode).toBe(5);
  expect(result.retry?.exitCode).toBe(5);
  expect(result.prompts).toBe(5);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(true);
});
test("pending APT fence durability failure prevents every privileged APT step", async () => {
  const result = await payloadScenario(false, false, { durability: "create" });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.calls.some((args) => args[0] === "sudo")).toBe(false);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.entries).toContain("apt-transaction-pending.json");
});
test("failure to durably remove a completed APT fence cannot report completed setup", async () => {
  const result = await payloadScenario(false, false, { durability: "remove" });
  expect(result.privilegedInstalls).toBe(1);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(true);
});

test("APT producer policy permits exact frozen installation without optional dependency authority", async () => {
  const result = await payloadScenario(false, false, { producerPolicy: true });
  expect(result.outcome.result.error?.message).toBe("Exact verified packages are installed. Run doctor to verify service access and disposable smoke readiness.");
  expect(result.outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" } });
  expect(result.privilegedInstalls).toBe(1);
});

for (const rejectedPhase of ["initial", "privileged"] as const) {
  for (const rejectedPlan of ["extra-install", "extra-configure", "remove", "wrong-version", "missing", "duplicate", "unknown"] as const) {
    test(`normalized ${rejectedPhase} APT simulation rejects ${rejectedPlan} without installing`, async () => {
      const result = await payloadScenario(false, false, { producerPolicy: true, rejectedPhase, rejectedPlan });
      expect(result.privilegedInstalls).toBe(0);
      expect(result.outcome.exitCode).toBe(4);
      expect(result.outcome.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
      expect(result.calls.some((args) => args[0] === "sudo" && args.includes("install") && !args.includes("--simulate"))).toBe(false);
    });
  }
}

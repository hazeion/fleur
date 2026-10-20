import { expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands, type HostCommandResult } from "../../src/setup/commands.ts";
import { dockerRepositoryKey } from "../../src/setup/docker-key.ts";
import { aptArtifactProtocol, aptFixtureArtifacts, aptGuardProtocol, aptHealthProtocol, type AptGuardFault } from "./fixtures/apt-artifacts.ts";

const packages = { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" };
const profile = { method: "docker-official-apt" as const, verified: true as const, distribution: "ubuntu" as const, release: "24.04", architecture: "x64" as const, repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages, artifacts: aptFixtureArtifacts(packages) };

interface PayloadOptions {
  readonly guardFault?: AptGuardFault;
  readonly guardSink?: "closed" | "full";
  readonly isolatedLocalSources?: boolean;
  readonly sourceCreationCollision?: "config" | "parts";
  readonly sourceTamper?: "list-bytes" | "config-bytes" | "list-symlink" | "config-symlink" | "list-hardlink" | "config-mode" | "parts-entry" | "parts-replaced" | "parts-mode";
  readonly afterPlan?: boolean;
  readonly missingLocalDependency?: boolean;
  readonly apt283Wire?: boolean;
  readonly uncertainResolution?: boolean;
  readonly uriFailure?: "origin" | "scheme" | "path" | "encoded-slash" | "double-escape" | "size-zero" | "size-wrong" | "sha" | "hash-missing" | "multiple" | "nonzero" | "missing-command";
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
  const selectedPackages = options.apt283Wire ? { ...packages, "docker-ce": "5:1~fixture+1" } : packages;
  const selectedProfile = { ...profile, packages: selectedPackages, artifacts: aptFixtureArtifacts(selectedPackages) };
  const directory = await mkdtemp("/tmp/fleur-apt-payload-");
  let privilegedInstalls = 0;
  const guardResults: HostCommandResult[] = [];
  let plannedScope: string[] | undefined;
  let sourceMutated = false;
  let actualForeignPath: string | undefined;
  let controlReads = 0;
  let collisionPath: string | undefined;
  const sentinel = join(directory, "foreign-sentinel");
  const mutateSources = async () => {
    if (!options.sourceTamper || sourceMutated) return;
    const state = join(directory, "state");
    const stage = join(state, (await readdir(state)).find((name) => name.startsWith("apt-payloads-"))!);
    const list = join(stage, "local-only.list"); const config = join(stage, "local-only.conf"); const parts = join(stage, "local-only.parts");
    await writeFile(sentinel, "preserve foreign source content\n");
    if (options.sourceTamper === "list-bytes") await writeFile(list, "deb https://unapproved.example stable main\n");
    if (options.sourceTamper === "config-bytes") await writeFile(config, "APT::Sources::With:: /unapproved.sources;\n");
    if (options.sourceTamper === "list-symlink" || options.sourceTamper === "config-symlink") { const target = options.sourceTamper === "list-symlink" ? list : config; await rename(target, target + "-saved"); await symlink(sentinel, target); }
    if (options.sourceTamper === "list-hardlink") await link(list, list + "-alias");
    if (options.sourceTamper === "config-mode") await chmod(config, 0o644);
    if (options.sourceTamper === "parts-entry") { actualForeignPath = join(parts, "foreign.sources"); await writeFile(actualForeignPath, "preserve foreign source content\n"); }
    if (options.sourceTamper === "parts-replaced") { await rename(parts, parts + "-saved"); await mkdir(parts); actualForeignPath = join(parts, "replacement.sources"); await writeFile(actualForeignPath, "preserve foreign source content\n"); }
    if (options.sourceTamper === "parts-mode") await chmod(parts, 0o755);
    sourceMutated = true;
  };
  const localScope = async (args: readonly string[]): Promise<string[] | undefined> => {
    const list = args.find((arg) => arg.startsWith("Dir::Etc::sourcelist="))?.slice("Dir::Etc::sourcelist=".length);
    const parts = args.find((arg) => arg.startsWith("Dir::Etc::sourceparts="))?.slice("Dir::Etc::sourceparts=".length);
    const config = args[args.indexOf("-c") + 1];
    if (!list || !parts || !config || ![list, parts, config].every((path) => path.startsWith(join(directory, "state", "apt-payloads-")))) return undefined;
    if (await readFile(list, "utf8") !== "" || await readFile(config, "utf8") !== "#clear APT::Sources::With;\n" || (await readdir(parts)).length !== 0) return undefined;
    return [config, list, parts];
  };
  let installed = false;
  let prompts = 0;
  let markerSeen = false;
  const calls: string[][] = [];
  const simulation = (args: readonly string[]) => {
    const operations = Object.entries(selectedPackages).flatMap(([name, version]) => [`Inst ${name} (${version} Docker CE:noble [amd64])`, `Conf ${name} (${version} Docker CE:noble [amd64])`]).join("\n");
    if (!options.producerPolicy) return Object.entries(selectedPackages).map(([name, version]) => `Inst ${name} (${version} Docker:stable [amd64])`).join("\n");
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
      ...(options.durability || (options.sourceTamper && !options.afterPlan) ? { syncDirectory: async (path: string) => {
        let marker = false;
        try { await lstat(join(path, "apt-transaction-pending.json")); marker = true; } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
        if (marker && options.sourceTamper && !options.afterPlan) await mutateSources();
        if (options.durability === "create" && marker) throw Object.assign(new Error("Injected pending fence fsync failure"), { code: "EIO" });
        if (options.durability === "remove") { if (marker) markerSeen = true; else if (markerSeen) throw Object.assign(new Error("Injected fence removal fsync failure"), { code: "EIO" }); }
      } } : {}),
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args, _timeout, context?: { readonly cwd?: string; readonly outputLimitBytes?: number }) => {
        calls.push([...args]);
        if (options.isolatedLocalSources && args[0] === "apt-get") {
          expect(args).not.toContain("-c");
          expect(args).toContain("Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.sources");
        }
        const health = aptHealthProtocol(args, [...(installed ? Object.entries(selectedPackages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`) : []), ...(options.unrelatedStatus || options.unrelatedError ? [`another-application\t1\t${options.unrelatedStatus ?? "installed"}\t${options.unrelatedError ?? "ok"}`] : [])]);
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
        const artifact = await aptArtifactProtocol(args, context, selectedPackages, tamper, options.apt283Wire);
        if (artifact) {
          if (args[0] === "dpkg-deb") {
            controlReads++;
            if (options.sourceCreationCollision && controlReads === Object.keys(selectedPackages).length) {
              const state = join(directory, "state");
              const stage = join(state, (await readdir(state)).find((name) => name.startsWith("apt-payloads-"))!);
              if (options.sourceCreationCollision === "config") {
                collisionPath = join(stage, "local-only.conf");
                await writeFile(collisionPath, "preserve actual foreign collision bytes\n", { flag: "wx" });
              } else {
                const parts = join(stage, "local-only.parts"); await mkdir(parts);
                collisionPath = join(parts, "foreign.sources");
                await writeFile(collisionPath, "preserve actual foreign collision bytes\n", { flag: "wx" });
              }
            }
          }
          if (args.includes("--print-uris")) {
            if (options.uncertainResolution) return { ...artifact, terminationUnconfirmed: true };
            if (options.uriFailure) {
              let stdout = artifact.stdout;
              if (options.uriFailure === "origin") stdout = stdout.replace("download.docker.com", "untrusted.example");
              if (options.uriFailure === "scheme") stdout = stdout.replace("https:", "http:");
              if (options.uriFailure === "path") stdout = stdout.replace("/stable/", "/other/");
              if (options.uriFailure === "encoded-slash") stdout = stdout.replace("/pool/", "/pool%2f");
              if (options.uriFailure === "double-escape") stdout = stdout.replaceAll("%7e", "%257e");
              if (options.uriFailure === "size-zero") stdout = stdout.replace(/ [0-9]+ SHA256:/, " 0 SHA256:");
              if (options.uriFailure === "size-wrong") stdout = stdout.replace(/ [0-9]+ SHA256:/, " 1 SHA256:");
              if (options.uriFailure === "sha") stdout = stdout.replace(/SHA256:[a-f0-9]+/, "SHA256:" + "0".repeat(64));
              if (options.uriFailure === "hash-missing") stdout = stdout.replace(/SHA256:[a-f0-9]+/, "");
              if (options.uriFailure === "multiple") stdout += stdout;
              if (options.uriFailure === "nonzero") return { ...artifact, exitCode: 100, stdout, stderr: "E: repository resolution failed" };
              if (options.uriFailure === "missing-command") return { status: "missing", stdout, stderr: "apt-get unavailable" };
              return { ...artifact, stdout };
            }
          }
          return artifact;
        }
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "dpkg-query" && plannedScope && options.afterPlan) await mutateSources();
        if (args[0] === "dpkg-query") return done(installed ? Object.entries(selectedPackages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`).join("\n") : "", installed ? 0 : 1);
        if (args[0] === "stat") return done(args.at(-1)?.endsWith("docker.asc") || args.at(-1)?.endsWith("docker.sources") ? "regular file|0|644|1\n" : "directory|0|755|2\n");
        if (args[0] === "cat") return done(args.at(-1)?.endsWith("docker.asc") ? dockerRepositoryKey : "Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n");
        if (args[0] === "apt-cache") return done(Object.entries(selectedPackages).map(([name, version]) => `Package: ${name}\nVersion: ${version}\n`).join("\n"));
        if (args[0] === "apt-get") return done(simulation(args));
        if (args[0] === "sudo" && args.includes("--simulate")) {
          if (options.isolatedLocalSources) {
            plannedScope = await localScope(args);
            if (options.missingLocalDependency && plannedScope) return { ...done("", 100), stderr: "E: Unmet dependencies. Frozen package depends on missing distro dependency.\n" };
            if (!plannedScope) return { ...done("", 100), stderr: "W: Problem unlinking the file / - FileFd::Open (21: Is a directory)\nW: Could not open file / - open (17: File exists)\nW: Could not open file '/' - EDSP::Resolve (17: File exists)\nE: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?\n" };
          }
          const inspected = await runCli(["setup", "grants", "list", "--json"], { cwd: directory, handlers });
          const grants = (inspected.result.data as { grants: { revoked: boolean }[] }).grants;
          expect(grants).toHaveLength(5);
          expect(grants.every((grant) => grant.revoked)).toBe(true);
          return done(simulation(args));
        }
        if (args[0] === "sudo") {
          if (options.isolatedLocalSources && JSON.stringify(await localScope(args)) !== JSON.stringify(plannedScope)) return done("Local installation sources differ from the actual plan", 100);
          if (options.producerPolicy && (!args.includes("--no-install-recommends") || !args.includes("--no-install-suggests") || args.includes("--quiet=2") || args.includes("APT::Get::Show-User-Simulation-Note=false"))) return done("Producer policy does not cover this real installation", 100);
          if (substituteAtHook) {
            const path = args[args.indexOf("install") + 1]!;
            const bytes = await readFile(path); bytes[bytes.length - 2] = 88; await writeFile(path, bytes);
          }
          const guarded = await aptGuardProtocol(args, selectedPackages, options.latePending ? ["another-application\t1\tunpacked\tok"] : [], options.guardFault, options.guardSink);
          guardResults.push(guarded);
          if (guarded.exitCode !== 0) return guarded;
          privilegedInstalls++; installed = true;
          if (options.uncertain === "timeout") return { status: "timeout", stdout: "", stderr: "" };
          if (options.uncertain === "truncated") return { ...guarded, terminationUnconfirmed: true };
          return guarded;
        }
        throw new Error("Unexpected payload fixture operation");
      },
    }, [selectedProfile]);
    const outcome = await runCli(["setup"], { cwd: directory, handlers });
    const retry = options.uncertain ? await runCli(["setup"], { cwd: directory, handlers }) : undefined;
    const authorityAfterResolution = options.uncertainResolution ? await runCli(["setup", "grants", "list", "--json"], { cwd: directory, handlers }) : undefined;
    return { outcome, guardResults, retry, authorityAfterResolution, sourceMutated, actualForeignBytes: actualForeignPath ? await readFile(actualForeignPath, "utf8") : undefined, controlReads, collisionBytes: collisionPath ? await readFile(collisionPath, "utf8") : undefined, sentinel: sourceMutated ? await readFile(sentinel, "utf8") : undefined, privilegedInstalls, calls, prompts, entries: await readdir(join(directory, "state")) };
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

test("APT 2.8.3 encoded URI and epoch destination preserve the frozen payload identity", async () => {
  const result = await payloadScenario(false, false, { apt283Wire: true });
  expect(result.outcome.result.error?.message).toBe("Exact verified packages are installed. Run doctor to verify service access and disposable smoke readiness.");
  expect(result.privilegedInstalls).toBe(1);
  const installation = result.calls.find((args) => args[0] === "sudo" && !args.includes("--simulate"))!;
  expect(installation.some((arg) => arg.endsWith("/docker-ce_5%3a1~fixture+1_amd64.deb"))).toBe(true);
});

test("an uncertain URI resolution cannot consume acquisition authority or download payloads", async () => {
  const result = await payloadScenario(false, false, { uncertainResolution: true });
  expect(result.authorityAfterResolution?.result.data).toMatchObject({ grants: expect.arrayContaining([expect.objectContaining({ action: "install", mode: "once", revoked: false })]) });
  expect(result.calls.some((args) => args.includes("download") && !args.includes("--print-uris"))).toBe(false);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.privilegedInstalls).toBe(0);
});

for (const uriFailure of ["origin", "scheme", "path", "encoded-slash", "double-escape", "size-zero", "size-wrong", "sha", "hash-missing", "multiple", "nonzero", "missing-command"] as const) {
  test(`APT URI representation preserves acquisition rejection: ${uriFailure}`, async () => {
    const result = await payloadScenario(false, false, { apt283Wire: true, uriFailure });
    expect(result.outcome.exitCode).toBe(4);
    expect(result.outcome.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
    expect(result.calls.some((args) => args.includes("download") && !args.includes("--print-uris"))).toBe(false);
    expect(result.privilegedInstalls).toBe(0);
  });
}

test("local APT transaction uses only owned empty source inputs after authenticated acquisition", async () => {
  const result = await payloadScenario(false, false, { isolatedLocalSources: true });
  expect(result.outcome.result.error?.message).toBe("Exact verified packages are installed. Run doctor to verify service access and disposable smoke readiness.");
  expect(result.privilegedInstalls).toBe(1);
});

for (const sourceTamper of ["list-bytes", "config-bytes", "list-symlink", "config-symlink", "list-hardlink", "config-mode", "parts-entry", "parts-replaced", "parts-mode"] as const) {
  test(`local APT source custody refuses ${sourceTamper} before privileged planning`, async () => {
    const result = await payloadScenario(false, false, { isolatedLocalSources: true, sourceTamper });
    expect(result.sourceMutated).toBe(true);
    expect(result.outcome.exitCode).toBe(5);
    expect(result.outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
    expect(result.calls.some((args) => args[0] === "sudo")).toBe(false);
    expect(result.entries).toContain("apt-transaction-pending.json");
    expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(true);
    expect(result.sentinel).toBe("preserve foreign source content\n");
    if (sourceTamper === "parts-entry" || sourceTamper === "parts-replaced") expect(result.actualForeignBytes).toBe("preserve foreign source content\n");
    expect(result.privilegedInstalls).toBe(0);
  });
}
test("local APT source custody is rechecked after a successful plan before installation", async () => {
  const result = await payloadScenario(false, false, { isolatedLocalSources: true, sourceTamper: "config-bytes", afterPlan: true });
  expect(result.sourceMutated).toBe(true);
  expect(result.calls.some((args) => args[0] === "sudo" && args.includes("--simulate"))).toBe(true);
  expect(result.calls.some((args) => args[0] === "sudo" && !args.includes("--simulate"))).toBe(false);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.sentinel).toBe("preserve foreign source content\n");
});
test("isolated local APT sources cannot supply an absent distribution dependency", async () => {
  const result = await payloadScenario(false, false, { isolatedLocalSources: true, missingLocalDependency: true });
  expect(result.outcome.exitCode).toBe(3);
  expect(result.privilegedInstalls).toBe(0);
  expect(result.calls.some((args) => args[0] === "sudo" && !args.includes("--simulate"))).toBe(false);
});

test("isolated local APT planning still rejects an additional package operation", async () => {
  const result = await payloadScenario(false, false, { isolatedLocalSources: true, producerPolicy: true, rejectedPhase: "privileged", rejectedPlan: "extra-install" });
  expect(result.outcome.exitCode).toBe(4);
  expect(result.privilegedInstalls).toBe(0);
  expect(result.calls.some((args) => args[0] === "sudo" && !args.includes("--simulate"))).toBe(false);
});

for (const sourceCreationCollision of ["config", "parts"] as const) {
  test(`local APT source creation preserves a foreign ${sourceCreationCollision} collision before the privilege fence`, async () => {
    const result = await payloadScenario(false, false, { isolatedLocalSources: true, sourceCreationCollision });
    expect(result.controlReads).toBe(5);
    expect(result.outcome.exitCode).toBe(5);
    expect(result.outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
    expect(result.calls.some((args) => args[0] === "sudo")).toBe(false);
    expect(result.privilegedInstalls).toBe(0);
    expect(result.entries).not.toContain("apt-transaction-pending.json");
    expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(true);
    expect(result.collisionBytes).toBe("preserve actual foreign collision bytes\n");
  });
}


test("an actual APT guard refusal identifies its validation stage without exposing package state", async () => {
  const result = await payloadScenario(false, false, { latePending: true });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(3);
  expect(result.guardResults).toHaveLength(1);
  expect(result.guardResults[0]).toMatchObject({ exitCode: 100, stdout: "" });
  expect(result.guardResults[0]!.stderr).toBe('FLEUR_APT_GUARD_REFUSAL {"formatVersion":1,"stage":"package-inventory"}\n');
});


test.each([
  ["invocation", "invocation"], ["plan-mode", "plan-file"], ["plan-json", "plan-schema"], ["plan-schema", "plan-schema"],
  ["protocol-header", "protocol-input"], ["protocol-config", "protocol-config"], ["protocol-action", "protocol-actions"],
  ["package-state", "package-state"], ["archive-identity", "archive-identity"], ["archive-digest", "archive-digest"],
] as const)("the real APT guard reports %s refusal without leaking rejected input", async (guardFault, stage) => {
  const result = await payloadScenario(false, false, { guardFault });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.guardResults).toHaveLength(1);
  expect(result.guardResults[0]).toEqual({ status: "completed", exitCode: 100, stdout: "", stderr: `FLEUR_APT_GUARD_REFUSAL {"formatVersion":1,"stage":"${stage}"}\n` });
  expect(result.outcome.exitCode).not.toBe(0);
  expect(JSON.stringify(result.outcome)).not.toContain("PRIVATE-SENTINEL");
});

test("a successful real APT guard preserves its receipt and emits no refusal diagnostic", async () => {
  const result = await payloadScenario(false);
  expect(result.privilegedInstalls).toBe(1);
  expect(result.guardResults).toHaveLength(1);
  expect(result.guardResults[0]).toMatchObject({ status: "completed", exitCode: 0, stderr: "" });
  expect(result.guardResults[0]!.stdout).toMatch(/^\[fleur-apt-guard\] [a-f0-9]{64}\n$/);
  expect(result.outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" } });
});


test.each(["closed", "full"] as const)("a %s diagnostic pipe leaves the real APT guard refusal unchanged", async (guardSink) => {
  const result = await payloadScenario(false, false, { guardFault: "invocation", guardSink });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(3);
  expect(result.guardResults).toEqual([{ status: "completed", exitCode: 100, stdout: "", stderr: "" }]);
}, 10000);

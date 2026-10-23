import { observeAptLocks } from "../../src/setup/apt-locks.ts";
import { expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands, type HostCommandResult } from "../../src/setup/commands.ts";
import { dockerRepositoryKey } from "../../src/setup/docker-key.ts";
import { aptArtifactProtocol, aptFixtureArtifacts, aptGuardProtocol, aptHealthProtocol, type AptGuardFault } from "./fixtures/apt-artifacts.ts";

const packages = { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" };
const profile = { method: "docker-official-apt" as const, verified: true as const, distribution: "ubuntu" as const, release: "24.04", architecture: "x64" as const, repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages, artifacts: aptFixtureArtifacts(packages) };

type CacheFault = "bytes" | "symlink" | "hardlink" | "inode" | "root" | "extra" | "lock-inode" | "lock-bytes" | "partial-inode" | "partial-extra" | "auxfiles-inode" | "auxfiles-extra" | "mode" | "source-bytes";
interface PayloadOptions {
  readonly bootId?: string | null;
  readonly inspectRecovery?: boolean;
  readonly changeIdentityDuringConsent?: boolean;
  readonly reboot?: boolean;
  readonly recoveryInspection?: boolean;
  readonly inspectionConsent?: "once" | "remembered" | "deny";
  readonly inspectionFailure?: "uncertain" | "changed";
  readonly inspectionCrash?: boolean;
  readonly inspectionPublishCrash?: boolean;
  readonly inspectionUseGrant?: boolean;
  readonly inspectionGrantMismatch?: "boot" | "operation" | "remembered" | "helper";
  readonly inspectionReceiptChanged?: boolean;
  readonly inspectionConsentMutation?: boolean;
  readonly inspectionConsumptionDurability?: boolean;
  readonly recoveryFault?: "machine" | "user" | "checksum" | "legacy" | "unknown-field" | "missing-boot" | "partial" | "unrelated" | "busy" | "unknown-locks" | "uncertain-inventory" | "global-reference" | "config-unavailable" | "extra-artifact" | "changed-artifact" | "replaced-artifact" | "foreign-receipt" | "authority-null" | "authority-malformed" | "authority-array" | "authority-duplicate";
  readonly recoveryCrash?: "receipt" | "retirement" | "receipt-retry";
  readonly recoveryRetry?: boolean;
  readonly recoveryDeadline?: boolean;
  readonly kernelLocks?: string;
  readonly recoveryConfigMutation?: boolean;
  readonly cacheFault?: CacheFault;
  readonly cacheFaultAt?: "after-plan" | "hook" | "after-install";
  readonly cacheCollision?: boolean;
  readonly cacheControlWrong?: boolean;
  readonly noDownloadCache?: boolean;
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
  readonly durability?: "create" | "remove" | "stage";
}
async function payloadScenario(tamper: boolean, substituteAtHook = false, options: PayloadOptions = {}) {
  const selectedPackages = options.apt283Wire ? { ...packages, "docker-ce": "5:1~fixture+1" } : packages;
  const selectedProfile = { ...profile, packages: selectedPackages, artifacts: aptFixtureArtifacts(selectedPackages) };
  const directory = await mkdtemp("/tmp/fleur-apt-payload-");
  let privilegedInstalls = 0;
  let recovering = false;
  let recoverySyncs = 0;
  let crashInjected = false;
  let recoveryHealthReads = 0;
  let inspections = 0;
  let retryingInspection = false;
  let globalConfigChanged = false;
  const guardResults: HostCommandResult[] = [];
  let plannedScope: string[] | undefined;
  let sourceMutated = false;
  let actualForeignPath: string | undefined;
  let controlReads = 0;
  let collisionPath: string | undefined;
  let cacheMutated = false;
  let cacheForeign: string | undefined;
  const mutateCache = async () => {
    if (!options.cacheFault || cacheMutated) return;
    const state = join(directory, "state");
    const stage = join(state, (await readdir(state)).find((name) => name.startsWith("apt-payloads-"))!);
    const archives = join(stage, "archives");
    const copy = join(archives, (await readdir(archives)).find((name) => name.endsWith(".deb"))!);
    const fault = options.cacheFault;
    if (fault === "bytes") { const bytes = await readFile(copy); bytes[0] = 88; await writeFile(copy, bytes); }
    if (fault === "source-bytes") { const source = join(stage, "docker-ce", (await readdir(join(stage, "docker-ce")))[0]!); const bytes = await readFile(source); bytes[0] = 88; await writeFile(source, bytes); }
    if (fault === "symlink") { await rename(copy, join(directory, "original-copy")); cacheForeign = join(directory, "foreign-cache-target"); await writeFile(cacheForeign, "preserve cache sentinel"); await symlink(cacheForeign, copy); }
    if (fault === "hardlink") await link(copy, join(directory, "outside-hardlink"));
    if (fault === "inode") { const bytes = await readFile(copy); await rename(copy, join(directory, "original-copy")); await writeFile(copy, bytes, { mode: 0o600 }); }
    if (fault === "root") { await rename(archives, join(directory, "original-archives")); await mkdir(archives, { mode: 0o700 }); }
    if (fault === "extra") { cacheForeign = join(archives, "foreign-entry"); await writeFile(cacheForeign, "preserve cache sentinel"); }
    if (fault === "lock-inode") { await rename(join(archives, "lock"), join(directory, "original-lock")); await writeFile(join(archives, "lock"), "", { mode: 0o600 }); }
    if (fault === "lock-bytes") { cacheForeign = join(archives, "lock"); await writeFile(cacheForeign, "preserve cache sentinel"); }
    if (fault === "partial-inode" || fault === "auxfiles-inode") { const path = fault === "partial-inode" ? join(archives, "partial") : join(stage, "local-lists", "auxfiles"); await rename(path, join(directory, "original-auxiliary")); await mkdir(path, { mode: fault === "partial-inode" ? 0o700 : 0o755 }); }
    if (fault === "partial-extra" || fault === "auxfiles-extra") { cacheForeign = fault === "partial-extra" ? join(archives, "partial", "foreign-entry") : join(stage, "local-lists", "auxfiles", "foreign-entry"); await writeFile(cacheForeign, "preserve cache sentinel"); }
    if (fault === "mode") await chmod(archives, 0o755);
    cacheMutated = true;
  };
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
  const hostIdentity = { system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64), bootId: options.bootId === null ? undefined : options.bootId ?? "11111111-1111-4111-8111-111111111111" };
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
      stateDirectory: join(directory, "state"), interactive: true, confirmHuman: async (plan) => { prompts++; if (plan.action === "recovery-inspect") {
        if (options.inspectionConsentMutation) { const pending = JSON.parse(await readFile(join(directory, "state", "apt-transaction-pending.json"), "utf8")); await writeFile(join(directory, "state", pending.artifacts.root, "local-only.conf"), "preserve consent-time mutation\n"); }
        return options.inspectionConsent ?? "deny";
      } if (options.changeIdentityDuringConsent) hostIdentity.bootId = "22222222-2222-4222-8222-222222222222"; return "once"; },
      ...(options.durability || options.recoveryCrash || options.recoveryConfigMutation || options.inspectionCrash || options.inspectionPublishCrash || options.inspectionConsumptionDurability || (options.cacheFault && !options.cacheFaultAt) || (options.sourceTamper && !options.afterPlan) ? { syncDirectory: async (path: string) => {
        if (recovering && options.inspectionConsumptionDurability && !crashInjected) {
          const current = JSON.parse(await readFile(join(path, "grants.json"), "utf8")).grants;
          if (current.some((grant: { action: string; revoked: boolean }) => grant.action === "recovery-inspect" && grant.revoked)) { crashInjected = true; throw new Error("Inspection consumption was not durable"); }
        }
        if (recovering && options.inspectionPublishCrash && !crashInjected) {
          const current = JSON.parse(await readFile(join(path, "grants.json"), "utf8")).grants;
          if (current.some((grant: { action: string; revoked: boolean }) => grant.action === "recovery-inspect" && !grant.revoked)) { crashInjected = true; throw new Error("Interrupted after inspection grant publication"); }
        }
        if (recovering && options.inspectionCrash && !crashInjected && (await readdir(path)).some((name) => name.startsWith("apt-reconciled-"))) { crashInjected = true; throw new Error("Interrupted receipt directory durability"); }
        if (recovering && (options.recoveryCrash || options.recoveryConfigMutation) && path === join(directory, "state")) {
          recoverySyncs++;
          if (options.recoveryConfigMutation) globalConfigChanged = true;
          if (options.recoveryCrash === "receipt-retry" && recoverySyncs <= 2) throw new Error("Injected repeated receipt publication interruption");
          if (!crashInjected && recoverySyncs === (options.recoveryCrash === "receipt" ? 1 : 2)) { crashInjected = true; throw new Error("Injected recovery directory fsync interruption"); }
        }
        if (options.durability === "stage" && path.startsWith(join(directory, "state", "apt-payloads-"))) throw Object.assign(new Error("Injected retained artifact directory fsync failure"), { code: "EIO" });
        let marker = false;
        try { await lstat(join(path, "apt-transaction-pending.json")); marker = true; } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
        if (marker && options.cacheFault && !options.cacheFaultAt) await mutateCache();
        if (marker && options.sourceTamper && !options.afterPlan) await mutateSources();
        if (options.durability === "create" && marker) throw Object.assign(new Error("Injected pending fence fsync failure"), { code: "EIO" });
        if (options.durability === "remove") { if (marker) markerSeen = true; else if (markerSeen) throw Object.assign(new Error("Injected fence removal fsync failure"), { code: "EIO" }); }
      } } : {}),
      ...(options.recoveryInspection ? { aptAuxiliaries: async () => ({
        request: { formatVersion: 1, scope: "fixed-two-apt-auxiliaries", inspectorSha256: (retryingInspection && options.inspectionGrantMismatch === "helper" ? "c" : "b").repeat(64), descriptors: "trusted external filesystem fixture" },
        inspectorSha256: (retryingInspection && options.inspectionGrantMismatch === "helper" ? "c" : "b").repeat(64),
        inspect: async () => { inspections++; if (options.inspectionFailure) throw new Error("External privileged inspection is uncertain"); return { formatVersion: 1, empty: true, directories: ["archives/partial", "local-lists/auxfiles"] }; },
        verifyReceipt: async () => { if (options.inspectionReceiptChanged) throw new Error("Retained auxiliary evidence changed since its prior inspection"); }, unchanged: async () => {}, close: async () => {},
      }) } : {}),
      host: async () => hostIdentity,
      aptPackageLocks: async (timeoutMs) => options.kernelLocks !== undefined ? observeAptLocks(timeoutMs, {
        system: "linux",
        identity: async (path) => ({ dev: 2049n, ino: BigInt(["/var/lib/dpkg/lock", "/var/lib/dpkg/lock-frontend", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock"].indexOf(path) + 123456), uid: 0n, mode: 0o100640n, nlink: 1n, regular: true }),
        locks: async () => Buffer.from(options.kernelLocks!),
      }) : recovering && options.recoveryFault === "busy" ? "busy" : recovering && options.recoveryFault === "unknown-locks" ? "unknown" : "clear",
      run: async (args, _timeout, context?: { readonly cwd?: string; readonly outputLimitBytes?: number }) => {
        calls.push([...args]);
        if (options.isolatedLocalSources && args[0] === "apt-get") {
          expect(args).not.toContain("-c");
          expect(args).toContain("Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.sources");
        }
        const health = aptHealthProtocol(args, [...(installed ? Object.entries(selectedPackages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`) : []), ...(options.unrelatedStatus || options.unrelatedError ? [`another-application\t1\t${options.unrelatedStatus ?? "installed"}\t${options.unrelatedError ?? "ok"}`] : [])]);
        if (health && recovering && options.recoveryDeadline && ++recoveryHealthReads === 3) await Bun.sleep(_timeout + 20);
        if (health && recovering && options.recoveryFault === "partial") return done("docker-ce\t1\tunpacked\tok\n");
        if (health && recovering && options.recoveryFault === "unrelated") return done(health.stdout + "\nanother-application\t1\thalf-configured\tok");
        if (health && recovering && options.recoveryFault === "uncertain-inventory") return { ...health, terminationUnconfirmed: true };
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
            if (options.cacheCollision && controlReads === Object.keys(selectedPackages).length) {
              const state = join(directory, "state"); const stage = join(state, (await readdir(state)).find((name) => name.startsWith("apt-payloads-"))!);
              await mkdir(join(stage, "archives"), { mode: 0o700 }); cacheForeign = join(stage, "archives", "foreign-entry"); await writeFile(cacheForeign, "preserve cache sentinel");
            }
            if (options.cacheControlWrong && args[2]!.includes("/archives/")) return done("Package: wrong-package\nVersion: 1\nArchitecture: amd64\n");
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
        if (args[0] === "apt-config") {
          if (options.recoveryFault === "config-unavailable") return { status: "missing", stdout: "", stderr: "" };
          if (options.recoveryFault === "global-reference" || globalConfigChanged) return done(`APT::Update::Post-Invoke "${join(directory, "state", (await readdir(join(directory, "state"))).find((name) => name.startsWith("apt-payloads-"))!)}";`);
          return done("APT {};\n");
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
          if (options.cacheFaultAt === "after-plan") await mutateCache();
          return done(simulation(args));
        }
        if (args[0] === "sudo") {
          if (options.isolatedLocalSources && JSON.stringify(await localScope(args)) !== JSON.stringify(plannedScope)) return done("Local installation sources differ from the actual plan", 100);
          if (options.producerPolicy && (!args.includes("--no-install-recommends") || !args.includes("--no-install-suggests") || args.includes("--quiet=2") || args.includes("APT::Get::Show-User-Simulation-Note=false"))) return done("Producer policy does not cover this real installation", 100);
          if (substituteAtHook) {
            const path = args[args.indexOf("install") + 1]!;
            const bytes = await readFile(path); bytes[bytes.length - 2] = 88; await writeFile(path, bytes);
          }
          if (options.cacheFaultAt === "hook") await mutateCache();
          const guarded = await aptGuardProtocol(args, selectedPackages, options.latePending ? ["another-application\t1\tunpacked\tok"] : [], options.guardFault, options.guardSink, options.noDownloadCache);
          guardResults.push(guarded);
          if (guarded.exitCode !== 0) return guarded;
          privilegedInstalls++; installed = true;
          if (options.cacheFaultAt === "after-install") await mutateCache();
          if (options.uncertain === "timeout") return { status: "timeout", stdout: "", stderr: "" };
          if (options.uncertain === "truncated") return { ...guarded, terminationUnconfirmed: true };
          return guarded;
        }
        throw new Error("Unexpected payload fixture operation");
      },
    }, [selectedProfile]);
    const outcome = await runCli(["setup"], { cwd: directory, handlers });
    const pending = options.inspectRecovery || options.reboot ? JSON.parse(await readFile(join(directory, "state", "apt-transaction-pending.json"), "utf8")) : undefined;
    const retry = options.uncertain ? await runCli(["setup"], { cwd: directory, handlers }) : undefined;
    const authorityAfterResolution = options.uncertainResolution ? await runCli(["setup", "grants", "list", "--json"], { cwd: directory, handlers }) : undefined;
    const recoveryGrants = options.inspectRecovery ? await runCli(["setup", "grants", "list", "--json"], { cwd: directory, handlers }) : undefined;
    let resumed;
    let preservation;
    let recoveryRetried;
    let entriesAtCrash;
    if (options.reboot) {
      const snapshot = async () => Promise.all(pending.artifacts.entries.map(async (entry: { path: string; directory: boolean }) => {
        const path = join(directory, "state", pending.artifacts.root, entry.path);
        const info = await lstat(path, { bigint: true });
        return { path: entry.path, dev: String(info.dev), ino: String(info.ino), mode: String(info.mode), uid: String(info.uid), sha256: entry.directory ? null : Bun.CryptoHasher.hash("sha256", await readFile(path), "hex") };
      }));
      const artifactsBefore = await snapshot();
      const grantsBefore = await readFile(join(directory, "state", "grants.json"), "utf8");
      const callsBefore = calls.length;
      const promptsBefore = prompts;
      hostIdentity.bootId = "22222222-2222-4222-8222-222222222222";
      recovering = true;
      const fault = options.recoveryFault;
      if (fault === "missing-boot") hostIdentity.bootId = undefined;
      if (["machine", "user", "checksum", "legacy", "unknown-field", "authority-null", "authority-malformed", "authority-array", "authority-duplicate"].includes(fault ?? "")) {
        const changed = { ...pending };
        if (fault === "machine") changed.machine = "b".repeat(64);
        if (fault === "user") changed.user = process.getuid!() + 1;
        if (fault === "checksum") changed.checksum = "b".repeat(64);
        if (fault === "legacy") changed.formatVersion = 1;
        if (fault === "unknown-field") changed.unreviewed = true;
        if (fault === "authority-null") changed.authority = null;
        if (fault === "authority-array") changed.authority = [{ ...changed.authority[0], mode: ["once"] }, ...changed.authority.slice(1)];
        if (fault === "authority-malformed") changed.authority = [{ ...changed.authority[0], mode: "automatic" }, ...changed.authority.slice(1)];
        if (fault === "authority-duplicate") changed.authority = [changed.authority[0], changed.authority[0], ...changed.authority.slice(2)];
        await writeFile(join(directory, "state", "apt-transaction-pending.json"), JSON.stringify(changed));
      }
      if (fault?.startsWith("authority-")) await unlink(join(directory, "state", "setup.lock"));
      const evidence = join(directory, "state", pending.artifacts.root);
      if (fault === "extra-artifact") await writeFile(join(evidence, "foreign-child"), "preserve foreign evidence");
      if (fault === "changed-artifact") await writeFile(join(evidence, "local-only.conf"), "preserve changed evidence");
      if (fault === "replaced-artifact") { await rename(join(evidence, "local-only.conf"), join(directory, "original-local-conf")); await writeFile(join(evidence, "local-only.conf"), "#clear APT::Sources::With;\n", { mode: 0o600 }); }
      if (fault === "foreign-receipt") await writeFile(join(directory, "state", `apt-reconciled-${pending.operationId}.json`), '{"foreign":"preserve"}', { mode: 0o600 });
      resumed = await runCli(["setup", ...(options.inspectionConsent ? [] : ["--json"]), ...(options.recoveryDeadline ? ["--timeout", "0.5"] : [])], { cwd: directory, handlers });
      entriesAtCrash = await readdir(join(directory, "state"));
      if (options.recoveryRetry) {
        retryingInspection = true;
        if (options.inspectionGrantMismatch === "boot") hostIdentity.bootId = "33333333-3333-4333-8333-333333333333";
        if (options.inspectionGrantMismatch === "operation") { const file = join(directory, "state", "apt-transaction-pending.json"); const pending = JSON.parse(await readFile(file, "utf8")); await writeFile(file, JSON.stringify({ ...pending, operationId: "33333333-3333-4333-8333-333333333333" })); }
        if (options.inspectionGrantMismatch === "remembered") { const file = join(directory, "state", "grants.json"); const store = JSON.parse(await readFile(file, "utf8")); store.grants = store.grants.map((grant: { action: string }) => grant.action === "recovery-inspect" ? { ...grant, mode: "remembered" } : grant); await writeFile(file, JSON.stringify(store)); }
        const supplied = options.inspectionUseGrant ? ["--grant", JSON.parse(await readFile(join(directory, "state", "grants.json"), "utf8")).grants.find((grant: { action: string }) => grant.action === "recovery-inspect").id] : [];
        recoveryRetried = await runCli(["setup", "--json", ...supplied], { cwd: directory, handlers });
      }
      preservation = { artifactsBefore, artifactsAfter: await snapshot(), grantsBefore, grantsAfter: await readFile(join(directory, "state", "grants.json"), "utf8"), calls: calls.slice(callsBefore), prompts: prompts - promptsBefore };
    }
    return { outcome, inspections, resumed, recoveryRetried, entriesAtCrash, preservation, pending, recoveryGrants, guardResults, cacheMutated, cacheForeignBytes: cacheForeign ? await readFile(cacheForeign, "utf8") : undefined, retry, authorityAfterResolution, sourceMutated, actualForeignBytes: actualForeignPath ? await readFile(actualForeignPath, "utf8") : undefined, controlReads, collisionBytes: collisionPath ? await readFile(collisionPath, "utf8") : undefined, sentinel: sourceMutated ? await readFile(sentinel, "utf8") : undefined, privilegedInstalls, calls, prompts, entries: await readdir(join(directory, "state")).catch((error: { code?: string }) => { if (error.code === "ENOENT") return []; throw error; }) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test("interrupted APT setup retains original boot, scoped authority and owned artifact identities", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", inspectRecovery: true });
  expect(result.outcome.exitCode).toBe(5);
  expect(result.pending).toMatchObject({ formatVersion: 2, action: "install", method: "docker-official-apt", bootId: "11111111-1111-4111-8111-111111111111", machine: "a".repeat(64), user: process.getuid!(), checksum: Bun.CryptoHasher.hash("sha256", JSON.stringify(profile), "hex") });
  expect(result.pending.operationId).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  expect(result.pending.artifacts.root).toMatch(/^apt-payloads-[A-Za-z0-9]+$/);
  expect(result.pending.artifacts.entries.length).toBeGreaterThan(15);
  expect(result.pending.artifacts.entries.find((entry: { path: string }) => entry.path === "apt-plan.json")).toMatchObject({ directory: false, mode: 0o600, size: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), dev: expect.stringMatching(/^[0-9]+$/), ino: expect.stringMatching(/^[0-9]+$/) });
  const grants = (result.recoveryGrants!.result.data as { grants: { id: string; revoked: boolean }[] }).grants;
  expect(grants).toHaveLength(5);
  expect(grants.every((grant) => grant.revoked)).toBe(true);
  expect(result.pending.authority.map((grant: { id: string }) => grant.id).sort()).toEqual(grants.map((grant) => grant.id).sort());
});

test.each([null, "not-a-kernel-boot-id"])("APT setup without a verified original boot refuses before authority or package work: %s", async (bootId) => {
  const result = await payloadScenario(false, false, { bootId });
  expect(result.outcome.exitCode).toBe(3);
  expect(result.outcome.result.error?.code).toBe("HUMAN_ACTION_REQUIRED");
  expect(result.prompts).toBe(0);
  expect(result.privilegedInstalls).toBe(0);
  expect(result.calls.some((args) => ["apt-get", "sudo"].includes(args[0]!))).toBe(false);
  expect(result.entries).toEqual([]);
});

test("retained artifact durability failure prevents every privileged APT command", async () => {
  const result = await payloadScenario(false, false, { durability: "stage" });
  expect(result.outcome.exitCode).toBe(5);
  expect(result.outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
  expect(result.privilegedInstalls).toBe(0);
  expect(result.calls.some((args) => args[0] === "sudo")).toBe(false);
  expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(true);
});

test("APT recovery custody keeps the original host observation across asynchronous consent", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", inspectRecovery: true, changeIdentityDuringConsent: true });
  expect(result.outcome.exitCode).toBe(5);
  expect(result.pending.bootId).toBe("11111111-1111-4111-8111-111111111111");
});

test("after a verified reboot setup reconciles exact configured packages without replaying the unknown transaction", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", inspectRecovery: true, reboot: true });
  expect(result.outcome.exitCode).toBe(5);
  expect(result.retry?.exitCode).toBe(5); // Same-boot uncertainty remains blocked.
  expect(result.resumed?.exitCode).toBe(4); // Fake Docker remains unavailable; package reconciliation is not readiness.
  expect(result.resumed?.result.data).toMatchObject({ recovery: { state: "reconciled", historicalOutcome: "unknown", artifacts: "retained" } });
  expect(result.privilegedInstalls).toBe(1);
  expect(result.preservation!.artifactsAfter).toEqual(result.preservation!.artifactsBefore);
  expect(result.preservation!.grantsAfter).toBe(result.preservation!.grantsBefore);
  expect(result.preservation!.prompts).toBe(0);
  expect(result.preservation!.calls.some((args) => ["sudo", "apt-get", "dpkg-deb"].includes(args[0]!))).toBe(false);
  expect(result.entries).not.toContain("apt-transaction-pending.json");
  expect(result.entries).toContain(`apt-reconciled-${result.pending.operationId}.json`);
});
test.each(["machine", "user", "checksum", "legacy", "unknown-field", "missing-boot", "partial", "unrelated", "busy", "unknown-locks", "uncertain-inventory", "global-reference", "config-unavailable", "extra-artifact", "changed-artifact", "replaced-artifact", "foreign-receipt"] as const)("reboot recovery preserves the pending fence and refuses unsafe evidence: %s", async (recoveryFault) => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryFault });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.resumed?.result.error?.code).toBe("RECOVERY_REQUIRED");
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.preservation!.grantsAfter).toBe(result.preservation!.grantsBefore);
  expect(result.preservation!.prompts).toBe(0);
  expect(result.preservation!.calls.some((args) => ["sudo", "apt-get", "dpkg-deb", "docker"].includes(args[0]!))).toBe(false);
  expect(result.privilegedInstalls).toBe(1);
});
test.each(["receipt", "retirement"] as const)("reboot recovery is restartable after directory durability interruption: %s", async (recoveryCrash) => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryCrash, recoveryRetry: true });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.entriesAtCrash).toContain(`apt-reconciled-${result.pending.operationId}.json`);
  expect(result.entriesAtCrash!.includes("apt-transaction-pending.json")).toBe(recoveryCrash === "receipt");
  expect(result.recoveryRetried?.exitCode).toBe(4);
  expect(result.entries).not.toContain("apt-transaction-pending.json");
  expect(result.preservation!.artifactsAfter).toEqual(result.preservation!.artifactsBefore);
  expect(result.preservation!.grantsAfter).toBe(result.preservation!.grantsBefore);
  expect(result.preservation!.calls.some((args) => ["sudo", "apt-get", "dpkg-deb"].includes(args[0]!))).toBe(false);
  expect(result.privilegedInstalls).toBe(1);
});
test("a matching prior receipt must become durable before the pending fence is retired", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryCrash: "receipt-retry", recoveryRetry: true });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.recoveryRetried?.exitCode).toBe(5);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.preservation!.artifactsAfter).toEqual(result.preservation!.artifactsBefore);
  expect(result.preservation!.grantsAfter).toBe(result.preservation!.grantsBefore);
});
test("configuration changed during receipt publication cannot retire the interrupted fence", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryConfigMutation: true });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.preservation!.grantsAfter).toBe(result.preservation!.grantsBefore);
});
test("a deadline expiring during the final package observation preserves the interrupted fence", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryDeadline: true });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.preservation!.grantsAfter).toBe(result.preservation!.grantsBefore);
  expect(result.preservation!.artifactsAfter).toEqual(result.preservation!.artifactsBefore);
});
test.each([
  ["unrelated flock and POSIX records", "1: FLOCK  ADVISORY  WRITE 111 08:01:999999 0 EOF\n2: POSIX  ADVISORY  READ 222 08:01:999998 1 1\n", 4],
  ["unrelated OFD record", "1: OFDLCK ADVISORY  WRITE -1 08:01:999999 128 191\n", 4],
  ["dpkg lock", "1: POSIX  ADVISORY  WRITE 222 08:01:123456 0 EOF\n", 5],
  ["frontend waiting lock", "1: -> POSIX  ADVISORY  WRITE 222 08:01:123457 0 EOF\n", 5],
  ["APT index lock", "1: POSIX  ADVISORY  WRITE 222 08:01:123458 0 EOF\n", 5],
  ["APT cache OFD lock", "1: OFDLCK ADVISORY  WRITE -1 08:01:123459 0 EOF\n", 5],
  ["unknown kernel record", "1: FUTURE  ADVISORY  WRITE 222 08:01:999999 0 EOF\n", 5],
] as const)("public reboot recovery interprets Linux kernel lock evidence: %s", async (_name, kernelLocks, expected) => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, kernelLocks });
  expect(result.resumed?.exitCode).toBe(expected);
  expect(result.entries.some((entry) => entry === "apt-transaction-pending.json")).toBe(expected === 5);
  expect(result.preservation!.grantsAfter).toBe(result.preservation!.grantsBefore);
  expect(result.preservation!.calls.some((args) => ["sudo", "apt-get", "dpkg-deb"].includes(args[0]!))).toBe(false);
});
test.each(["authority-null", "authority-malformed", "authority-array", "authority-duplicate"] as const)("malformed historical authority is a read-only refusal before setup lock creation: %s", async (recoveryFault) => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryFault });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.entries).not.toContain("setup.lock");
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.preservation!.calls).toEqual([]);
  expect(result.preservation!.prompts).toBe(0);
  expect(result.preservation!.grantsAfter).toBe(result.preservation!.grantsBefore);
  expect(result.preservation!.artifactsAfter).toEqual(result.preservation!.artifactsBefore);
});
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
  expect(result.guardResults[0]).toEqual({ status: "completed", exitCode: 100, stdout: "", stderr: `FLEUR_APT_GUARD_REFUSAL {"formatVersion":1,"stage":"${stage}"${guardFault === "protocol-action" ? ',"reason":"malformed-action"' : ""}}\n` });
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


test("an archive path spelling mismatch remains refused and reports only fixed diagnostic categories", async () => {
  const result = await payloadScenario(false, false, { guardFault: "archive-path-canonical" });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(3);
  expect(result.guardResults).toHaveLength(1);
  expect(result.guardResults[0]).toEqual({ status: "completed", exitCode: 100, stdout: "", stderr: 'FLEUR_APT_GUARD_REFUSAL {"formatVersion":1,"stage":"protocol-actions","reason":"archive-path-mismatch","pathEquivalence":"canonical-path-equal"}\n' });
});


test.each([
  "unknown-package", "existing-version", "direction", "target-version", "configure-before-install", "duplicate-configure", "duplicate-install", "missing-install",
] as const)("the real APT guard distinguishes %s without changing its refusal", async (guardFault) => {
  const result = await payloadScenario(false, false, { guardFault });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(3);
  expect(result.guardResults).toEqual([{ status: "completed", exitCode: 100, stdout: "", stderr: `FLEUR_APT_GUARD_REFUSAL {"formatVersion":1,"stage":"protocol-actions","reason":"${guardFault}"}\n` }]);
  expect(JSON.stringify(result.outcome)).not.toContain("PRIVATE-SENTINEL");
});

test("a different archive path is refused without disclosing the supplied path", async () => {
  const result = await payloadScenario(false, false, { guardFault: "archive-path-different" });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(3);
  expect(result.guardResults).toEqual([{ status: "completed", exitCode: 100, stdout: "", stderr: 'FLEUR_APT_GUARD_REFUSAL {"formatVersion":1,"stage":"protocol-actions","reason":"archive-path-mismatch","pathEquivalence":"different-path"}\n' }]);
  expect(JSON.stringify(result.outcome)).not.toContain("PRIVATE-SENTINEL");
});


test.each(["closed", "full"] as const)("a %s diagnostic pipe preserves an archive-path refusal with its optional reason", async (guardSink) => {
  const result = await payloadScenario(false, false, { guardFault: "archive-path-canonical", guardSink });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(3);
  expect(result.guardResults).toEqual([{ status: "completed", exitCode: 100, stdout: "", stderr: "" }]);
}, 10000);


test("no-download APT selects an already owned canonical cache archive before invoking the real guard", async () => {
  const result = await payloadScenario(false, false, { noDownloadCache: true, apt283Wire: true });
  expect(result.guardResults).toHaveLength(1);
  expect(result.outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" } });
  expect(result.privilegedInstalls).toBe(1);
  expect(result.guardResults[0]).toMatchObject({ exitCode: 0, stderr: "" });
});

test("owned APT cache preparation works with a restrictive caller umask", async () => {
  const previous = process.umask(0o077);
  try {
    const result = await payloadScenario(false, false, { noDownloadCache: true });
    expect(result.outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" } });
    expect(result.privilegedInstalls).toBe(1);
  } finally { process.umask(previous); }
});


test.each(["bytes", "symlink", "hardlink", "inode", "root", "extra", "lock-inode", "lock-bytes", "partial-inode", "partial-extra", "auxfiles-inode", "auxfiles-extra", "mode", "source-bytes"] as const)("changed owned cache %s prevents privileged planning and retains recovery evidence", async (cacheFault) => {
  const result = await payloadScenario(false, false, { noDownloadCache: true, cacheFault });
  expect(result.cacheMutated).toBe(true);
  expect(result.privilegedInstalls).toBe(0);
  expect(result.calls.some((args) => args[0] === "sudo")).toBe(false);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(true);
  if (result.cacheForeignBytes !== undefined) expect(result.cacheForeignBytes).toBe("preserve cache sentinel");
});

test("a preexisting private archive directory is preserved without privileged installation", async () => {
  const result = await payloadScenario(false, false, { noDownloadCache: true, cacheCollision: true });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.calls.some((args) => args[0] === "sudo")).toBe(false);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.cacheForeignBytes).toBe("preserve cache sentinel");
});

test("copied archives with mismatched control identity cannot reach privileged planning", async () => {
  const result = await payloadScenario(false, false, { noDownloadCache: true, cacheControlWrong: true });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.calls.some((args) => args[0] === "sudo")).toBe(false);
  expect(result.outcome.exitCode).toBe(4);
});

test.each(["bytes", "source-bytes", "partial-inode", "auxfiles-inode"] as const)("cache %s changes after simulation stop installation", async (cacheFault) => {
  const result = await payloadScenario(false, false, { noDownloadCache: true, cacheFault, cacheFaultAt: "after-plan" });
  expect(result.privilegedInstalls).toBe(0);
  expect(result.calls.filter((args) => args[0] === "sudo")).toHaveLength(1);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.entries).toContain("apt-transaction-pending.json");
});

test.each(["bytes", "inode"] as const)("the real guard rejects cache %s changes immediately before dpkg", async (cacheFault) => {
  const result = await payloadScenario(false, false, { noDownloadCache: true, cacheFault, cacheFaultAt: "hook" });
  expect(result.guardResults).toHaveLength(1);
  expect(result.guardResults[0]!.exitCode).toBe(100);
  expect(result.privilegedInstalls).toBe(0);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.entries).toContain("apt-transaction-pending.json");
});

test.each(["extra", "lock-inode", "lock-bytes", "partial-extra", "partial-inode", "auxfiles-extra", "auxfiles-inode"] as const)("terminal cache %s uncertainty retains the pending fence and foreign entries", async (cacheFault) => {
  const result = await payloadScenario(false, false, { noDownloadCache: true, cacheFault, cacheFaultAt: "after-install" });
  expect(result.privilegedInstalls).toBe(1);
  expect(result.outcome.exitCode).toBe(5);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(true);
  if (result.cacheForeignBytes !== undefined) expect(result.cacheForeignBytes).toBe("preserve cache sentinel");
});


test("private cache and list scope is identical for local planning and installation without changing acquisition", async () => {
  const result = await payloadScenario(false, false, { noDownloadCache: true, apt283Wire: true, isolatedLocalSources: true });
  expect(result.privilegedInstalls).toBe(1);
  const local = result.calls.filter((args) => args[0] === "sudo");
  expect(local).toHaveLength(2);
  const scope = (args: readonly string[]) => args.filter((arg) => arg.startsWith("Dir::Cache::Archives=") || arg.startsWith("Dir::State::lists="));
  expect(scope(local[0]!)).toEqual(scope(local[1]!));
  expect(scope(local[0]!)).toHaveLength(2);
  expect(local[1]!.some((arg) => arg.endsWith("/archives/docker-ce_5%3a1~fixture+1_amd64.deb"))).toBe(true);
  for (const args of local) {
    expect(args).toContain("Dir::State::status=/var/lib/dpkg/status");
    expect(args).toContain("Debug::NoLocking=false");
    expect(args).toContain("--no-download");
    expect(args).toContain("--no-remove");
    expect(args).toContain("--no-upgrade");
  }
  for (const args of result.calls.filter((args) => args[0] === "apt-get")) expect(scope(args)).toEqual([]);
  expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(false);
  expect(result.entries).not.toContain("apt-transaction-pending.json");
});

// The trusted host fixture models the native filesystem's unreadable retained
// auxiliary directories. Public setup must request separate scoped authority.
test("unreadable retained APT evidence requires a fresh inspection grant without replaying installation", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryInspection: true });
  expect(result.resumed?.exitCode).toBe(3);
  expect(result.resumed?.result.error?.code).toBe("AUTHORITY_REQUIRED");
  expect(result.resumed?.result.data).toMatchObject({ plan: { action: "recovery-inspect", method: "docker-official-apt" }, resumable: true, grantsCreated: false });
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.preservation!.grantsAfter).toBe(result.preservation!.grantsBefore);
  expect(result.preservation!.prompts).toBe(0);
  expect(result.preservation!.calls.some((args) => ["sudo", "apt-get", "dpkg-deb"].includes(args[0]!))).toBe(false);
  expect(result.privilegedInstalls).toBe(1);
});

test("a fresh once inspection grant reconciles current state without changing historical authority", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryInspection: true, inspectionConsent: "once" });
  expect(result.resumed?.exitCode).toBe(4);
  expect(result.resumed?.result.data).toMatchObject({ recovery: { state: "reconciled", historicalOutcome: "unknown", artifacts: "retained" } });
  expect(result.inspections).toBe(1);
  const before = JSON.parse(result.preservation!.grantsBefore).grants;
  const after = JSON.parse(result.preservation!.grantsAfter).grants;
  expect(after.filter((grant: { action: string }) => grant.action !== "recovery-inspect")).toEqual(before);
  expect(after.filter((grant: { action: string }) => grant.action === "recovery-inspect")).toEqual([expect.objectContaining({ mode: "once", revoked: true })]);
  expect(result.preservation!.artifactsAfter).toEqual(result.preservation!.artifactsBefore);
  expect(result.entries).not.toContain("apt-transaction-pending.json");
  expect(result.privilegedInstalls).toBe(1);
});
test.each(["remembered", "deny"] as const)("%s cannot authorize a retained APT inspection", async (inspectionConsent) => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryInspection: true, inspectionConsent });
  expect(result.resumed?.exitCode).toBe(3);
  expect(result.inspections).toBe(0);
  expect(result.preservation!.grantsAfter).toBe(result.preservation!.grantsBefore);
  expect(result.entries).toContain("apt-transaction-pending.json");
});
test("an uncertain inspection consumes only its fresh grant and preserves the original fence", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryInspection: true, inspectionConsent: "once", inspectionFailure: "uncertain", recoveryRetry: true });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.recoveryRetried?.exitCode).toBe(3);
  expect(result.inspections).toBe(1);
  expect(JSON.parse(result.preservation!.grantsAfter).grants.filter((grant: { action: string }) => grant.action === "recovery-inspect")).toEqual([expect.objectContaining({ mode: "once", revoked: true })]);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.entries.some((name) => name.startsWith("apt-reconciled-"))).toBe(false);
  expect(result.preservation!.artifactsAfter).toEqual(result.preservation!.artifactsBefore);
});

test("a durable inspected receipt can resume retirement without consuming another inspection grant", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryInspection: true, inspectionConsent: "once", inspectionCrash: true, recoveryRetry: true });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.recoveryRetried?.exitCode).toBe(4);
  expect(result.inspections).toBe(1);
  expect(result.entries).not.toContain("apt-transaction-pending.json");
  expect(JSON.parse(result.preservation!.grantsAfter).grants.filter((grant: { action: string }) => grant.action === "recovery-inspect")).toHaveLength(1);
});

test.each(["implicit", "--grant"])("a published fresh inspection grant remains consumable after interruption via %s", async (selection) => {
  const inspectionUseGrant = selection === "--grant";
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryInspection: true, inspectionConsent: "once", inspectionPublishCrash: true, recoveryRetry: true, inspectionUseGrant });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.recoveryRetried?.exitCode).toBe(4);
  expect(result.inspections).toBe(1);
  expect(JSON.parse(result.preservation!.grantsAfter).grants.filter((grant: { action: string }) => grant.action === "recovery-inspect")).toEqual([expect.objectContaining({ mode: "once", revoked: true })]);
  expect(result.entries).not.toContain("apt-transaction-pending.json");
});

test("consent-time artifact mutation prevents inspection and creation of new authority", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryInspection: true, inspectionConsent: "once", inspectionConsentMutation: true });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.inspections).toBe(0);
  expect(result.preservation!.grantsAfter).toBe(result.preservation!.grantsBefore);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.entries.some((name) => name.startsWith("apt-reconciled-"))).toBe(false);
});
test("failed durable inspection consumption prevents the privileged read and never restores its grant", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryInspection: true, inspectionConsent: "once", inspectionConsumptionDurability: true });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.inspections).toBe(0);
  expect(JSON.parse(result.preservation!.grantsAfter).grants.filter((grant: { action: string }) => grant.action === "recovery-inspect")).toEqual([expect.objectContaining({ mode: "once", revoked: true })]);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.preservation!.artifactsAfter).toEqual(result.preservation!.artifactsBefore);
});

test.each(["boot", "operation", "remembered", "helper"] as const)("a prior inspection grant cannot cover a different %s binding", async (inspectionGrantMismatch) => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryInspection: true, inspectionConsent: "once", inspectionPublishCrash: true, recoveryRetry: true, inspectionUseGrant: true, inspectionGrantMismatch });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.recoveryRetried?.exitCode).toBe(3);
  expect(result.inspections).toBe(0);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(JSON.parse(result.preservation!.grantsAfter).grants.filter((grant: { action: string }) => grant.action !== "recovery-inspect")).toEqual(JSON.parse(result.preservation!.grantsBefore).grants);
});
test("changed retained auxiliary evidence prevents reuse of a prior inspection receipt", async () => {
  const result = await payloadScenario(false, false, { uncertain: "timeout", reboot: true, recoveryInspection: true, inspectionConsent: "once", inspectionCrash: true, recoveryRetry: true, inspectionReceiptChanged: true });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.recoveryRetried?.exitCode).toBe(5);
  expect(result.inspections).toBe(1);
  expect(result.entries).toContain("apt-transaction-pending.json");
});

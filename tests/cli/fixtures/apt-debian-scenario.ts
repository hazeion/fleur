import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runCli } from "../../../src/cli/main.ts";
import { setupCommands, type HostCommandResult } from "../../../src/setup/commands.ts";
import { dockerRepositoryKey } from "../../../src/setup/docker-key.ts";
import { aptArtifactProtocol, aptFixtureBytes, aptGuardProtocol, aptHealthProtocol, type AptGuardFault } from "./apt-artifacts.ts";
import { debianDependencyProfile, debianDependencyPackages, debianDockerPackages } from "./apt-debian-dependencies.ts";

export interface DebianScenarioOptions {
  readonly absentNftablesRecord?: boolean;
  readonly guardInventory?: readonly string[];
  readonly dependencyNames?: "native" | "foreign" | "duplicate";
  readonly simulationNames?: "native" | "foreign" | "duplicate";
  readonly recoveryHealthNames?: "foreign" | "duplicate";
  readonly present?: readonly string[];
  readonly conflictingVersion?: string;
  readonly consentDrift?: boolean;
  readonly acquisitionDrift?: boolean;
  readonly installDrift?: boolean;
  readonly downloadFault?: "missing" | "hash" | "oversize" | "uncertain" | "rejected";
  readonly downloadCollision?: "file" | "symlink";
  readonly rejectedObservation?: "control" | "initial-simulation";
  readonly extraSimulation?: "initial" | "privileged";
  readonly guardFault?: AptGuardFault;
  readonly guardClosureFault?: "missing-marker" | "wrong-signer" | "declared-digest" | "partial-closure" | "mixed-architecture";
  readonly configuredStatus?: string;
  readonly controlFault?: "version" | "architecture" | "uncertain";
  readonly uncertainSimulation?: "initial" | "privileged";
  readonly interrupted?: boolean;
  readonly recoveryTamper?: boolean;
}
/** Real setup handlers and hook, with only external host/filesystem protocols simulated. */
export async function debianScenario(options: DebianScenarioOptions = {}) {
  const directory = await mkdtemp("/tmp/fleur-debian-apt-contract-");
  const versions: Record<string, string> = { ...debianDockerPackages, ...debianDependencyPackages };
  const configured = new Map((options.present ?? []).map((name) => [name, options.conflictingVersion ?? versions[name]!]));
  const baseline = new Map(configured); const calls: string[][] = []; const prompts: { action: string; target: string; checksum: string }[] = [];
  const outputClaims: { descriptor: number | undefined; output: string | undefined }[] = [];
  let foreignBytes: string | undefined;
  let downloads = 0; let installs = 0; let privilegedPlans = 0; let initialPlans = 0;
  const identity = { system: "linux", architecture: "x64", translated: false, release: "13", distribution: "debian", bootId: "11111111-1111-4111-8111-111111111111", machineId: "a".repeat(64) };
  const done = (stdout = "", exitCode = 0): HostCommandResult => ({ status: "completed", exitCode, stdout, stderr: "" });
  const inventory = (names = options.dependencyNames) => [...(options.absentNftablesRecord && !configured.has("nftables") ? ["nftables\t\tnot-installed\tok"] : []), ...[...configured].flatMap(([name, version]) => {
    const row = (binary: string) => `${binary}\t${version}\t${options.configuredStatus ?? "installed"}\tok`;
    if (!names || !["libjansson4", "libnftables1"].includes(name)) return [row(name)];
    return names === "duplicate" ? [row(name), row(`${name}:amd64`)] : [row(`${name}:${names === "native" ? "amd64" : "arm64"}`)];
  })];
  const simulate = (args: readonly string[], phase: "initial" | "privileged") => {
    if (options.rejectedObservation === "initial-simulation" && phase === "initial") throw new Error("External invocation started; completion observation rejected");
    if (options.uncertainSimulation === phase) return { status: "timeout" as const, stdout: "", stderr: "" };
    const rows = args.slice(args.indexOf("install") + 1).flatMap((path) => {
      const name = path.startsWith("/") ? basename(path).split("_")[0]! : path.split("=")[0]!;
      if (!Object.hasOwn(versions, name)) throw new Error("Unexpected simulation target");
      const qualified = options.simulationNames && ["libjansson4", "libnftables1"].includes(name) ? `${name}:${options.simulationNames === "foreign" ? "arm64" : "amd64"}` : name;
      const result = [`Inst ${qualified} (${versions[name]} fixture [amd64])`, `Conf ${qualified} (${versions[name]} fixture [amd64])`];
      if (options.simulationNames === "duplicate" && qualified !== name) result.push(`Inst ${name} (${versions[name]} fixture [amd64])`);
      return result;
    });
    if (options.extraSimulation === phase) rows.push("Inst foreign-package (1 fixture [amd64])");
    return done(rows.join("\n"));
  };
  let handlers: ReturnType<typeof setupCommands>;
  try {
    handlers = setupCommands({ stateDirectory: join(directory, "state"), interactive: true,
      host: async () => ({ ...identity }), aptPackageLocks: async () => "clear",
      confirmHuman: async (plan) => { prompts.push(plan); return "once"; },
      run: async (args, _timeout, context) => {
        calls.push([...args]);
        const health = aptHealthProtocol(args, inventory(identity.bootId.startsWith("22222222") && options.recoveryHealthNames ? options.recoveryHealthNames : options.dependencyNames)); if (health) return health;
        if (args[0] === "curl") {
          downloads++;
          if (options.downloadFault === "rejected") throw new Error("External acquisition started; completion observation rejected");
          if (options.downloadFault === "missing") return { status: "missing", stdout: "", stderr: "" };
          const artifact = Object.values(debianDependencyProfile.distroDependencies.artifacts).find((item) => item.url === args.at(-1));
          if (!artifact) throw new Error("Unapproved dependency download URL");
          const held = (context as { artifactOutput?: { descriptor: number; maxBytes: number } } | undefined)?.artifactOutput;
          const requestedOutput = args[args.indexOf("--output") + 1]!;
          outputClaims.push({ descriptor: held?.descriptor, output: requestedOutput });
          const path = held ? join(context!.cwd!, basename(new URL(artifact.url).pathname)) : requestedOutput;
          let bytes = aptFixtureBytes(artifact.name, artifact.version);
          if (options.downloadFault === "hash") bytes[bytes.length - 2] = 88;
          if (options.downloadFault === "oversize") bytes = Buffer.concat([bytes, Buffer.from("extra")]);
          if (held && options.downloadCollision) await rename(path, path + ".held-original");
          if (options.downloadCollision) {
            const foreign = join(directory, "foreign-acquisition-sentinel");
            await writeFile(foreign, "preserve foreign acquisition bytes", { flag: "wx", mode: 0o600 });
            if (options.downloadCollision === "symlink") await symlink(foreign, path);
            else await writeFile(path, "preserve foreign acquisition bytes", { flag: "wx", mode: 0o600 });
            // Model curl's real output-open semantics, including O_EXCL when
            // no-clobber is requested and its alternative output on collision.
            if (held) { let used = 0; while (used < bytes.length) used += writeSync(held.descriptor, bytes, used, bytes.length - used); }
            else await writeFile(args.includes("--no-clobber") ? path + ".1" : path, bytes, { flag: args.includes("--no-clobber") ? "wx" : "w", mode: 0o600 });
            foreignBytes = await readFile(options.downloadCollision === "symlink" ? foreign : path, "utf8");
          } else if (held) { let used = 0; while (used < bytes.length) used += writeSync(held.descriptor, bytes, used, bytes.length - used); }
          else await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
          return options.downloadFault === "uncertain" ? { status: "timeout", stdout: "", stderr: "" } : done();
        }
        const artifact = await aptArtifactProtocol(args, context, versions);
        if (artifact) {
          let stdout = artifact.stdout.replaceAll("ubuntu/dists/noble", "debian/dists/trixie");
          if (args[0] === "dpkg-deb" && basename(args[2]!).startsWith("libjansson4_")) {
            if (options.rejectedObservation === "control") throw new Error("External reader started; completion observation rejected");
            if (options.controlFault === "uncertain") return { ...artifact, terminationUnconfirmed: true };
            if (options.controlFault === "version") stdout = stdout.replace("Version: 2.14-2+b3", "Version: 99");
            if (options.controlFault === "architecture") stdout = stdout.replace("Architecture: amd64", "Architecture: arm64");
          }
          return { ...artifact, stdout };
        }
        if (args[0] === "apt-config") return done("APT {};\n");
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "dpkg-query") return done(inventory().join("\n"), configured.size === Object.keys(versions).length ? 0 : 1);
        if (args[0] === "stat" && args.at(-1) === "/etc/nftables.conf") return { ...done("", 1), stderr: "No such file or directory" };
        if (args[0] === "stat") return done(args.at(-1)?.endsWith("docker.asc") || args.at(-1)?.endsWith("docker.sources") ? "regular file|0|644|1\n" : "directory|0|755|2\n");
        if (args[0] === "find") return done(options.consentDrift && prompts.length >= 5 || options.acquisitionDrift && downloads > 0 || options.installDrift && privilegedPlans > 0 ? "/run/systemd/system/nftables.service\n" : "");
        if (args[0] === "systemctl") return done("LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\nFragmentPath=\nDropInPaths=\nTransient=no\n");
        if (args[0] === "cat") return done(args.at(-1)?.endsWith("docker.asc") ? dockerRepositoryKey : "Types: deb\nURIs: https://download.docker.com/linux/debian\nSuites: trixie\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n");
        if (args[0] === "apt-cache") return done(Object.entries(debianDockerPackages).map(([name, version]) => `Package: ${name}\nVersion: ${version}\n`).join("\n"));
        if (args[0] === "apt-get" && args.includes("--simulate")) { initialPlans++; return simulate(args, "initial"); }
        if (args[0] === "sudo" && args.includes("--simulate")) { privilegedPlans++; return simulate(args, "privileged"); }
        if (args[0] === "sudo" && args.includes("install")) {
          let result: HostCommandResult;
          if (options.guardClosureFault) {
            // Feed malformed external hook data with its own checksum, so the
            // real hook must enforce its closure schema beyond byte hashing.
            const planPath = join(dirname(dirname(args[args.indexOf("install") + 1]!)), "apt-plan.json");
            const original = await readFile(planPath);
            const plan = JSON.parse(original.toString()) as Record<string, unknown>;
            const closure = plan.distroDependencies as Record<string, unknown>;
            if (options.guardClosureFault === "missing-marker") Reflect.deleteProperty(plan, "distroDependencies");
            if (options.guardClosureFault === "wrong-signer") closure.signingFingerprint = "A".repeat(40);
            if (options.guardClosureFault === "declared-digest") ((closure.artifacts as Record<string, Record<string, unknown>>).nftables!).sha256 = "a".repeat(64);
            if (options.guardClosureFault === "partial-closure") Reflect.deleteProperty(closure.artifacts as object, "libjansson4");
            if (options.guardClosureFault === "mixed-architecture") (plan.packages as Record<string, unknown>[])[0]!.architecture = "arm64";
            const changed = Buffer.from(JSON.stringify(plan));
            const originalHash = Bun.CryptoHasher.hash("sha256", original, "hex");
            const changedHash = Bun.CryptoHasher.hash("sha256", changed, "hex");
            await writeFile(planPath, changed);
            try { result = await aptGuardProtocol(args.map((arg) => arg.replace(originalHash, changedHash)), versions, inventory()); }
            finally { await writeFile(planPath, original); }
          } else result = await aptGuardProtocol(args, versions, options.guardInventory ?? inventory(), options.guardFault);
          if (result.exitCode !== 0) return result;
          installs++; for (const path of args.slice(args.indexOf("install") + 1)) { const name = basename(path).split("_")[0]!; configured.set(name, versions[name]!); }
          return options.interrupted ? { status: "timeout", stdout: "", stderr: "" } : result;
        }
        throw new Error("Unexpected Debian external operation: " + args.join(" "));
      },
    }, [debianDependencyProfile]);
    const outcome = await runCli(["setup"], { cwd: directory, handlers });
    let pending: { operationId: string; artifacts: { root: string; entries: { path: string; directory: boolean }[] } } | undefined; let doctor; let sameBoot; let resumed; let beforeRecovery; let afterRecovery;
    if (options.interrupted && installs) {
      const pendingPath = join(directory, "state/apt-transaction-pending.json");
      const retained = JSON.parse(await readFile(pendingPath, "utf8")) as NonNullable<typeof pending>;
      pending = retained;
      const snapshot = async () => JSON.stringify(await Promise.all(retained.artifacts.entries.map(async (entry: { path: string; directory: boolean }) => ({ path: entry.path, sha256: entry.directory ? null : Bun.CryptoHasher.hash("sha256", await readFile(join(directory, "state", retained.artifacts.root, entry.path)), "hex") }))));
      beforeRecovery = { artifacts: await snapshot(), grants: await readFile(join(directory, "state/grants.json"), "utf8") };
      doctor = await runCli(["doctor", "--json"], { cwd: directory, handlers });
      sameBoot = await runCli(["setup", "--json"], { cwd: directory, handlers });
      identity.bootId = "22222222-2222-4222-8222-222222222222";
      if (options.recoveryTamper) {
        const entry = retained.artifacts.entries.find((entry: { path: string }) => entry.path.startsWith("nftables/") && entry.path.endsWith(".deb"));
        if (!entry) throw new Error("Missing retained dependency fixture");
        await writeFile(join(directory, "state", retained.artifacts.root, entry.path), "preserve changed dependency");
      }
      resumed = await runCli(["setup", "--json"], { cwd: directory, handlers });
      afterRecovery = { artifacts: await snapshot(), grants: await readFile(join(directory, "state/grants.json"), "utf8") };
    }
    return { outcome, calls, prompts, outputClaims, foreignBytes, downloads, installs, initialPlans, privilegedPlans, baseline: [...baseline], configured: [...configured], pending, doctor, sameBoot, resumed, beforeRecovery, afterRecovery, entries: await readdir(join(directory, "state")).catch((error: { code?: string }) => { if (error.code === "ENOENT") return []; throw error; }) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

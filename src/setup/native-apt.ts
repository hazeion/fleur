import { setupLinuxAccess } from "./linux-access.ts";
import { aptServicePolicy } from "./apt-service.ts";
import { setupAptService } from "./apt-service.ts";
import { aptHealthArgs, healthyDpkgSnapshot } from "./apt-health.ts";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AptPayloadStage, AptPayloadUnavailable, AptPayloadRecovery } from "./apt-payloads.ts";
import { ensureAptRepository } from "./apt-repository.ts";
import type { CommandInput } from "../cli/catalog.ts";
import { failure, type CliOutcome } from "../cli/result.ts";
import type { HostIdentity, SetupHost, HostCommandContext } from "./commands.ts";
import { readGrants, stateDirectory, writeGrants, type Grant } from "./grants.ts";
import { SetupBusy, withSetupLock, syncStateDirectory } from "./lock.ts";
import { inspectAptPackageState, validAptProfile, type AptInstallProfile, type AptPackageName } from "./native.ts";

/** Reject every unrecognized simulation operation; prose is a small fail-closed grammar. */
function exactSimulation(stdout: string, packages: Readonly<Record<string, string>>): boolean {
  const installed = new Set<string>();
  const configured = new Set<string>();
  for (const line of stdout.split("\n").filter((value) => value.trim())) {
    const operation = /^(Inst|Conf) ([a-z0-9.-]+) \(([^ ]+) [^\r\n]*\)$/.exec(line);
    if (operation) {
      const [, action, name, version] = operation;
      if (!name || !Object.hasOwn(packages, name) || packages[name] !== version) return false;
      const seen = action === "Inst" ? installed : configured;
      if (seen.has(name)) return false;
      seen.add(name);
      continue;
    }
    if (/^(?:Reading package lists|Building dependency tree|Reading state information)\.\.\.$/.test(line)) continue;
    if (/^The following (?:NEW packages will be installed|additional packages will be installed):$/.test(line)) continue;
    if (/^0 upgraded, [0-9]+ newly installed, 0 to remove and [0-9]+ not upgraded\.$/.test(line)) continue;
    if (/^  [a-z0-9. -]+$/.test(line) && line.trim().split(/\s+/).every((name) => Object.hasOwn(packages, name))) continue;
    return false;
  }
  return installed.size === Object.keys(packages).length;
}

export async function setupNativeApt(input: CommandInput, host: SetupHost, identity: HostIdentity, profile: AptInstallProfile, remaining: () => number, existingCli = false, endpoint?: string, daemonReady = false, daemonDenied = false): Promise<CliOutcome> {
  if (!validAptProfile(profile) || !identity.machineId || !/^[a-f0-9]{64}$/.test(identity.machineId)) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The compiled native installation profile is not verified.", actions: [] });
  const requiredAuthorities = ["install", "configuration", "docker-access", "service-start", "service-enable"] as const;
  const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify(profile), "hex");
  const target = `Docker ${profile.distribution} ${profile.release} ${profile.architecture} profile ${checksum}`;
  try {
    return await withSetupLock(stateDirectory(host), async () => {
      const actual = await inspectAptPackageState(profile, host, remaining);
      const diagnostic = { packageState: { state: actual.state, present: [...actual.present], missing: [...actual.missing] } };
      if (actual.state !== "compatible") return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Existing or indeterminate packages were preserved; native setup will not upgrade or repair them automatically.", actions: [] }, diagnostic);
      if (existingCli && !actual.present.includes("docker-ce-cli")) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The existing Docker CLI is not accounted for by the exact configured package profile. It was preserved; native setup will not replace an unknown tool.", actions: [] }, { packageState: { state: "conflict", present: [...actual.present], missing: [...actual.missing] } });
      const pendingPath = join(stateDirectory(host), "apt-transaction-pending.json");
      try { await lstat(pendingPath); return failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "An earlier privileged APT transaction has no confirmed terminal result; its private artifacts were preserved.", actions: [] }, { ...diagnostic, resumable: true }); }
      catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
      if (actual.missing.length === 0 && daemonDenied && endpoint) return setupLinuxAccess(input, host, identity, aptServicePolicy(profile), remaining, endpoint);
      if (actual.missing.length === 0 && !daemonReady && endpoint) return setupAptService(input, host, identity, profile, remaining, endpoint);
      if (actual.missing.length === 0) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Exact packages are already configured. Run doctor to verify service access and disposable smoke readiness.", actions: [{ command: "fleur doctor", description: "Verify the installed native prerequisites." }] }, diagnostic);
      const specified = input.args[0] === "--grant" ? input.args[1] : undefined;
      if (specified && !(await readGrants(host)).some((grant) => grant.id === specified && !grant.revoked && grant.action === "install" && grant.method === profile.method && grant.target === target && grant.planChecksum === checksum && grant.machine === identity.machineId && grant.user === process.getuid?.())) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "The selected native installation grant does not cover this exact plan.", actions: [] });
      for (const action of requiredAuthorities) {
        const grants = [...await readGrants(host)];
        let grant = grants.find((candidate) => !candidate.revoked && candidate.action === action && (action !== "install" || !specified || candidate.id === specified) && candidate.method === profile.method && candidate.target === target && candidate.planChecksum === checksum && candidate.machine === identity.machineId && candidate.user === process.getuid?.());
        if (!grant && !specified && !input.json && host.interactive && host.confirmHuman) {
          const decision = await host.confirmHuman({ action, method: profile.method, target, checksum }, remaining());
          if (decision === "once" || decision === "remembered") {
            grant = { id: crypto.randomUUID(), action, method: profile.method, target, planChecksum: checksum, machine: identity.machineId!, user: process.getuid!(), mode: decision, revoked: false } satisfies Grant;
            grants.push(grant);
            await writeGrants(host, grants);
          }
        }
        if (!grant) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "Package installation can configure AppArmor, create the Docker access group, and start or enable services. Each side effect requires its own matching human grant before installation.", actions: [{ command: "fleur setup", description: "Inspect the separately scoped native installation permissions." }] }, { ...diagnostic, plan: { verified: true, requiredAuthorities, checksum, target }, resumable: true });
      }
      const run = (args: readonly string[], context?: HostCommandContext) => remaining() > 0 ? host.run(args, remaining(), context) : Promise.resolve({ status: "timeout" as const, stdout: "", stderr: "" });
      const suite = profile.distribution === "debian" ? "trixie" : profile.release === "24.04" ? "noble" : "resolute";
      const architecture = profile.architecture === "x64" ? "amd64" : "arm64";
      const expectedSource = `Types: deb\nURIs: https://download.docker.com/linux/${profile.distribution}\nSuites: ${suite}\nComponents: stable\nArchitectures: ${architecture}\nSigned-By: /etc/apt/keyrings/docker.asc`;
      const repository = await ensureAptRepository(input, host, identity, profile, target, checksum, expectedSource, remaining);
      if (repository) return repository;
      const sourceOptions = ["-o", "RootDir=/", "-o", "Dir::State::status=/var/lib/dpkg/status", "-o", "Debug::NoLocking=false", "-o", "APT::Get::AllowUnauthenticated=false", "-o", "Acquire::AllowInsecureRepositories=false", "-o", "DPkg::Options::=--root=/", "-o", "DPkg::Options::=--admindir=/var/lib/dpkg", "-o", "Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.sources", "-o", "Dir::Etc::sourceparts=-"];
      const missingPackages = Object.fromEntries(Object.entries(profile.packages).filter(([name]) => actual.missing.includes(name)));
      const packages = Object.entries(missingPackages).map(([name, version]) => `${name}=${version}`);
      const dependencyPolicy = ["--no-install-recommends", "--no-install-suggests"];
      const simulationOutput = ["--quiet=2", "-o", "APT::Get::Show-User-Simulation-Note=false"];
      const simulated = await run(["apt-get", ...sourceOptions, ...dependencyPolicy, ...simulationOutput, "--simulate", "--no-remove", "--no-upgrade", "install", ...packages]);
      if (simulated.status !== "completed" || simulated.exitCode !== 0 || !exactSimulation(simulated.stdout, missingPackages)) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The package plan requires changes outside the exact verified missing package set; existing software was preserved.", actions: [] });
      const beforeInstall = await inspectAptPackageState(profile, host, remaining);
      if (beforeInstall.state !== "compatible" || JSON.stringify(beforeInstall) !== JSON.stringify(actual)) return failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "Package state changed during planning. Reprobe before resuming; no packages were installed by this action.", actions: [] }, { packageState: { state: beforeInstall.state, present: [...beforeInstall.present], missing: [...beforeInstall.missing] }, resumable: true });
      const fullHealth = await run(aptHealthArgs, { outputLimitBytes: 2097152 });
      if (fullHealth.status !== "completed" || fullHealth.exitCode !== 0 || fullHealth.terminationUnconfirmed || !healthyDpkgSnapshot(fullHealth.stdout)) return failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "The complete host package state is unavailable or contains pending/error work. Setup will not acquire artifacts or repair unrelated packages.", actions: [] }, { resumable: true });
      const matches = (candidate: Grant, action: string) => !candidate.revoked && candidate.action === action && (action !== "install" || !specified || candidate.id === specified) && candidate.method === profile.method && candidate.target === target && candidate.planChecksum === checksum && candidate.machine === identity.machineId && candidate.user === process.getuid?.();
      let acquisitionLease: Grant | undefined;
      const leaseMatches = (candidate: Grant) => acquisitionLease !== undefined && Object.entries(acquisitionLease).every(([key, value]) => candidate[key as keyof Grant] === value);
      const authorizeAcquisition = async () => {
        const grants = [...await readGrants(host)];
        if (requiredAuthorities.filter((action) => action !== "install").some((action) => !grants.some((candidate) => matches(candidate, action)))) throw new Error("Acquisition authority changed");
        if (acquisitionLease) {
          if (!grants.some(leaseMatches)) throw new Error("Acquisition lease changed");
          return;
        }
        const install = grants.find((candidate) => matches(candidate, "install"));
        if (!install) throw new Error("Installation authority changed before acquisition");
        if (install.mode === "once") {
          acquisitionLease = { ...install, revoked: true };
          await writeGrants(host, grants.map((candidate) => candidate.id === install.id ? acquisitionLease! : candidate));
        } else acquisitionLease = install;
      };
      const stage = await AptPayloadStage.create(stateDirectory(host));
      let retain = false;
      const action = async (): Promise<CliOutcome> => {
      try {
        await stage.acquire(host, profile, Object.keys(missingPackages), sourceOptions, remaining, authorizeAcquisition);
        const fresh = await inspectAptPackageState(profile, host, remaining);
        if (JSON.stringify(fresh) !== JSON.stringify(actual)) throw new AptPayloadRecovery("Package state changed after archive verification");
        for (const [index, name] of Object.keys(missingPackages).entries()) await stage.verify(stage.paths[index]!, profile, name as AptPackageName, remaining);
        const guardPackages = await Promise.all(Object.keys(missingPackages).map(async (name, index) => ({ name, version: profile.packages[name as AptPackageName], architecture: profile.artifacts[name as AptPackageName].architecture, sha256: profile.artifacts[name as AptPackageName].sha256, size: profile.artifacts[name as AptPackageName].size, path: stage.paths[index]!, ...await stage.fileIdentity(stage.paths[index]!) })));
        const guardBytes = Buffer.from(JSON.stringify({ formatVersion: 1, user: process.getuid!(), packages: guardPackages, present: Object.fromEntries(actual.present.map((name) => [name, profile.packages[name as AptPackageName]])) }));
        const planPath = await stage.writeOwned("apt-plan.json", guardBytes);
        const guardChecksum = Bun.CryptoHasher.hash("sha256", guardBytes, "hex");
        if (!/^[A-Za-z0-9_./@+%~-]+$/.test(process.execPath)) throw new AptPayloadUnavailable("The Bun executable path cannot be safely framed for the standard APT tool protocol");
        const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
        const helper = fileURLToPath(new URL("./apt-pre-install.ts", import.meta.url));
        const command = `${process.execPath} ${[helper, planPath, guardChecksum].map(quote).join(" ")}`;
        const guardOptions = ["-o", `DPkg::Pre-Install-Pkgs::=${command}`, "-o", `DPkg::Tools::Options::${process.execPath}::Version=2`, "-o", `DPkg::Tools::Options::${process.execPath}::InfoFD=0`];
        await authorizeAcquisition();
        const grants = [...await readGrants(host)];
        if (!grants.some(leaseMatches)) throw new Error("Installation lease changed before the privileged step");
        const covered = requiredAuthorities.filter((action) => action !== "install").map((action) => grants.find((candidate) => matches(candidate, action)));
        if (covered.some((grant) => !grant)) throw new Error("Privileged step authority changed");
        const once = new Set(covered.filter((grant) => grant?.mode === "once").map((grant) => grant!.id));
        const privilegedLeases = covered.map((grant) => once.has(grant!.id) ? { ...grant!, revoked: true } : grant!);
        await writeGrants(host, grants.map((grant) => once.has(grant.id) ? { ...grant, revoked: true } : grant));
        const fence = await open(pendingPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        retain = true;
        try { await fence.writeFile(JSON.stringify({ formatVersion: 1, checksum })); await fence.sync(); } finally { await fence.close(); }
        await (host.syncDirectory ?? syncStateDirectory)(stateDirectory(host));
        const clearFence = async () => { await unlink(pendingPath); await (host.syncDirectory ?? syncStateDirectory)(stateDirectory(host)); retain = false; };
        const localPlan = await run(["sudo", "-n", "apt-get", ...sourceOptions, ...guardOptions, ...dependencyPolicy, ...simulationOutput, "--simulate", "--no-download", "--no-remove", "--no-upgrade", "install", ...stage.paths]);
        if (localPlan.status === "timeout" || localPlan.terminationUnconfirmed) throw new AptPayloadRecovery("The privileged local-archive simulation has no confirmed terminal result");
        if (localPlan.status !== "completed" || localPlan.exitCode !== 0 || !exactSimulation(localPlan.stdout, missingPackages)) {
          const state = await inspectAptPackageState(profile, host, remaining);
          if (state.state !== "compatible" || JSON.stringify(state) !== JSON.stringify(actual)) throw new AptPayloadRecovery("Package state changed during privileged simulation");
          await clearFence();
          return failure("setup", localPlan.exitCode === 0 ? 4 : 3, { code: localPlan.exitCode === 0 ? "PREREQUISITE_UNAVAILABLE" : "HUMAN_ACTION_REQUIRED", message: "The privileged local-archive plan is unavailable or requires changes outside the exact missing set; no package installation was requested.", actions: [] }, { resumable: true });
        }
        const stillGranted = [...await readGrants(host)];
        if (!stillGranted.some(leaseMatches) || privilegedLeases.some((lease) => !stillGranted.some((candidate) => Object.entries(lease).every(([key, value]) => candidate[key as keyof Grant] === value)))) throw new AptPayloadRecovery("Privileged action authority changed after simulation");
        const stable = await inspectAptPackageState(profile, host, remaining);
        if (JSON.stringify(stable) !== JSON.stringify(actual)) throw new AptPayloadRecovery("Package state changed before local archive installation");
        for (const [index, name] of Object.keys(missingPackages).entries()) await stage.verify(stage.paths[index]!, profile, name as AptPackageName, remaining);
        const installed = await run(["sudo", "-n", "apt-get", ...sourceOptions, ...guardOptions, ...dependencyPolicy, "--assume-yes", "--no-download", "--no-remove", "--no-upgrade", "install", ...stage.paths]);
        if (installed.status === "timeout" || installed.terminationUnconfirmed) throw new AptPayloadRecovery("The privileged transaction has no confirmed terminal result");
        if (installed.status === "completed" && installed.exitCode === 0 && installed.stdout.split("\n").filter((line) => line === `[fleur-apt-guard] ${guardChecksum}`).length !== 1) throw new AptPayloadRecovery("The completed package command did not confirm the actual archive guard");
        const final = await inspectAptPackageState(profile, host, remaining);
        const finalDiagnostic = { packageState: { state: final.state, present: [...final.present], missing: [...final.missing] }, resumable: true };
        if (final.state !== "compatible") throw new AptPayloadRecovery("The package database requires recovery after the terminal command");
        await clearFence();
        if (installed.status !== "completed" || installed.exitCode !== 0) return failure("setup", 3, { code: "HUMAN_ACTION_REQUIRED", message: "The package command ended without completing installation. Reprobe actual configured packages before resuming; consumed once authority cannot replay.", actions: [] }, { ...finalDiagnostic, setupAction: { action: "install", state: "incomplete" } });
        if (final.missing.length) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The completed package command did not establish the exact installed state.", actions: [] }, finalDiagnostic);
        return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Exact verified packages are installed. Run doctor to verify service access and disposable smoke readiness.", actions: [{ command: "fleur doctor", description: "Verify the installed native prerequisites." }] }, { setupAction: { action: "install", state: "completed", packages: [...actual.missing] }, ...finalDiagnostic });
      } catch (error) {
        if (error instanceof AptPayloadRecovery) retain = true;
        if (error instanceof AptPayloadUnavailable) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: error.message, actions: [] }, { resumable: true });
        throw error;
      }
      };
      let outcome: CliOutcome | undefined;
      let actionError: unknown;
      try { outcome = await action(); } catch (error) { actionError = error; }
      if (!retain && !await stage.cleanup()) throw new AptPayloadRecovery("Private APT artifacts could not be safely cleaned up");
      if (actionError) throw actionError;
      if (!outcome) throw new Error("The APT action produced no outcome");
      return outcome;

    }, host.syncDirectory);
  } catch (error) { return failure("setup", 5, { code: error instanceof SetupBusy ? "MAINTENANCE_BUSY" : "RECOVERY_REQUIRED", message: "Native setup is blocked by concurrent work or unsafe authority state.", actions: [] }); }
}

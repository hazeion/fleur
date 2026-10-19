import { ensureAptRepository } from "./apt-repository.ts";
import type { CommandInput } from "../cli/catalog.ts";
import { failure, type CliOutcome } from "../cli/result.ts";
import type { HostIdentity, SetupHost } from "./commands.ts";
import { readGrants, stateDirectory, writeGrants, type Grant } from "./grants.ts";
import { SetupBusy, withSetupLock } from "./lock.ts";
import { inspectAptInstallation, validAptProfile, type AptInstallProfile } from "./native.ts";

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

export async function setupNativeApt(input: CommandInput, host: SetupHost, identity: HostIdentity, profile: AptInstallProfile, remaining: () => number): Promise<CliOutcome> {
  if (!validAptProfile(profile) || !identity.machineId || !/^[a-f0-9]{64}$/.test(identity.machineId)) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The compiled native installation profile is not verified.", actions: [] });
  const requiredAuthorities = ["install", "configuration", "docker-access", "service-start", "service-enable"] as const;
  const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify(profile), "hex");
  const target = `Docker ${profile.distribution} ${profile.release} ${profile.architecture} profile ${checksum}`;
  try {
    return await withSetupLock(stateDirectory(host), async () => {
      const actual = await inspectAptInstallation(profile, host, remaining);
      if (actual !== "absent") return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Existing or indeterminate packages were preserved; native setup will not upgrade or repair them automatically.", actions: [] });
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
        if (!grant) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "Package installation can configure AppArmor, create the Docker access group, and start or enable services. Each side effect requires its own matching human grant before installation.", actions: [{ command: "fleur setup", description: "Inspect the separately scoped native installation permissions." }] }, { plan: { verified: true, requiredAuthorities, checksum, target }, resumable: true });
      }
      const run = (args: readonly string[]) => remaining() > 0 ? host.run(args, remaining()) : Promise.resolve({ status: "timeout" as const, stdout: "", stderr: "" });
      const suite = profile.distribution === "debian" ? "trixie" : profile.release === "24.04" ? "noble" : "resolute";
      const architecture = profile.architecture === "x64" ? "amd64" : "arm64";
      const expectedSource = `Types: deb\nURIs: https://download.docker.com/linux/${profile.distribution}\nSuites: ${suite}\nComponents: stable\nArchitectures: ${architecture}\nSigned-By: /etc/apt/keyrings/docker.asc`;
      const repository = await ensureAptRepository(input, host, identity, profile, target, checksum, expectedSource, remaining);
      if (repository) return repository;
      const sourceOptions = ["-o", "Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.sources", "-o", "Dir::Etc::sourceparts=-"];
      const packages = Object.entries(profile.packages).map(([name, version]) => `${name}=${version}`);
      const simulated = await run(["apt-get", ...sourceOptions, "--simulate", "--no-remove", "--no-upgrade", "install", ...packages]);
      if (simulated.status !== "completed" || simulated.exitCode !== 0 || !exactSimulation(simulated.stdout, profile.packages)) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The package plan requires changes outside the exact verified missing package set; existing software was preserved.", actions: [] });
      // Re-read all authority after probes and consume every implicit side-effect permission
      // durably in one publication before apt can start or enable its service.
      let grants = [...await readGrants(host)];
      const covered = requiredAuthorities.map((action) => grants.find((candidate) => !candidate.revoked && candidate.action === action && (action !== "install" || !specified || candidate.id === specified) && candidate.method === profile.method && candidate.target === target && candidate.planChecksum === checksum && candidate.machine === identity.machineId && candidate.user === process.getuid?.()));
      if (covered.some((grant) => !grant)) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "Native setup authority changed before package installation.", actions: [] });
      const once = new Set(covered.filter((grant) => grant?.mode === "once").map((grant) => grant!.id));
      grants = grants.map((grant) => once.has(grant.id) ? { ...grant, revoked: true } : grant);
      await writeGrants(host, grants);
      const installed = await run(["sudo", "-n", "apt-get", ...sourceOptions, "--assume-yes", "--no-remove", "--no-upgrade", "install", ...packages]);
      if (installed.status !== "completed" || installed.exitCode !== 0) return failure("setup", 3, { code: "HUMAN_ACTION_REQUIRED", message: "Native installation did not complete without human OS authentication. Reprobe before retrying; consumed once grants cannot replay.", actions: [] }, { resumable: true, setupAction: { action: "install", state: "incomplete" } });
      if (await inspectAptInstallation(profile, host, remaining) !== "installed") return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Package installation returned without the required exact package state.", actions: [] }, { resumable: true });
      return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Exact packages are installed. Run doctor to verify service access and disposable smoke readiness.", actions: [{ command: "fleur doctor", description: "Verify the installed native prerequisites." }] }, { setupAction: { action: "install", state: "completed" }, resumable: true });
    }, host.syncDirectory);
  } catch (error) { return failure("setup", 5, { code: error instanceof SetupBusy ? "MAINTENANCE_BUSY" : "RECOVERY_REQUIRED", message: "Native setup is blocked by concurrent work or unsafe authority state.", actions: [] }); }
}

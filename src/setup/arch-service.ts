import { archServicePendingPath } from "./service-pending.ts";
import { serviceObservation, setupLinuxService, type LinuxServicePolicy } from "./linux-service.ts";
import { failure, type CliOutcome } from "../cli/result.ts";
import type { CommandInput } from "../cli/catalog.ts";
import type { HostIdentity, SetupHost } from "./commands.ts";
import type { ArchInstallProfile } from "./native-arch.ts";
const units = ["docker.service", "docker.socket", "containerd.service"] as const;
const hashes: Readonly<Record<string, string>> = {
  "docker.service": "a12d90fd03761bf79659a185c4a2c40e08934d7ada9e05130e64bd5eb4d634aa",
  "docker.socket": "96cd0d89474816ddfb03893b44c36e7d744254aed1bf6d30eca65ff396114656",
  "containerd.service": "7522a4e33c633f22fc0049d3c075b552f7df30cd978acd0175b972bdebc922ea",
};
async function provenance(host: SetupHost, remaining: () => number, profile: ArchInstallProfile): Promise<void> {
  if (remaining() <= 0) throw new Error("Arch health deadline");
  const lock = await host.run(["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", "/var/lib/pacman/db.lck"], remaining());
  if (lock.status !== "completed" || lock.terminationUnconfirmed || lock.exitCode !== 1 || lock.stdout.trim() || !/No such file or directory/.test(lock.stderr)) throw new Error("Arch package lock unavailable");
  if ((await serviceObservation(host, remaining, ["/usr/bin/pacman", "--database", "--check", "--quiet"])).trim()) throw new Error("Arch package health is indeterminate");
  const names = Object.keys(profile.packages).sort() as (keyof ArchInstallProfile["packages"])[];
  const inventory = await serviceObservation(host, remaining, ["/usr/bin/pacman", "--query", "--", ...names]);
  if (JSON.stringify(inventory.trim().split("\n").sort()) !== JSON.stringify(names.map((name) => `${name} ${profile.packages[name].version}`))) throw new Error("Package provenance changed");
  for (const unit of units) {
    const path = `/usr/lib/systemd/system/${unit}`;
    if (!/^regular file\|0\|(?:644|444)\|1\s*$/.test(await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", path]))) throw new Error("Unsafe unit file");
    if ((await serviceObservation(host, remaining, ["/usr/bin/pacman", "--query", "--owns", "--quiet", "--", path])).trim() !== (unit === "containerd.service" ? "containerd" : "docker")) throw new Error("Unit package ownership changed");
    if ((await serviceObservation(host, remaining, ["/usr/bin/sha256sum", "--", path])).trim() !== `${hashes[unit]}  ${path}`) throw new Error("Unit content differs from authenticated archive");
  }
  for (const [path, owner, mode] of [["/usr/bin/systemctl", "systemd", "755"], ["/usr/bin/sudo", "sudo", "4755"]]) {
    if ((await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", path!])).trim() !== `regular file|0|${mode}|1` || (await serviceObservation(host, remaining, ["/usr/bin/pacman", "--query", "--owns", "--quiet", "--", path!])).trim() !== owner) throw new Error("Untrusted service control tool");
  }
}
/** Caller holds the existing setup lock and checked exact package state/pending fence. */
export async function setupArchService(input: CommandInput, host: SetupHost, identity: HostIdentity, profile: ArchInstallProfile, remaining: () => number, endpoint?: string): Promise<CliOutcome> {
  if (profile.packages.docker.sha256 !== "3cc00845b632f3302fe148b939c2736a094599d42e885aab214a5a532bd87d54" || profile.packages.containerd.sha256 !== "c352b4c019c3d527daa50517a6420a7672b01876b95b80d72dd7192f05220999") return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Exact installed packages do not establish an admitted local service action.", actions: [] });
  return setupLinuxService(input, host, identity, archServicePolicy(profile), remaining, endpoint);
}
/** Source-owned exact Arch artifact policy; no CLI policy construction. */
export function archServicePolicy(profile: ArchInstallProfile): LinuxServicePolicy {
  if (profile.packages.docker.sha256 !== "3cc00845b632f3302fe148b939c2736a094599d42e885aab214a5a532bd87d54" || profile.packages.containerd.sha256 !== "c352b4c019c3d527daa50517a6420a7672b01876b95b80d72dd7192f05220999") throw new Error("No authenticated Arch service binding");
  return { method: profile.method, label: "Arch", membershipTool: "arch-shadow", binding: profile, hashes, pendingPath: archServicePendingPath, fragmentPaths: (unit) => [`/usr/lib/systemd/system/${unit}`], provenance: (target, budget) => provenance(target, budget, profile) };
}

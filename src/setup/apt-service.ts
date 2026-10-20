import { serviceObservation, setupLinuxService } from "./linux-service.ts";
import { aptServicePendingPath } from "./service-pending.ts";
import { hasAptServiceBinding } from "./apt-service-bindings.ts";
import { aptHealthArgs, healthyDpkgSnapshot } from "./apt-health.ts";
import { inspectAptPackageState, type AptInstallProfile } from "./native.ts";
import { failure, type CliOutcome } from "../cli/result.ts";
import type { CommandInput } from "../cli/catalog.ts";
import type { HostIdentity, SetupHost } from "./commands.ts";
const hashes: Readonly<Record<string, string>> = {
  "docker.service": "a12d90fd03761bf79659a185c4a2c40e08934d7ada9e05130e64bd5eb4d634aa",
  "docker.socket": "96cd0d89474816ddfb03893b44c36e7d744254aed1bf6d30eca65ff396114656",
  "containerd.service": "bd1effcf6d9cd564c232b631b353b2758f174160e3d8c078a792363b59f113d0",
};
async function provenance(host: SetupHost, remaining: () => number, profile: AptInstallProfile): Promise<void> {
  const actual = await inspectAptPackageState(profile, host, remaining);
  if (actual.state !== "compatible" || actual.missing.length !== 0) throw new Error("Configured packages changed");
  if (remaining() <= 0) throw new Error("Package health deadline");
  const health = await host.run(aptHealthArgs, remaining(), { outputLimitBytes: 2097152 });
  const snapshot = health.status === "completed" && health.exitCode === 0 && !health.terminationUnconfirmed ? healthyDpkgSnapshot(health.stdout) : null;
  if (!snapshot || Object.entries(profile.packages).some(([name, version]) => snapshot.get(name)?.version !== version || snapshot.get(name)?.status !== "installed")) throw new Error("Host package state unavailable");
  for (const [unit, hash] of Object.entries(hashes)) {
    const archivePath = `${unit === "containerd.service" ? "/lib" : "/usr/lib"}/systemd/system/${unit}`;
    const canonicalPath = `/usr/lib/systemd/system/${unit}`;
    for (const path of [archivePath, canonicalPath]) if ((await serviceObservation(host, remaining, ["/usr/bin/readlink", "--canonicalize-existing", "--", path])).trim() !== canonicalPath) throw new Error("Unexpected unit path alias");
    if ((await serviceObservation(host, remaining, ["/usr/bin/dpkg-query", "--root=/", "--admindir=/var/lib/dpkg", "--search", "--", archivePath])).trim() !== `${unit === "containerd.service" ? "containerd.io" : "docker-ce"}: ${archivePath}`) throw new Error("Unit ownership differs");
    if (!/^regular file\|0\|(?:644|444)\|1\s*$/.test(await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", canonicalPath]))) throw new Error("Unsafe unit file");
    if ((await serviceObservation(host, remaining, ["/usr/bin/sha256sum", "--", canonicalPath])).trim() !== `${hash}  ${canonicalPath}`) throw new Error("Unit content differs from authenticated package");
  }
  for (const [path, owner, mode] of [["/usr/bin/systemctl", "systemd", "755"], ["/usr/bin/sudo", "sudo", "4755"]]) {
    if ((await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", path!])).trim() !== `regular file|0|${mode}|1` || (await serviceObservation(host, remaining, ["/usr/bin/dpkg-query", "--root=/", "--admindir=/var/lib/dpkg", "--search", "--", path!])).trim() !== `${owner}: ${path}`) throw new Error("Service control tool ownership changed");
  }

}
/** Called only under the existing setup lock after exact installed-state inspection. */
export async function setupAptService(input: CommandInput, host: SetupHost, identity: HostIdentity, profile: AptInstallProfile, remaining: () => number, endpoint?: string): Promise<CliOutcome> {
  if (!hasAptServiceBinding(profile)) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The exact installed artifacts have no authenticated service policy.", actions: [] });
  return setupLinuxService(input, host, identity, { method: profile.method, label: "APT", binding: profile, hashes, pendingPath: aptServicePendingPath, fragmentPaths: (unit) => unit === "containerd.service" ? [`/usr/lib/systemd/system/${unit}`, `/lib/systemd/system/${unit}`] : [`/usr/lib/systemd/system/${unit}`], provenance: (target, budget) => provenance(target, budget, profile), prestartEffects: { unit: "containerd.service", command: "-/sbin/modprobe overlay", effect: "Vendor pre-start may load the overlay kernel module; OS policy is unchanged." } }, remaining, endpoint);
}

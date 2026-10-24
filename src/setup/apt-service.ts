import { serviceObservation, setupLinuxService, type LinuxServicePolicy } from "./linux-service.ts";
import { aptServicePendingPath } from "./service-pending.ts";
import { hasAptServiceBinding } from "./apt-service-bindings.ts";
import { aptHealthArgs, healthyDpkgSnapshot } from "./apt-health.ts";
import { aptPackageVersions, canonicalAptSnapshot } from "./apt-dependencies.ts";
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
  const snapshot = health.status === "completed" && health.exitCode === 0 && !health.terminationUnconfirmed ? canonicalAptSnapshot(profile.distroDependencies, healthyDpkgSnapshot(health.stdout)) : null;
  if (!snapshot || Object.entries(aptPackageVersions(profile)).some(([name, version]) => snapshot.get(name)?.version !== version || snapshot.get(name)?.status !== "installed")) throw new Error("Host package state unavailable");
  for (const [unit, hash] of Object.entries(hashes)) {
    const archivePath = `${unit === "containerd.service" ? "/lib" : "/usr/lib"}/systemd/system/${unit}`;
    const canonicalPath = `/usr/lib/systemd/system/${unit}`;
    for (const path of [archivePath, canonicalPath]) if ((await serviceObservation(host, remaining, ["/usr/bin/readlink", "--canonicalize-existing", "--", path])).trim() !== canonicalPath) throw new Error("Unexpected unit path alias");
    if ((await serviceObservation(host, remaining, ["/usr/bin/dpkg-query", "--root=/", "--admindir=/var/lib/dpkg", "--search", "--", archivePath])).trim() !== `${unit === "containerd.service" ? "containerd.io" : "docker-ce"}: ${archivePath}`) throw new Error("Unit ownership differs");
    if (!/^regular file\|0\|(?:644|444)\|1\s*$/.test(await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", canonicalPath]))) throw new Error("Unsafe unit file");
    if ((await serviceObservation(host, remaining, ["/usr/bin/sha256sum", "--", canonicalPath])).trim() !== `${hash}  ${canonicalPath}`) throw new Error("Unit content differs from authenticated package");
  }
  const sudoState = (await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", "/usr/bin/sudo"])).trim();
  const alternative = profile.distribution === "ubuntu" && profile.release === "26.04" && sudoState === "symbolic link|0|777|1";
  if (alternative) {
    // Ubuntu's alternatives links are not package-owned. Admit only the source-owned
    // default sudo-rs chain, with an installed, intact package and protected target.
    const target = "/usr/lib/cargo/bin/sudo";
    if (snapshot.get("sudo-rs")?.status !== "installed") throw new Error("sudo-rs is not configured");
    for (const [path, next] of [["/usr/bin/sudo", "/etc/alternatives/sudo"], ["/etc/alternatives/sudo", target]]) {
      if ((await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", path!])).trim() !== "symbolic link|0|777|1" ||
          (await serviceObservation(host, remaining, ["/usr/bin/readlink", "--", path!])).trim() !== next ||
          (await serviceObservation(host, remaining, ["/usr/bin/readlink", "--canonicalize-existing", "--", path!])).trim() !== target) throw new Error("Unreviewed sudo alternative");
    }
    for (const directory of ["/", "/etc", "/etc/alternatives", "/usr", "/usr/bin", "/usr/lib", "/usr/lib/cargo", "/usr/lib/cargo/bin"]) {
      if ((await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a", "--", directory])).trim() !== "directory|0|755" ||
          (await serviceObservation(host, remaining, ["/usr/bin/readlink", "--canonicalize-existing", "--", directory])).trim() !== directory) throw new Error("Unsafe sudo provider directory");
    }
    if ((await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", target])).trim() !== "regular file|0|4755|1" ||
        (await serviceObservation(host, remaining, ["/usr/bin/readlink", "--canonicalize-existing", "--", target])).trim() !== target ||
        (await serviceObservation(host, remaining, ["/usr/bin/dpkg-query", "--root=/", "--admindir=/var/lib/dpkg", "--search", "--", target])).trim() !== `sudo-rs: ${target}`) throw new Error("sudo-rs provenance differs");
    if (remaining() <= 0) throw new Error("sudo-rs verification deadline");
    const verified = await host.run(["/usr/bin/dpkg", "--root=/", "--admindir=/var/lib/dpkg", "--verify", "sudo-rs"], remaining());
    if (verified.status !== "completed" || verified.exitCode !== 0 || verified.terminationUnconfirmed || verified.stdout !== "" || verified.stderr !== "") throw new Error("sudo-rs integrity unavailable");
  }
  for (const [path, owner, mode] of alternative ? [["/usr/bin/systemctl", "systemd", "755"]] : [["/usr/bin/systemctl", "systemd", "755"], ["/usr/bin/sudo", "sudo", "4755"]]) {
    if ((await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", path!])).trim() !== `regular file|0|${mode}|1` || (await serviceObservation(host, remaining, ["/usr/bin/dpkg-query", "--root=/", "--admindir=/var/lib/dpkg", "--search", "--", path!])).trim() !== `${owner}: ${path}`) throw new Error("Service control tool ownership changed");
  }

}
/** Called only under the existing setup lock after exact installed-state inspection. */
export async function setupAptService(input: CommandInput, host: SetupHost, identity: HostIdentity, profile: AptInstallProfile, remaining: () => number, endpoint?: string): Promise<CliOutcome> {
  if (!hasAptServiceBinding(profile)) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The exact installed artifacts have no authenticated service policy.", actions: [] });
  return setupLinuxService(input, host, identity, aptServicePolicy(profile), remaining, endpoint);
}
/** Private policy is constructed only from a compiled, authenticated APT profile. */
export function aptServicePolicy(profile: AptInstallProfile): LinuxServicePolicy {
  if (!hasAptServiceBinding(profile)) throw new Error("No authenticated service binding");
  return { method: profile.method, label: "APT", membershipTool: "apt-shadow", targetDescription: "Start docker.service, docker.socket and containerd.service; vendor pre-start -/sbin/modprobe overlay may load the overlay kernel module. No boot enablement or membership changes.", binding: profile, hashes, pendingPath: aptServicePendingPath, fragmentPaths: (unit) => unit === "containerd.service" ? [`/usr/lib/systemd/system/${unit}`, `/lib/systemd/system/${unit}`] : [`/usr/lib/systemd/system/${unit}`], provenance: (target, budget) => provenance(target, budget, profile), prestartEffects: { unit: "containerd.service", command: "-/sbin/modprobe overlay", effect: "Vendor pre-start may load the overlay kernel module; OS policy is unchanged." } };
}

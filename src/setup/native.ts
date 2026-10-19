import type { HostIdentity, SetupHost } from "./commands.ts";

/** Compiled release authority, never read from CLI JSON, project files or environment. */
export interface AptInstallProfile {
  readonly method: "docker-official-apt";
  readonly verified: true;
  readonly distribution: "ubuntu" | "debian";
  readonly release: string;
  readonly architecture: "x64" | "arm64";
  readonly repositoryFingerprint: string;
  readonly packages: Readonly<Record<"docker-ce" | "docker-ce-cli" | "containerd.io" | "docker-buildx-plugin" | "docker-compose-plugin", string>>;
}
export type NativeInstallProfile = AptInstallProfile;
/** No native profile is admitted until release artifact/native verification is recorded. */
export const nativeInstallProfiles: readonly NativeInstallProfile[] = [];
export function selectNativeProfile(identity: HostIdentity, profiles: readonly NativeInstallProfile[]): NativeInstallProfile | undefined {
  return profiles.find((profile) => profile.verified === true && profile.distribution === identity.distribution && profile.release === identity.release && profile.architecture === identity.architecture);
}
export function validAptProfile(profile: AptInstallProfile): boolean {
  const names = ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"];
  return /^[A-F0-9]{40}$/.test(profile.repositoryFingerprint)
    && Object.keys(profile.packages).length === names.length
    && names.every((name) => Object.hasOwn(profile.packages, name))
    && Object.values(profile.packages).every((version) => /^[0-9][A-Za-z0-9.+:~_-]{0,127}$/.test(version));
}
export async function inspectAptInstallation(profile: AptInstallProfile, host: SetupHost, remaining: () => number): Promise<"installed" | "absent" | "conflict" | "unavailable"> {
  const result = await host.run(["dpkg-query", "--show", "--showformat=${binary:Package}=${Version}\\n", ...Object.keys(profile.packages)], remaining());
  if (result.status !== "completed") return "unavailable";
  if (result.exitCode === 1 && result.stdout.trim() === "") return "absent";
  if (result.exitCode !== 0) return "conflict";
  const expected = Object.entries(profile.packages).map(([name, version]) => `${name}=${version}`).sort();
  const actual = result.stdout.trim().split("\n").sort();
  return JSON.stringify(actual) === JSON.stringify(expected) ? "installed" : "conflict";
}

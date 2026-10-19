import { inspectAptPackageState } from "./native-state.ts";
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
export interface DesktopInstallProfile {
  readonly method: "docker-desktop-official-dmg";
  readonly artifactAuthentication: "authenticated";
  readonly nativeEvidence: "pending" | "verified";
  readonly release: string;
  readonly architecture: "x64" | "arm64";
  readonly version: string;
  readonly build: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly teamId: string;
}
export type NativeInstallProfile = AptInstallProfile | DesktopInstallProfile;
/** No native profile is admitted until release artifact/native verification is recorded. */
export const nativeInstallProfiles: readonly NativeInstallProfile[] = [];
export function selectNativeProfile(identity: HostIdentity, profiles: readonly NativeInstallProfile[]): NativeInstallProfile | undefined {
  return profiles.find((profile) => (profile.method === "docker-official-apt" ? profile.verified === true && profile.distribution === identity.distribution : identity.system === "darwin" && profile.artifactAuthentication === "authenticated") && profile.release === identity.release && profile.architecture === identity.architecture);
}
export { validAptProfile, inspectAptPackageState } from "./native-state.ts";
export async function inspectAptInstallation(profile: AptInstallProfile, host: SetupHost, remaining: () => number): Promise<"installed" | "absent" | "conflict" | "unavailable"> {
  const result = await inspectAptPackageState(profile, host, remaining);
  if (result.state !== "compatible") return result.state;
  return result.missing.length === 0 ? "installed" : result.present.length === 0 ? "absent" : "conflict";
}

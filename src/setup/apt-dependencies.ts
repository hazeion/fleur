import type { AptInstallProfile, AptPackageArtifact } from "./native.ts";

export type DebianDependencyName = "libjansson4" | "libnftables1" | "nftables";
export interface DistroDependencyArtifact extends Omit<AptPackageArtifact, "name"> { readonly name: DebianDependencyName }
export interface AptDistroDependencies {
  readonly repositoryFingerprint: string;
  readonly signingFingerprint: string;
  readonly inReleaseSha256: string;
  readonly packagesIndexSha256: string;
  readonly maintainerScriptsSha256: string;
  readonly effects: "nftables-configuration-helper-state-systemd-reload-and-ldconfig";
  readonly artifacts: Readonly<Record<DebianDependencyName, DistroDependencyArtifact>>;
}

const names = ["libjansson4", "libnftables1", "nftables"] as const;
export function validDistroDependencies(profile: { readonly distribution: string; readonly release: string; readonly architecture: string; readonly distroDependencies?: AptDistroDependencies }): boolean {
  if (!Object.hasOwn(profile, "distroDependencies")) return true;
  const closure = profile.distroDependencies;
  if (profile.distribution !== "debian" || profile.release !== "13" || profile.architecture !== "x64"
      || !closure || typeof closure !== "object" || Array.isArray(closure)
      || Object.keys(closure).sort().join(",") !== "artifacts,effects,inReleaseSha256,maintainerScriptsSha256,packagesIndexSha256,repositoryFingerprint,signingFingerprint"
      || closure.repositoryFingerprint !== "04B54C3CDCA79751B16BC6B5225629DF75B188BD"
      || closure.signingFingerprint !== "B8E5F13176D2A7A75220028078DBA3BC47EF2265"
      || ![closure.inReleaseSha256, closure.packagesIndexSha256, closure.maintainerScriptsSha256].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
      || closure.effects !== "nftables-configuration-helper-state-systemd-reload-and-ldconfig"
      || !closure.artifacts || typeof closure.artifacts !== "object" || Array.isArray(closure.artifacts)
      || Object.keys(closure.artifacts).sort().join(",") !== names.join(",")) return false;
  return closure.artifacts.nftables?.version === closure.artifacts.libnftables1?.version && names.every((name) => {
    const artifact = closure.artifacts[name];
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)
        || Object.keys(artifact).sort().join(",") !== "architecture,name,sha256,size,url,version"
        || artifact.name !== name || artifact.architecture !== "amd64"
        || typeof artifact.version !== "string" || !/^[0-9][A-Za-z0-9.+~_-]{0,127}$/.test(artifact.version)
        || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > 268435456) return false;
    const folder = name === "libjansson4" ? "j/jansson" : "n/nftables";
    return artifact.url === `https://deb.debian.org/debian/pool/main/${folder}/${name}_${artifact.version}_amd64.deb`;
  });
}

export function aptPackageArtifacts(profile: AptInstallProfile): Readonly<Record<string, AptPackageArtifact | DistroDependencyArtifact>> {
  return { ...profile.artifacts, ...profile.distroDependencies?.artifacts };
}
export function aptPackageVersions(profile: AptInstallProfile): Readonly<Record<string, string>> {
  return { ...profile.packages, ...Object.fromEntries(Object.entries(profile.distroDependencies?.artifacts ?? {}).map(([name, artifact]) => [name, artifact.version])) };
}
/** Only declared native dependency qualifiers are aliases; foreign or duplicate identities refuse. */
export function canonicalAptPackageName(dependencies: AptDistroDependencies | undefined, name: string): string | null {
  const base = name.split(":")[0]!;
  const artifact = dependencies && Object.hasOwn(dependencies.artifacts, base) ? dependencies.artifacts[base as DebianDependencyName] : undefined;
  if (!artifact) return name;
  return name === base || name === `${base}:${artifact.architecture}` ? base : null;
}
export function canonicalAptSnapshot<T>(dependencies: AptDistroDependencies | undefined, snapshot: ReadonlyMap<string, T> | null): ReadonlyMap<string, T> | null {
  if (!snapshot) return null;
  const result = new Map<string, T>();
  for (const [binary, value] of snapshot) {
    const name = canonicalAptPackageName(dependencies, binary);
    if (name === null || result.has(name)) return null;
    result.set(name, value);
  }
  return result;
}
/** APT's local cache name includes the complete version, including its epoch. */
export function aptCacheArchiveFilename(artifact: { readonly name: string; readonly version: string; readonly architecture: string }): string {
  const quote = (value: string) => value.replaceAll("_", "%5f").replaceAll(":", "%3a");
  return `${quote(artifact.name)}_${quote(artifact.version)}_${artifact.architecture}.deb`;
}
export function aptPlanTarget(profile: AptInstallProfile, checksum: string): string {
  const target = `Docker ${profile.distribution} ${profile.release} ${profile.architecture} profile ${checksum}`;
  if (!profile.distroDependencies) return target;
  const packages = names.map((name) => `${name}=${profile.distroDependencies!.artifacts[name].version}`).join(", ");
  return `${target}; Debian dependencies ${packages}; nftables configuration and helper state, systemd daemon-reload, ldconfig`;
}

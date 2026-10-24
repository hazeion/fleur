import compiledCatalog from "./verified-apt-profiles.json";
import { validAptProfile } from "./native-state.ts";
import type { AptInstallProfile } from "./native.ts";

function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
export function admitInstallCatalog(catalog: unknown): readonly AptInstallProfile[] {
  if (!keys(catalog, ["formatVersion", "entries"]) || catalog.formatVersion !== 1 || !Array.isArray(catalog.entries)) return Object.freeze([]);
  const result: AptInstallProfile[] = [];
  const identities = new Set<string>();
  for (const entry of catalog.entries) {
    if (!keys(entry, ["evidence", "profile"]) || !keys(entry.evidence, ["reportSha256", "sourceCommit", "artifactCatalogSha256"])) return Object.freeze([]);
    if (![entry.evidence.reportSha256, entry.evidence.artifactCatalogSha256].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) || typeof entry.evidence.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(entry.evidence.sourceCommit)) return Object.freeze([]);
    const value = entry.profile;
    const dependencies = value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "distroDependencies");
    if (!keys(value, ["method", "verified", "distribution", "release", "architecture", "repositoryFingerprint", "packages", "artifacts", ...(dependencies ? ["distroDependencies"] : [])]) || value.method !== "docker-official-apt" || value.verified !== true || !["ubuntu", "debian"].includes(String(value.distribution)) || !["x64", "arm64"].includes(String(value.architecture)) || typeof value.release !== "string" || !/^\d+(?:\.\d+)?$/.test(value.release) || !keys(value.packages, ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"])) return Object.freeze([]);
    const profile = value as unknown as AptInstallProfile;
    if (profile.distribution === "debian" && !dependencies || !validAptProfile(profile)) return Object.freeze([]);
    const identity = JSON.stringify([profile.distribution, profile.release, profile.architecture]);
    if (identities.has(identity)) return Object.freeze([]);
    identities.add(identity);
    const distroDependencies = profile.distroDependencies ? Object.freeze({ ...profile.distroDependencies,
      artifacts: Object.freeze(Object.fromEntries(Object.entries(profile.distroDependencies.artifacts).map(([name, artifact]) => [name, Object.freeze({ ...artifact })]))) as typeof profile.distroDependencies.artifacts }) : undefined;
    result.push(Object.freeze({ ...profile, packages: Object.freeze({ ...profile.packages }), artifacts: Object.freeze(Object.fromEntries(Object.entries(profile.artifacts).map(([name, artifact]) => [name, Object.freeze({ ...artifact })]))) as AptInstallProfile["artifacts"],
      ...(distroDependencies ? { distroDependencies } : {}) }));
  }
  return Object.freeze(result);
}

/** Fixed packaged authority, never loaded from caller-supplied paths or environment. */
export const verifiedInstallProfiles = admitInstallCatalog(compiledCatalog);

import catalog from "./verified-desktop-profiles.json";
import type { DesktopInstallProfile } from "./native.ts";

function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Source-owned installation-method evidence only; it never admits runtime readiness. */
export function admitDesktopCatalog(value: unknown): readonly { readonly profile: DesktopInstallProfile; readonly evidence: Readonly<Record<string, unknown>> }[] {
  if (!keys(value, ["formatVersion", "entries"]) || value.formatVersion !== 1 || !Array.isArray(value.entries)) return Object.freeze([]);
  const admitted = [];
  const identities = new Set<string>();
  for (const entry of value.entries) {
    if (!keys(entry, ["evidence", "profile"])) return Object.freeze([]);
    const { profile, evidence } = entry;
    if (!keys(profile, ["method", "artifactAuthentication", "nativeEvidence", "release", "architecture", "version", "build", "url", "sha256", "bytes", "teamId"])
      || profile.method !== "docker-desktop-official-dmg" || profile.artifactAuthentication !== "authenticated" || profile.nativeEvidence !== "verified"
      || typeof profile.release !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(profile.release) || Number(profile.release.split(".")[0]) < 13
      || (profile.architecture !== "x64" && profile.architecture !== "arm64") || typeof profile.version !== "string" || !/^\d+\.\d+\.\d+$/.test(profile.version)
      || typeof profile.build !== "string" || !/^\d+$/.test(profile.build) || !digest(profile.sha256)
      || typeof profile.bytes !== "number" || !Number.isSafeInteger(profile.bytes) || profile.bytes <= 0 || profile.bytes > 2 ** 31
      || profile.teamId !== "9BNSXJN65R" || profile.url !== `https://desktop.docker.com/mac/main/${profile.architecture === "x64" ? "amd64" : "arm64"}/${profile.build}/Docker.dmg`) return Object.freeze([]);
    if (!keys(evidence, ["scope", "runtimeReadinessAdmission", "sourceCommit", "planSha256", "artifactReportSha256", "placementReportSha256s", "host", "artifact"])
      || evidence.scope !== "native-desktop-placement-method" || evidence.runtimeReadinessAdmission !== false
      || typeof evidence.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(evidence.sourceCommit)
      || !digest(evidence.planSha256) || !digest(evidence.artifactReportSha256)
      || !Array.isArray(evidence.placementReportSha256s) || evidence.placementReportSha256s.length !== 2
      || !evidence.placementReportSha256s.every(digest) || new Set(evidence.placementReportSha256s).size !== 2
      || !keys(evidence.host, ["system", "release", "architecture"]) || evidence.host.system !== "darwin"
      || evidence.host.release !== profile.release || evidence.host.architecture !== profile.architecture
      || !keys(evidence.artifact, ["version", "build", "architecture", "url", "sha256", "bytes", "teamId"])
      || Object.entries(evidence.artifact).some(([key, field]) => profile[key] !== field)) return Object.freeze([]);
    const identity = JSON.stringify([profile.release, profile.architecture]);
    if (identities.has(identity)) return Object.freeze([]);
    identities.add(identity);
    admitted.push(Object.freeze({ profile: Object.freeze({ ...profile }) as unknown as DesktopInstallProfile,
      evidence: Object.freeze({ ...evidence, host: Object.freeze({ ...evidence.host }), artifact: Object.freeze({ ...evidence.artifact }), placementReportSha256s: Object.freeze([...evidence.placementReportSha256s]) }) }));
  }
  return Object.freeze(admitted);
}
const admitted = admitDesktopCatalog(catalog);
export const verifiedDesktopProfiles: readonly DesktopInstallProfile[] = Object.freeze(admitted.map(({ profile }) => profile));

import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { admitInstallCatalog, verifiedInstallProfiles } from "../../src/setup/verified-install-profiles.ts";
import packaged from "../../src/setup/verified-apt-profiles.json";

const digest = "032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d";
async function candidate() {
  const file = Bun.file(resolve(import.meta.dir, "../../scripts/native-candidate-debian13-amd64.json"));
  expect(Bun.CryptoHasher.hash("sha256", await file.arrayBuffer(), "hex")).toBe(digest);
  const source = await file.json();
  const artifacts = Object.fromEntries(source.artifacts.filter((item: { name: string }) => Object.hasOwn(source.profile.packages, item.name)).map(({ name, version, url, sha256, size }: { name: string; version: string; url: string; sha256: string; size: number }) => [name, { name, version, url, sha256, size, architecture: "amd64" }]));
  return { formatVersion: 1, entries: [{ evidence: { reportSha256: "a".repeat(64), sourceCommit: "b".repeat(40), artifactCatalogSha256: digest }, profile: { ...source.profile, artifacts } }] };
}

test("APT catalog validates the complete Debian dependency schema from the pinned source", async () => {
  const input = await candidate();
  const profiles = admitInstallCatalog(input);
  expect(profiles).toHaveLength(1);
  expect(profiles[0]).toEqual(input.entries[0]!.profile);
  expect(Object.keys(profiles[0]!.artifacts)).toHaveLength(5);
  expect(Object.keys(profiles[0]!.distroDependencies!.artifacts)).toEqual(["libjansson4", "libnftables1", "nftables"]);
});

test("production catalog admits only the three measured x64 installation profiles", () => {
  expect<unknown>(verifiedInstallProfiles).toEqual(packaged.entries.map((entry) => entry.profile));
  expect(verifiedInstallProfiles.map((profile) => [profile.distribution, profile.release, profile.architecture])).toEqual([["ubuntu", "24.04", "x64"], ["ubuntu", "26.04", "x64"], ["debian", "13", "x64"]]);
});

test("production Debian profile retains the complete authenticated candidate closure and measured evidence", async () => {
  const expected = await candidate();
  const entry = packaged.entries.find((item) => item.profile.distribution === "debian")!;
  expect(entry.profile).toEqual(expected.entries[0]!.profile);
  expect(entry.evidence).toEqual({ reportSha256: "6b4066ed5c199006695d769d07ec5d813fa8cddff1d396a089e1749d6c27231e", sourceCommit: "300cdaf30e1ea4786b096786e458f698984fe038", artifactCatalogSha256: digest });
});

test("malformed foreign or inconsistent dependency authority closes the catalog", async () => {
  const original = await candidate();
  const changes: ((input: typeof original) => void)[] = [
    (value) => { value.entries[0]!.profile.extra = true; },
    (value) => { delete value.entries[0]!.profile.distroDependencies; },
    (value) => { delete value.entries[0]!.profile.distroDependencies.effects; },
    (value) => { value.entries[0]!.profile.distroDependencies.extra = true; },
    (value) => { value.entries[0]!.profile.distroDependencies.artifacts.extra = {}; },
    (value) => { value.entries[0]!.profile.distroDependencies.artifacts.nftables.extra = true; },
    (value) => { value.entries[0]!.profile.distroDependencies.repositoryFingerprint = "0".repeat(40); },
    (value) => { value.entries[0]!.profile.distroDependencies.signingFingerprint = "0".repeat(40); },
    (value) => { value.entries[0]!.profile.distroDependencies.effects = "flush-firewall"; },
    (value) => { value.entries[0]!.profile.distroDependencies.artifacts.nftables.architecture = "arm64"; },
    (value) => { value.entries[0]!.profile.distroDependencies.artifacts.nftables.version = "other"; },
    (value) => { value.entries[0]!.profile.distroDependencies.artifacts.nftables.url = "https://example.invalid/package.deb"; },
    (value) => { value.entries[0]!.profile.release = "14"; },
    (value) => { value.entries[0]!.profile.architecture = "arm64"; },
    (value) => { value.entries[0]!.profile.distribution = "ubuntu"; },
    (value) => { value.entries.push(structuredClone(value.entries[0]!)); },
    (value) => { value.entries[0]!.evidence.reportSha256 = "invalid"; },
    (value) => { value.entries[0]!.evidence = { ...value.entries[0]!.evidence, extra: "unexpected" } as typeof value.entries[number]["evidence"]; },
  ];
  for (const change of changes) {
    const input = structuredClone(original);
    change(input);
    expect(admitInstallCatalog(input)).toEqual([]);
  }
});

test("admitted dependency records are deeply immutable copies", async () => {
  const input = await candidate();
  const profiles = admitInstallCatalog(input);
  const profile = profiles[0]!;
  for (const value of [profiles, profile, profile.packages, profile.artifacts, ...Object.values(profile.artifacts), profile.distroDependencies, profile.distroDependencies!.artifacts, ...Object.values(profile.distroDependencies!.artifacts)]) expect(Object.isFrozen(value)).toBe(true);
  expect(Reflect.set(profile.distroDependencies!.artifacts.nftables, "version", "changed")).toBe(false);
  expect(profile.distroDependencies!.artifacts.nftables.version).toBe(input.entries[0]!.profile.distroDependencies.artifacts.nftables.version);
  input.entries[0]!.profile.distroDependencies.artifacts.nftables.version = "changed-input";
  expect(profile.distroDependencies!.artifacts.nftables.version).not.toBe("changed-input");
});

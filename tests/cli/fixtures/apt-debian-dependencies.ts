import { aptFixtureArtifacts, aptFixtureBytes } from "./apt-artifacts.ts";

export const debianDockerPackages = {
  "docker-ce": "5:29.9.1-1~debian.13~trixie", "docker-ce-cli": "5:29.9.1-1~debian.13~trixie", "containerd.io": "2.4.2-2~debian.13~trixie", "docker-buildx-plugin": "0.38.0-1~debian.13~trixie", "docker-compose-plugin": "5.6.0-1~debian.13~trixie",
};
export const debianDependencyPackages = { libjansson4: "2.14-2+b3", libnftables1: "1.1.3-1", nftables: "1.1.3-1" };
const artifact = <T extends keyof typeof debianDependencyPackages>(name: T) => {
  const version = debianDependencyPackages[name]; const bytes = aptFixtureBytes(name, version);
  return { name, version, architecture: "amd64" as const, url: `https://deb.debian.org/debian/pool/main/${name === "libjansson4" ? "j/jansson" : "n/nftables"}/${name}_${version}_amd64.deb`, size: bytes.length, sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex") };
};
// External payload bytes are synthetic; the cryptographic provenance audit lives
// separately in native evidence. This fixture never grants native qualification.
export const debianDependencyFixture = {
  repositoryFingerprint: "04B54C3CDCA79751B16BC6B5225629DF75B188BD",
  signingFingerprint: "B8E5F13176D2A7A75220028078DBA3BC47EF2265",
  inReleaseSha256: "0584fba32e13e0ab8285fb16c27adea1ec03a73669c18702821094fd6ca86675",
  packagesIndexSha256: "7778d3e3f303b7ddb8ce0fe7c8d57473a076c6bf2e8f241f75421d2396352498",
  maintainerScriptsSha256: "c8d9621167b75774c7fa17e07ad845afadaa405b3a38388195383f7314728f17",
  effects: "nftables-configuration-helper-state-systemd-reload-and-ldconfig" as const,
  artifacts: { libjansson4: artifact("libjansson4"), libnftables1: artifact("libnftables1"), nftables: artifact("nftables") },
};
export const debianDependencyProfile = {
  method: "docker-official-apt" as const, verified: true as const, distribution: "debian" as const, release: "13", architecture: "x64" as const,
  repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages: debianDockerPackages,
  artifacts: Object.fromEntries(Object.entries(aptFixtureArtifacts(debianDockerPackages)).map(([name, value]) => [name, { ...value, url: value.url.replace("ubuntu/dists/noble", "debian/dists/trixie") }])) as ReturnType<typeof aptFixtureArtifacts>,
  distroDependencies: debianDependencyFixture,
};

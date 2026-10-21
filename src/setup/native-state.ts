import type { SetupHost } from "./commands.ts";
import type { AptInstallProfile } from "./native.ts";

export interface AptPackageState {
  readonly state: "compatible" | "conflict" | "unavailable";
  readonly present: readonly string[];
  readonly missing: readonly string[];
}

export function validAptProfile(profile: AptInstallProfile): boolean {
  const names = ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"];
  if (!profile.artifacts || typeof profile.artifacts !== "object" || Array.isArray(profile.artifacts) || Object.keys(profile.artifacts).length !== names.length) return false;
  const architecture = profile.architecture === "x64" ? "amd64" : "arm64";
  const suite = profile.distribution === "debian" ? "trixie" : profile.release === "24.04" ? "noble" : "resolute";
  return typeof profile.repositoryFingerprint === "string" && /^[A-F0-9]{40}$/.test(profile.repositoryFingerprint)
    && Object.keys(profile.packages).length === names.length
    && names.every((name) => Object.hasOwn(profile.packages, name) && Object.hasOwn(profile.artifacts, name))
    && Object.values(profile.packages).every((version) => typeof version === "string" && /^[0-9][A-Za-z0-9.+:~_-]{0,127}$/.test(version))
    && names.every((name) => {
      const artifact = profile.artifacts[name as keyof typeof profile.artifacts];
      return artifact && typeof artifact === "object" && !Array.isArray(artifact)
        && Object.keys(artifact).sort().join(",") === "architecture,name,sha256,size,url,version"
        && artifact.name === name && artifact.version === profile.packages[name as keyof typeof profile.packages]
        && artifact.architecture === architecture && typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(artifact.sha256)
        && typeof artifact.url === "string" && artifact.url.startsWith(`https://download.docker.com/linux/${profile.distribution}/dists/${suite}/pool/stable/${architecture}/`)
        && /^[A-Za-z0-9._~+%:-]+\.deb$/.test(artifact.url.slice(`https://download.docker.com/linux/${profile.distribution}/dists/${suite}/pool/stable/${architecture}/`.length))
        && Number.isSafeInteger(artifact.size) && artifact.size > 0 && artifact.size <= 268435456;
    }) && Object.values(profile.artifacts).reduce((sum, artifact) => sum + artifact.size, 0) <= 1073741824;
}
export async function inspectAptPackageState(profile: AptInstallProfile, host: SetupHost, remaining: () => number): Promise<AptPackageState> {
  const refused = (state: "conflict" | "unavailable"): AptPackageState => ({ state, present: [], missing: [] });
  if (!validAptProfile(profile)) return refused("conflict");
  const timeout = remaining();
  if (timeout <= 0) return refused("unavailable");
  const names = Object.keys(profile.packages).sort();
  const result = await host.run(["dpkg-query", "--root=/", "--admindir=/var/lib/dpkg", "--show", "--showformat=${binary:Package}\t${Version}\t${db:Status-Status}\t${db:Status-Eflag}\\n", ...names], timeout);
  if (result.status !== "completed" || (result.exitCode !== 0 && result.exitCode !== 1)) return refused("unavailable");
  const present = new Set<string>();
  const lines = result.stdout === "" ? [] : result.stdout.replace(/\n$/, "").split("\n");
  for (const line of lines) {
    const fields = line.split("\t");
    const [name, version, status, errorFlag] = fields;
    if (fields.length !== 4 || !name || !Object.hasOwn(profile.packages, name) || present.has(name)
      || profile.packages[name as keyof typeof profile.packages] !== version || status !== "installed" || errorFlag !== "ok") return refused("conflict");
    present.add(name);
  }
  if (result.exitCode === 0 && present.size !== names.length) return refused("conflict");
  return { state: "compatible", present: names.filter((name) => present.has(name)), missing: names.filter((name) => !present.has(name)) };
}

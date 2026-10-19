import type { SetupHost } from "./commands.ts";
import type { AptInstallProfile } from "./native.ts";

export interface AptPackageState {
  readonly state: "compatible" | "conflict" | "unavailable";
  readonly present: readonly string[];
  readonly missing: readonly string[];
}

export function validAptProfile(profile: AptInstallProfile): boolean {
  const names = ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"];
  return /^[A-F0-9]{40}$/.test(profile.repositoryFingerprint)
    && Object.keys(profile.packages).length === names.length
    && names.every((name) => Object.hasOwn(profile.packages, name))
    && Object.values(profile.packages).every((version) => /^[0-9][A-Za-z0-9.+:~_-]{0,127}$/.test(version));
}
export async function inspectAptPackageState(profile: AptInstallProfile, host: SetupHost, remaining: () => number): Promise<AptPackageState> {
  const refused = (state: "conflict" | "unavailable"): AptPackageState => ({ state, present: [], missing: [] });
  if (!validAptProfile(profile)) return refused("conflict");
  const timeout = remaining();
  if (timeout <= 0) return refused("unavailable");
  const names = Object.keys(profile.packages).sort();
  const result = await host.run(["dpkg-query", "--show", "--showformat=${binary:Package}\t${Version}\t${db:Status-Status}\t${db:Status-Eflag}\\n", ...names], timeout);
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

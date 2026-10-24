/** Fixed C-locale Pacman query protocol. A failed query alone never proves absence. */
export const archPackageNames = Object.freeze(["containerd", "docker", "docker-compose", "runc"] as const);
export type ArchPackageName = typeof archPackageNames[number];
export function parseArchPackageState(exitCode: number, stdout: string, stderr: string, versions: Readonly<Record<ArchPackageName, string>>): { present: ArchPackageName[]; missing: ArchPackageName[] } | null {
  if ((exitCode !== 0 && exitCode !== 1) || typeof stdout !== "string" || typeof stderr !== "string"
      || stdout.length > 4096 || stderr.length > 4096 || Object.keys(versions).sort().join(",") !== archPackageNames.join(",")
      || archPackageNames.some((name) => typeof versions[name] !== "string" || !/^[0-9][A-Za-z0-9.+:~_-]{0,127}$/.test(versions[name]))) return null;
  const present: ArchPackageName[] = [];
  if (stdout !== "") {
    if (!stdout.endsWith("\n")) return null;
    for (const line of stdout.slice(0, -1).split("\n")) {
      const row = /^([a-z0-9-]+) ([!-~]+)$/.exec(line);
      const name = row?.[1] as ArchPackageName | undefined;
      if (!name || !archPackageNames.includes(name) || present.includes(name) || versions[name] !== row?.[2]) return null;
      present.push(name);
    }
  }
  const missing = archPackageNames.filter((name) => !present.includes(name));
  if (exitCode !== (missing.length ? 1 : 0) || stderr !== missing.map((name) => `error: package '${name}' was not found\n`).join("")) return null;
  return { present: present.sort(), missing };
}

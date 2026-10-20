/** Bounded machine protocol for the actual host dpkg database, including unrelated packages. */
export const aptHealthArgs = ["dpkg-query", "--root=/", "--admindir=/var/lib/dpkg", "--show", "--showformat=${binary:Package}\t${Version}\t${db:Status-Status}\t${db:Status-Eflag}\\n"] as const;
export function healthyDpkgSnapshot(stdout: string): ReadonlyMap<string, { readonly version: string; readonly status: string }> | null {
  if (!stdout.trim()) return null;
  const result = new Map<string, { version: string; status: string }>();
  for (const line of stdout.replace(/\n$/, "").split("\n")) {
    const fields = line.split("\t"); const [name, version, status, errorFlag] = fields;
    if (fields.length !== 4 || !name || !/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9_-]+)?$/.test(name) || result.has(name) || errorFlag !== "ok" || !["installed", "config-files", "not-installed"].includes(status!) || (status !== "not-installed" && !version)) return null;
    result.set(name, { version: version!, status: status! });
  }
  return result;
}

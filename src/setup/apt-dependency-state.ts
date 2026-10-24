import type { SetupHost } from "./commands.ts";
import type { AptInstallProfile } from "./native.ts";

/** Observations only: package absence does not prove an unused firewall service. */
export async function freshNftablesState(profile: AptInstallProfile, missing: readonly string[], host: SetupHost, remaining: () => number): Promise<"clear" | "conflict" | "unavailable"> {
  if (!profile.distroDependencies || !missing.includes("nftables")) return "clear";
  const run = (args: readonly string[]) => remaining() > 0 ? host.run(args, remaining()) : Promise.resolve({ status: "timeout" as const, stdout: "", stderr: "" });
  const configuration = await run(["stat", "--format=%F|%u|%a|%h", "--", "/etc/nftables.conf"]);
  if (configuration.status !== "completed" || configuration.terminationUnconfirmed) return "unavailable";
  if (configuration.exitCode === 0) return "conflict";
  if (configuration.exitCode !== 1 || !/No such file or directory/.test(configuration.stderr)) return "unavailable";
  const files = await run(["find", "/etc/systemd/system", "/run/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system", "/var/lib/systemd", "-mindepth", "1", "-maxdepth", "4", "(", "-name", "nftables.service", "-o", "-name", "nftables.service.d", "-o", "-name", "nftables.service.dsh-also", ")", "-print"]);
  if (files.status !== "completed" || files.exitCode !== 0 || files.terminationUnconfirmed || files.stderr.trim()) return "unavailable";
  if (files.stdout.trim()) return "conflict";
  const observed = await run(["systemctl", "show", "nftables.service", "--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,DropInPaths,Transient"]);
  if (observed.status !== "completed" || ![0, 1, 4].includes(observed.exitCode ?? -1) || observed.terminationUnconfirmed) return "unavailable";
  const fields = new Map<string, string>();
  for (const line of observed.stdout.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0 || fields.has(line.slice(0, separator))) return "unavailable";
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if ([...fields.keys()].sort().join(",") !== "ActiveState,DropInPaths,FragmentPath,LoadState,SubState,Transient,UnitFileState") return "unavailable";
  return fields.get("LoadState") === "not-found" && fields.get("ActiveState") === "inactive" && fields.get("SubState") === "dead"
    && ["", "not-found"].includes(fields.get("UnitFileState")!) && fields.get("FragmentPath") === "" && fields.get("DropInPaths") === "" && fields.get("Transient") === "no" ? "clear" : "conflict";
}

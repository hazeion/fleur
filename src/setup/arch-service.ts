import { archServicePendingPath } from "./service-pending.ts";
import { permitsArchSystemStart } from "./activation-observer.ts";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { doctor } from "./doctor.ts";
import { readGrants, writeGrants, stateDirectory, type Grant } from "./grants.ts";
import { syncStateDirectory } from "./lock.ts";
import { failure, type CliOutcome, type Json } from "../cli/result.ts";
import type { CommandInput } from "../cli/catalog.ts";
import type { HostCommandResult, HostIdentity, SetupHost } from "./commands.ts";
import type { ArchInstallProfile } from "./native-arch.ts";

const units = ["docker.service", "docker.socket", "containerd.service"] as const;
const hashes: Readonly<Record<string, string>> = {
  "docker.service": "a12d90fd03761bf79659a185c4a2c40e08934d7ada9e05130e64bd5eb4d634aa",
  "docker.socket": "96cd0d89474816ddfb03893b44c36e7d744254aed1bf6d30eca65ff396114656",
  "containerd.service": "7522a4e33c633f22fc0049d3c075b552f7df30cd978acd0175b972bdebc922ea",
};
const properties = ["Id", "LoadState", "ActiveState", "SubState", "UnitFileState", "FragmentPath", "DropInPaths", "Transient", "NeedDaemonReload", "Job", "Wants", "Requires", "Requisite", "BindsTo", "Upholds", "OnSuccess", "OnFailure", "CanStart", "RefuseManualStart"];
const externalDependencies = ["sysinit.target", "basic.target", "network-online.target", "system.slice"];
function diagnostic(value: Json | undefined): Readonly<Record<string, Json>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, Json>> : {};
}
class ServiceRecovery extends Error {}
function unconfirmed(result: HostCommandResult): boolean { return "terminationUnconfirmed" in result && result.terminationUnconfirmed === true; }
function terminal(result: HostCommandResult): boolean {
  return result.status === "completed" && result.exitCode === 0 && !unconfirmed(result);
}
async function command(host: SetupHost, remaining: () => number, args: readonly string[]): Promise<string> {
  if (remaining() <= 0) throw new Error("Service observation deadline");
  const result = await host.run(args, remaining());
  if (!terminal(result)) throw new Error("Service observation unavailable");
  return result.stdout;
}
function parseProperties(text: string, unit: string): Record<string, string> {
  if (text.length > 16384) throw new Error("Unit metadata is oversized");
  const result: Record<string, string> = {};
  for (const line of text.trimEnd().split("\n")) {
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (index < 1 || !properties.includes(key) || Object.hasOwn(result, key)) throw new Error("Unknown unit metadata");
    result[key] = line.slice(index + 1);
  }
  if (Object.keys(result).length !== properties.length || result.Id !== unit) throw new Error("Incomplete unit metadata");
  return result;
}
async function observe(host: SetupHost, remaining: () => number) {
  const observed: Record<string, Record<string, string>> = {};
  for (const unit of units) {
    const value = parseProperties(await command(host, remaining, ["/usr/bin/systemctl", "--system", "show", "--all", "--no-pager", `--property=${properties.join(",")}`, unit]), unit);
    if (value.LoadState !== "loaded" || !["enabled", "disabled"].includes(value.UnitFileState!) || value.FragmentPath !== `/usr/lib/systemd/system/${unit}` || value.DropInPaths !== "" || value.Transient !== "no" || value.NeedDaemonReload !== "no" || value.Job !== "0") throw new Error("Custom, masked or changing unit");
    if (["Requisite", "BindsTo", "Upholds", "OnSuccess", "OnFailure"].some((key) => value[key] !== "") || value.CanStart !== "yes" || value.RefuseManualStart !== "no") throw new Error("Unreviewed activation or manual-start policy");
    const state = `${value.ActiveState}/${value.SubState}`;
    if (!["inactive/dead", unit.endsWith(".socket") ? "active/listening" : "active/running"].includes(state)) throw new Error("Service state requires human action");
    const wants = value.Wants!.split(/\s+/).filter(Boolean);
    const requires = value.Requires!.split(/\s+/).filter(Boolean);
    const allowedWants = unit === "docker.service" ? ["network-online.target", "containerd.service"] : [];
    const allowedRequires = unit === "docker.service" ? ["docker.socket", "sysinit.target", "system.slice"] : unit === "containerd.service" ? ["sysinit.target", "system.slice"] : ["sysinit.target"];
    if (wants.some((name) => !allowedWants.includes(name)) || requires.some((name) => !allowedRequires.includes(name)) || (unit === "docker.service" && (allowedWants.some((name) => !wants.includes(name)) || !requires.includes("docker.socket")))) throw new Error("Unreviewed service dependency");
    observed[unit] = value;
  }
  return observed;
}
async function provenance(host: SetupHost, remaining: () => number, profile: ArchInstallProfile): Promise<void> {
  const names = Object.keys(profile.packages).sort() as (keyof ArchInstallProfile["packages"])[];
  const inventory = await command(host, remaining, ["/usr/bin/pacman", "--query", "--", ...names]);
  if (JSON.stringify(inventory.trim().split("\n").sort()) !== JSON.stringify(names.map((name) => `${name} ${profile.packages[name].version}`))) throw new Error("Package provenance changed");
  for (const unit of units) {
    const path = `/usr/lib/systemd/system/${unit}`;
    if (!/^regular file\|0\|(?:644|444)\|1\s*$/.test(await command(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", path]))) throw new Error("Unsafe unit file");
    if ((await command(host, remaining, ["/usr/bin/pacman", "--query", "--owns", "--quiet", "--", path])).trim() !== (unit === "containerd.service" ? "containerd" : "docker")) throw new Error("Unit package ownership changed");
    if ((await command(host, remaining, ["/usr/bin/sha256sum", "--", path])).trim() !== `${hashes[unit]}  ${path}`) throw new Error("Unit content differs from authenticated archive");
  }
  for (const [path, owner, mode] of [["/usr/bin/systemctl", "systemd", "755"], ["/usr/bin/sudo", "sudo", "4755"]]) {
    if ((await command(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", path!])).trim() !== `regular file|0|${mode}|1` || (await command(host, remaining, ["/usr/bin/pacman", "--query", "--owns", "--quiet", "--", path!])).trim() !== owner) throw new Error("Untrusted service control tool");
  }
}
/** Caller holds the existing setup lock and has checked exact package state and its pending fence. */
export async function setupArchService(input: CommandInput, host: SetupHost, identity: HostIdentity, profile: ArchInstallProfile, remaining: () => number, endpoint?: string): Promise<CliOutcome> {
  const manual = (message: string) => failure("setup", 3, { code: "HUMAN_ACTION_REQUIRED", message, actions: [] }, { resumable: true });
  if (profile.packages.docker.sha256 !== "3cc00845b632f3302fe148b939c2736a094599d42e885aab214a5a532bd87d54" || profile.packages.containerd.sha256 !== "c352b4c019c3d527daa50517a6420a7672b01876b95b80d72dd7192f05220999" || !endpoint) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Exact installed packages do not establish an admitted local service action.", actions: [] });
  if (endpoint === "unix:///var/run/docker.sock") {
    try { if ((await command(host, remaining, ["/usr/bin/readlink", "--canonicalize-existing", "/var/run"])).trim() !== "/run") return manual("The selected socket alias could not be verified; it was preserved."); }
    catch { return manual("The selected socket alias could not be verified; it was preserved."); }
  } else if (endpoint !== "unix:///run/docker.sock") return manual("This local endpoint is not the reviewed system Docker socket. No system service or context was changed.");
  const pendingPath = archServicePendingPath(host);
  let privilegedPhase = false;
  const readAuthority = async () => { try { return await readGrants(host); } catch { throw new ServiceRecovery("Unsafe authority state"); } };
  const writeAuthority = async (grants: readonly Grant[]) => { try { await writeGrants(host, grants); } catch { throw new ServiceRecovery("Authority not durable"); } };
  const sync = () => (host.syncDirectory ?? syncStateDirectory)(stateDirectory(host));
  try {
    try { await lstat(pendingPath); throw new ServiceRecovery("Earlier service operation is unresolved"); } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
    const observed = await observe(host, remaining);
    if (observed["docker.service"]!.ActiveState === "active") return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The Docker service is already active. Access and runtime readiness need separate observation; no restart was attempted.", actions: [{ command: "fleur doctor", description: "Inspect current-user readiness." }] });
    await provenance(host, remaining, profile);
    for (const unit of externalDependencies) await command(host, remaining, ["/usr/bin/systemctl", "--system", "is-active", "--quiet", unit]);
    const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify({ formatVersion: 1, profile, endpoint, canonicalEndpoint: "unix:///run/docker.sock", user: process.getuid!(), machine: identity.machineId, hashes, externalDependencies, enablement: Object.fromEntries(units.map((unit) => [unit, observed[unit]!.UnitFileState])), effects: { action: "service-start", units, enable: false, membership: "unchanged", configuration: "unchanged" } }), "hex");
    const target = `Docker Arch service-start plan ${checksum}`;
    const plan = { action: "service-start", method: profile.method, endpoint, units, externalDependencies, checksum };
    const authority = () => failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "Starting Docker and its declared containerd/socket dependencies needs a separate matching service-start grant. Boot enablement and user access are unchanged.", actions: [{ command: "fleur setup", description: "Inspect this exact service-start action interactively." }] }, { plan, resumable: true });
    const specified = input.args[0] === "--grant" ? input.args[1] : undefined;
    const matches = (grant: Grant) => !grant.revoked && (!specified || grant.id === specified) && grant.action === "service-start" && grant.method === profile.method && grant.target === target && grant.planChecksum === checksum && grant.machine === identity.machineId && grant.user === process.getuid?.();
    let grants = [...await readAuthority()];
    let grant = grants.find(matches);
    if (!grant && !specified && !input.json && host.interactive && host.confirmHuman) {
      const decision = await host.confirmHuman({ action: "service-start", method: profile.method, target, checksum }, remaining());
      if (decision === "once" || decision === "remembered") {
        grant = { id: crypto.randomUUID(), action: "service-start", method: profile.method, target, planChecksum: checksum, machine: identity.machineId!, user: process.getuid!(), mode: decision, revoked: false };
        grants.push(grant);
        await writeAuthority(grants);
      }
    }
    if (!grant) return authority();
    let currentEndpoint: string | undefined;
    const reprobe = () => doctor({ ...input, args: [], timeoutSeconds: remaining() / 1000 }, host, (value) => { currentEndpoint = value; });
    const before = await reprobe();
    const beforeComponents = diagnostic(diagnostic(before.result.data).components);
    if (!permitsArchSystemStart(beforeComponents.service)) return { ...before, result: { ...before.result, command: "setup" } };
    if (currentEndpoint !== endpoint || JSON.stringify(await host.host()) !== JSON.stringify(identity)) return manual("The selected endpoint or machine changed; no service action was taken.");
    const fresh = await observe(host, remaining);
    if (fresh["docker.service"]!.ActiveState === "active") return { ...before, result: { ...before.result, command: "setup" } };
    await provenance(host, remaining, profile);
    for (const unit of externalDependencies) await command(host, remaining, ["/usr/bin/systemctl", "--system", "is-active", "--quiet", unit]);
    if (units.some((unit) => fresh[unit]!.UnitFileState !== observed[unit]!.UnitFileState)) return manual("Service configuration changed after authorization; no service action was taken.");
    grants = [...await readAuthority()];
    grant = grants.find(matches);
    if (!grant) return authority();
    privilegedPhase = true;
    const pending = await open(pendingPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await pending.writeFile(JSON.stringify({ formatVersion: 1, action: "service-start", checksum, endpoint, units })); await pending.sync(); }
    finally { await pending.close(); }
    await sync();
    if (grant.mode === "once") await writeAuthority(grants.map((value) => value.id === grant!.id ? { ...value, revoked: true } : value));
    if (remaining() <= 0) throw new ServiceRecovery("Start deadline expired");
    const result = await host.run(["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "--system", "--no-ask-password", "--job-mode=fail", "start", "docker.service"], remaining());
    if (result.status === "completed" && result.exitCode === 1 && !unconfirmed(result) && /^sudo: a password is required\s*$/.test(result.stderr)) {
      await unlink(pendingPath); await sync(); privilegedPhase = false;
      return manual("OS authentication is required. Complete it outside Fleur and inspect fresh service-start authority before retrying.");
    }
    if (!terminal(result)) throw new ServiceRecovery("Privileged start has no confirmed terminal result");
    const after = await observe(host, remaining);
    if (units.some((unit) => after[unit]!.ActiveState !== "active" || after[unit]!.UnitFileState !== observed[unit]!.UnitFileState)) throw new ServiceRecovery("Service activation or unchanged enablement unconfirmed");
    await provenance(host, remaining, profile);
    // The privileged operation is terminal and its declared units are confirmed before retiring its fence.
    await unlink(pendingPath); await sync(); privilegedPhase = false;
    currentEndpoint = undefined;
    const frozenHost: SetupHost = { ...host, environment: { ...host.environment, DOCKER_CONTEXT: undefined, DOCKER_HOST: endpoint } };
    const ready = await doctor({ ...input, args: [], timeoutSeconds: remaining() / 1000 }, frozenHost, (value) => { currentEndpoint = value; });
    if (currentEndpoint !== endpoint) throw new ServiceRecovery("Post-start endpoint observation unavailable");
    const data = diagnostic(ready.result.data);
    return { ...ready, result: { ...ready.result, command: "setup", data: { ...data, setupAction: { action: "service-start", state: "completed" }, resumable: true } } };
  } catch (error) {
    if (privilegedPhase || error instanceof ServiceRecovery) return failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "Service startup or its private authority state is uncertain. Inspect actual service and pending-operation state before recovery; no automatic retry, force or restart was attempted.", actions: [] }, { resumable: true });
    return manual("Service provenance, state or dependencies are unverified. Custom, masked or changing units were preserved without starting or reconfiguring them.");
  }
}

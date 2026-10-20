import { permitsArchSystemStart } from "./activation-observer.ts";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { doctor } from "./doctor.ts";
import { readGrants, writeGrants, stateDirectory, type Grant } from "./grants.ts";
import { syncStateDirectory } from "./lock.ts";
import { failure, type CliOutcome, type Json } from "../cli/result.ts";
import type { CommandInput } from "../cli/catalog.ts";
import type { HostCommandResult, HostIdentity, SetupHost } from "./commands.ts";

/** Private source-owned adapters supply provenance; no CLI/project can construct this policy. */
export interface LinuxServicePolicy {
  readonly method: "arch-official-pacman" | "docker-official-apt";
  readonly label: string;
  readonly membershipTool: "apt-shadow" | "arch-shadow";
  readonly targetDescription?: string;
  readonly binding: unknown;
  readonly hashes: Readonly<Record<string, string>>;
  readonly pendingPath: (host: SetupHost) => string;
  readonly fragmentPaths: (unit: string) => readonly string[];
  readonly prestartEffects?: Json;
  readonly provenance: (host: SetupHost, remaining: () => number) => Promise<void>;
}
const units = ["docker.service", "docker.socket", "containerd.service"] as const;
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
export async function serviceObservation(host: SetupHost, remaining: () => number, args: readonly string[]): Promise<string> {
  if (remaining() <= 0) throw new Error("Service observation deadline");
  const result = await host.run(args, remaining());
  if (!terminal(result)) throw new Error("Service observation unavailable");
  return result.stdout;
}
function parseProperties(text: string, unit: string): Record<string, string> {
  if (text.length > 16384) throw new Error("Unit metadata is oversized");
  const result: Record<string, string> = {};
  for (const line of text.replace(/(?:\r?\n)+$/, "").split("\n")) {
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (index < 1 || !properties.includes(key) || Object.hasOwn(result, key)) throw new Error("Unknown unit metadata");
    result[key] = line.slice(index + 1);
  }
  if (Object.keys(result).length !== properties.length || result.Id !== unit) throw new Error("Incomplete unit metadata");
  return result;
}
export async function observeLinuxService(host: SetupHost, remaining: () => number, policy: LinuxServicePolicy) {
  const observed: Record<string, Record<string, string>> = {};
  for (const unit of units) {
    const value = parseProperties(await serviceObservation(host, remaining, ["/usr/bin/systemctl", "--system", "show", "--all", "--no-pager", `--property=${properties.join(",")}`, unit]), unit);
    if (value.LoadState !== "loaded" || !["enabled", "disabled"].includes(value.UnitFileState!) || !policy.fragmentPaths(unit).includes(value.FragmentPath!) || value.DropInPaths !== "" || value.Transient !== "no" || value.NeedDaemonReload !== "no" || (value.Job !== "" && value.Job !== "0")) throw new Error("Custom, masked or changing unit");
    if (["Requisite", "BindsTo", "Upholds", "OnSuccess", "OnFailure"].some((key) => value[key] !== "") || value.CanStart !== "yes" || value.RefuseManualStart !== "no") throw new Error("Unreviewed activation or manual-start policy");
    const state = `${value.ActiveState}/${value.SubState}`;
    if (!(unit.endsWith(".socket") ? ["inactive/dead", "active/listening", "active/running"] : ["inactive/dead", "active/running"]).includes(state)) throw new Error("Service state requires human action");
    const wants = value.Wants!.split(/\s+/).filter(Boolean);
    const requires = value.Requires!.split(/\s+/).filter(Boolean);
    const allowedWants = unit === "docker.service" ? ["network-online.target", "containerd.service"] : [];
    const allowedRequires = unit === "docker.service" ? ["docker.socket", "sysinit.target", "system.slice"] : ["sysinit.target", "system.slice"];
    if (wants.some((name) => !allowedWants.includes(name)) || requires.some((name) => !allowedRequires.includes(name)) || (unit === "docker.service" && (allowedWants.some((name) => !wants.includes(name)) || !requires.includes("docker.socket")))) throw new Error("Unreviewed service dependency");
    observed[unit] = value;
  }
  if (observed["docker.socket"]!.SubState === "running" && (observed["docker.service"]!.ActiveState !== "active" || observed["docker.service"]!.SubState !== "running")) throw new Error("Running socket and Docker service state disagree");
  return observed;
}
/** Caller holds the existing setup lock and has checked exact package state and its pending fence. */
export async function setupLinuxService(input: CommandInput, host: SetupHost, identity: HostIdentity, policy: LinuxServicePolicy, remaining: () => number, endpoint?: string): Promise<CliOutcome> {
  const { method, binding, hashes } = policy;
  const manual = (message: string) => failure("setup", 3, { code: "HUMAN_ACTION_REQUIRED", message, actions: [] }, { resumable: true });
  if (!endpoint) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Exact installed packages do not establish an admitted local service action.", actions: [] });
  if (endpoint === "unix:///var/run/docker.sock") {
    try { if ((await serviceObservation(host, remaining, ["/usr/bin/readlink", "--canonicalize-existing", "/var/run"])).trim() !== "/run") return manual("The selected socket alias could not be verified; it was preserved."); }
    catch { return manual("The selected socket alias could not be verified; it was preserved."); }
  } else if (endpoint !== "unix:///run/docker.sock") return manual("This local endpoint is not the reviewed system Docker socket. No system service or context was changed.");
  const pendingPath = policy.pendingPath(host);
  let privilegedPhase = false;
  const readAuthority = async () => { try { return await readGrants(host); } catch { throw new ServiceRecovery("Unsafe authority state"); } };
  const writeAuthority = async (grants: readonly Grant[]) => { try { await writeGrants(host, grants); } catch { throw new ServiceRecovery("Authority not durable"); } };
  const sync = () => (host.syncDirectory ?? syncStateDirectory)(stateDirectory(host));
  try {
    try { await lstat(pendingPath); throw new ServiceRecovery("Earlier service operation is unresolved"); } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
    const observed = await observeLinuxService(host, remaining, policy);
    if (observed["docker.service"]!.ActiveState === "active") return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The Docker service is already active. Access and runtime readiness need separate observation; no restart was attempted.", actions: [{ command: "fleur doctor", description: "Inspect current-user readiness." }] });
    await policy.provenance(host, remaining);
    for (const unit of externalDependencies) await serviceObservation(host, remaining, ["/usr/bin/systemctl", "--system", "is-active", "--quiet", unit]);
    const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify({ formatVersion: 1, profile: binding, ...(policy.prestartEffects ? { prestartEffects: policy.prestartEffects } : {}), endpoint, canonicalEndpoint: "unix:///run/docker.sock", user: process.getuid!(), machine: identity.machineId, hashes, externalDependencies, enablement: Object.fromEntries(units.map((unit) => [unit, observed[unit]!.UnitFileState])), effects: { action: "service-start", units, enable: false, membership: "unchanged", configuration: "unchanged" } }), "hex");
    const target = `Docker ${policy.label} service-start plan ${checksum}${policy.targetDescription ? `; ${policy.targetDescription}` : ""}`;
    const plan = { ...(policy.prestartEffects ? { prestartEffects: policy.prestartEffects } : {}), action: "service-start", method: method, endpoint, units, externalDependencies, checksum, ...(policy.targetDescription ? { target } : {}) };
    const authority = () => failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "Starting Docker and its declared containerd/socket dependencies needs a separate matching service-start grant. Boot enablement and user access are unchanged.", actions: [{ command: "fleur setup", description: "Inspect this exact service-start action interactively." }] }, { plan, resumable: true });
    const specified = input.args[0] === "--grant" ? input.args[1] : undefined;
    const matches = (grant: Grant) => !grant.revoked && (!specified || grant.id === specified) && grant.action === "service-start" && grant.method === method && grant.target === target && grant.planChecksum === checksum && grant.machine === identity.machineId && grant.user === process.getuid?.();
    let grants = [...await readAuthority()];
    let grant = grants.find(matches);
    if (!grant && !specified && !input.json && host.interactive && host.confirmHuman) {
      const decision = await host.confirmHuman({ action: "service-start", method: method, target, checksum }, remaining());
      if (decision === "once" || decision === "remembered") {
        grant = { id: crypto.randomUUID(), action: "service-start", method: method, target, planChecksum: checksum, machine: identity.machineId!, user: process.getuid!(), mode: decision, revoked: false };
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
    const fresh = await observeLinuxService(host, remaining, policy);
    if (fresh["docker.service"]!.ActiveState === "active") return { ...before, result: { ...before.result, command: "setup" } };
    await policy.provenance(host, remaining);
    for (const unit of externalDependencies) await serviceObservation(host, remaining, ["/usr/bin/systemctl", "--system", "is-active", "--quiet", unit]);
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
    const after = await observeLinuxService(host, remaining, policy);
    if (units.some((unit) => after[unit]!.ActiveState !== "active" || after[unit]!.UnitFileState !== observed[unit]!.UnitFileState)) throw new ServiceRecovery("Service activation or unchanged enablement unconfirmed");
    await policy.provenance(host, remaining);
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

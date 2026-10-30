import { smokeImages } from "./profiles.ts";
import { verifiedReadinessProfiles } from "./verified-readiness-profiles.ts";
import type { HostIdentity } from "./commands.ts";

type RecordValue = Record<string, unknown>;
interface BuildIdentity { readonly version: string; readonly commit: string }
export interface VerifiedReadinessProfile {
  readonly id: string;
  readonly host: { readonly system: "darwin" | "linux"; readonly distribution: "ubuntu" | "debian" | "arch" | null; readonly release: string; readonly architecture: "x64" | "arm64" };
  readonly bun: string;
  readonly cli: BuildIdentity;
  readonly engine: BuildIdentity & { readonly kernel: string; readonly platform: string; readonly cgroupDriver: "systemd" | "cgroupfs"; readonly cgroupVersion: "2"; readonly operatingMode: "rootful" | "rootless"; readonly securityOptions: readonly string[] };
  readonly containerd: BuildIdentity;
  readonly runc: BuildIdentity;
  readonly compose: string;
  readonly image: string;
  readonly evidence: { readonly readinessSha256: string; readonly isolationSha256: string };
  /** `minimum` admits the measured tuple or newer Docker component versions with the same isolation options (decision #118); `exact` (default) admits one build. */
  readonly admission?: "exact" | "minimum";
}

/** Reviewed release authority only. Observations and installer grants do not add entries. */
export const nativeReadinessProfiles: readonly VerifiedReadinessProfile[] = snapshotReadinessProfiles(verifiedReadinessProfiles);

function object(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function shape(value: unknown, keys: readonly string[]): value is RecordValue { return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function version(value: unknown): value is string { return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value); }
function revision(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._+-]{1,128}$/.test(value); }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function build(value: unknown): value is RecordValue { return shape(value, ["version", "commit"]) && typeof value.version === "string" && /^v?\d+\.\d+\.\d+$/.test(value.version) && revision(value.commit); }
function securityOptions(value: unknown): { readonly operatingMode: "rootful" | "rootless"; readonly entries: readonly string[] } | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const known = new Map([["name=apparmor", "apparmor"], ["name=apparmor,profile=default", "apparmor"], ["name=selinux", "selinux"], ["name=cgroupns", "cgroupns"], ["name=rootless", "rootless"], ["name=userns", "userns"], ["name=seccomp,profile=builtin", "seccomp"]]);
  const names = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !known.has(entry)) return undefined;
    const name = known.get(entry)!;
    if (names.has(name)) return undefined;
    names.add(name);
  }
  return { operatingMode: names.has("rootless") ? "rootless" : "rootful", entries: [...value].sort() };
}
function validProfile(value: unknown): value is VerifiedReadinessProfile {
  const required = ["id", "host", "bun", "cli", "engine", "containerd", "runc", "compose", "image", "evidence"];
  if (!shape(value, required) && !(shape(value, [...required, "admission"]) && (value.admission === "exact" || value.admission === "minimum"))) return false;
  const host = value.host;
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(value.id) || !shape(host, ["system", "distribution", "release", "architecture"])) return false;
  if ((host.system !== "darwin" && host.system !== "linux") || (host.architecture !== "x64" && host.architecture !== "arm64") || typeof host.release !== "string" || !/^(?:\d+(?:\.\d+){0,2}|rolling)$/.test(host.release)) return false;
  if (host.system === "darwin" ? host.distribution !== null : (typeof host.distribution !== "string" || !["ubuntu", "debian", "arch"].includes(host.distribution))) return false;
  if (host.distribution === "arch" && host.architecture !== "x64") return false;
  if (!version(value.bun) || !version(value.compose) || !build(value.cli) || !version(value.cli.version) || !/^[a-f0-9]{7,40}$/.test(String(value.cli.commit))) return false;
  const engine = value.engine;
  if (!shape(engine, ["version", "commit", "kernel", "platform", "cgroupDriver", "cgroupVersion", "operatingMode", "securityOptions"]) || !version(engine.version) || typeof engine.commit !== "string" || !/^[a-f0-9]{7,40}$/.test(engine.commit) || !revision(engine.kernel) || typeof engine.platform !== "string" || !/^[\x20-\x7e]{1,256}$/.test(engine.platform)) return false;
  const security = securityOptions(engine.securityOptions);
  if (!security || security.operatingMode !== engine.operatingMode || (engine.cgroupDriver !== "systemd" && engine.cgroupDriver !== "cgroupfs") || engine.cgroupVersion !== "2") return false;
  return build(value.containerd) && build(value.runc) && typeof value.image === "string" && /^oven\/bun@sha256:[a-f0-9]{64}$/.test(value.image) && value.image === smokeImages[host.architecture] && shape(value.evidence, ["readinessSha256", "isolationSha256"]) && hash(value.evidence.readinessSha256) && hash(value.evidence.isolationSha256);
}

/** Copy before any host await; later mutations cannot change an in-flight policy. */
export function snapshotReadinessProfiles(values: readonly VerifiedReadinessProfile[]): readonly VerifiedReadinessProfile[] {
  if (!Array.isArray(values) || values.length > 128) return Object.freeze([]);
  const ids = new Set<string>();
  const tuples = new Set<string>();
  const result: VerifiedReadinessProfile[] = [];
  for (const value of values) {
    if (!validProfile(value)) return Object.freeze([]);
    const tuple = JSON.stringify([value.host.system, value.host.distribution, value.host.release, value.host.architecture, value.bun, value.cli.version, value.cli.commit, value.engine.version, value.engine.commit, value.engine.kernel, value.engine.platform, value.engine.cgroupDriver, value.engine.cgroupVersion, value.engine.operatingMode, securityOptions(value.engine.securityOptions)!.entries, value.containerd.version, value.containerd.commit, value.runc.version, value.runc.commit, value.compose, value.image, value.admission ?? "exact"]);
    if (ids.has(value.id) || tuples.has(tuple)) return Object.freeze([]);
    ids.add(value.id); tuples.add(tuple);
    result.push(Object.freeze({ ...value, host: Object.freeze({ ...value.host }), cli: Object.freeze({ ...value.cli }), engine: Object.freeze({ ...value.engine, securityOptions: Object.freeze([...value.engine.securityOptions].sort()) }), containerd: Object.freeze({ ...value.containerd }), runc: Object.freeze({ ...value.runc }), evidence: Object.freeze({ ...value.evidence }) }));
  }
  return Object.freeze(result);
}

/** Numeric semantic-version floor; `minimum` profiles admit equal or newer, `exact` profiles admit equal only. */
function versionAdmitted(profile: VerifiedReadinessProfile, observed: unknown, expected: string): boolean {
  if (typeof observed !== "string") return false;
  if (profile.admission !== "minimum") return observed === expected;
  const parse = (value: string) => /^v?\d+\.\d+\.\d+$/.test(value) ? value.replace(/^v/, "").split(".").map(Number) : undefined;
  const actual = parse(observed), floor = parse(expected);
  if (!actual || !floor || observed.startsWith("v") !== expected.startsWith("v")) return false;
  for (let index = 0; index < 3; index += 1) if (actual[index] !== floor[index]) return actual[index]! > floor[index]!;
  return true;
}
/** A build commit identifies one exact build; minimum profiles compare versions instead. */
function commitAdmitted(profile: VerifiedReadinessProfile, observed: unknown, expected: string): boolean { return profile.admission === "minimum" ? revision(observed) : observed === expected; }
/** Kernels keep their exact flavor suffix (for example `-linuxkit`); only the numeric release may be newer. */
function kernelAdmitted(profile: VerifiedReadinessProfile, observed: unknown): boolean {
  if (profile.admission !== "minimum") return observed === profile.engine.kernel;
  const split = (value: unknown) => typeof value === "string" ? /^(\d+\.\d+\.\d+)(.*)$/.exec(value) : null;
  const actual = split(observed), floor = split(profile.engine.kernel);
  return !!actual && !!floor && actual[2] === floor[2] && versionAdmitted(profile, actual[1], floor[1]!);
}
/** Platform names such as `Docker Desktop 4.96.1 (244132)` keep their product prefix; the version may be newer and the build number is free. */
function platformAdmitted(profile: VerifiedReadinessProfile, observed: unknown): boolean {
  if (profile.admission !== "minimum") return observed === profile.engine.platform;
  const split = (value: unknown) => typeof value === "string" ? /^(.*?) (\d+\.\d+\.\d+)(?: \(\d+\))?$/.exec(value) : null;
  const actual = split(observed), floor = split(profile.engine.platform);
  return !!actual && !!floor && actual[1] === floor[1] && versionAdmitted(profile, actual[2], floor[2]!);
}

function nativeServerArchitecture(identity: HostIdentity): string { return identity.architecture === "x64" ? "amd64" : "arm64"; }
function daemonIdentity(value: unknown): value is RecordValue {
  return object(value) && typeof value.ID === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(value.ID) && version(value.ServerVersion) && revision(value.KernelVersion) && value.OSType === "linux" && typeof value.Architecture === "string" && value.CgroupVersion === "2" && value.MemoryLimit === true && value.PidsLimit === true && value.CpuCfsPeriod === true && value.CpuCfsQuota === true && (value.CgroupDriver === "systemd" || value.CgroupDriver === "cgroupfs") && securityOptions(value.SecurityOptions) !== undefined;
}
export function readinessCandidates(profiles: readonly VerifiedReadinessProfile[], identity: HostIdentity, bun: string, cli: string, compose: string, image: string, info: unknown): readonly VerifiedReadinessProfile[] {
  if (identity.translated !== false || !daemonIdentity(info)) return [];
  const architecture = nativeServerArchitecture(identity);
  if (!(architecture === "amd64" ? ["amd64", "x86_64"] : ["arm64", "aarch64"]).includes(String(info.Architecture))) return [];
  const security = securityOptions(info.SecurityOptions)!;
  const client = /^Docker version (\d+\.\d+\.\d+), build ([a-f0-9]{7,40})$/.exec(cli.trim());
  if (!client) return [];
  return profiles.filter((profile) => profile.host.system === identity.system && profile.host.distribution === (identity.distribution ?? null) && profile.host.release === identity.release && profile.host.architecture === identity.architecture && profile.bun === bun && versionAdmitted(profile, client[1], profile.cli.version) && commitAdmitted(profile, client[2], profile.cli.commit) && versionAdmitted(profile, compose.trim(), profile.compose) && profile.image === image && versionAdmitted(profile, info.ServerVersion, profile.engine.version) && kernelAdmitted(profile, info.KernelVersion) && profile.engine.cgroupVersion === info.CgroupVersion && profile.engine.cgroupDriver === info.CgroupDriver && profile.engine.operatingMode === security.operatingMode && JSON.stringify(profile.engine.securityOptions) === JSON.stringify(security.entries));
}

function component(profile: VerifiedReadinessProfile, server: RecordValue, name: string, expected: BuildIdentity): boolean {
  if (!Array.isArray(server.Components)) return false;
  const rows = server.Components.filter((row: unknown) => object(row) && row.Name === name);
  const row: unknown = rows[0];
  return rows.length === 1 && object(row) && versionAdmitted(profile, row.Version, expected.version) && object(row.Details) && commitAdmitted(profile, row.Details.GitCommit, expected.commit);
}
export function matchReadinessServer(profiles: readonly VerifiedReadinessProfile[], identity: HostIdentity, server: unknown): VerifiedReadinessProfile | undefined {
  if (!object(server) || server.Os !== "linux" || server.Arch !== nativeServerArchitecture(identity) || !object(server.Platform)) return undefined;
  const platform = server.Platform;
  const matches = profiles.filter((profile) => versionAdmitted(profile, server.Version, profile.engine.version) && commitAdmitted(profile, server.GitCommit, profile.engine.commit) && kernelAdmitted(profile, server.KernelVersion) && platformAdmitted(profile, platform.Name) && component(profile, server, "Engine", profile.engine) && component(profile, server, "containerd", profile.containerd) && component(profile, server, "runc", profile.runc));
  return matches.length === 1 ? matches[0] : undefined;
}
export function sameReadinessDaemon(before: unknown, after: unknown): boolean {
  return daemonIdentity(before) && daemonIdentity(after) && ["ID", "ServerVersion", "KernelVersion", "OSType", "Architecture", "CgroupDriver", "CgroupVersion"].every((key) => before[key] === after[key]) && JSON.stringify(securityOptions(before.SecurityOptions)!.entries) === JSON.stringify(securityOptions(after.SecurityOptions)!.entries);
}

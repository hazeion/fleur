import { smokeImages } from "./profiles.ts";
import { verifiedReadinessProfiles } from "./verified-readiness-profiles.ts";
import type { HostIdentity } from "./commands.ts";

type RecordValue = Record<string, unknown>;
interface BuildIdentity { readonly version: string; readonly commit: string }
/** One measured readiness row. Rows are evidence; the policy is the per-target floor derived from them (version floors amendment, #124). */
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
}

/** Machine tools compared as version floors, in report order. `desktop` is the Docker Desktop product version and exists only for Desktop targets. */
export type ReadinessTool = "release" | "kernel" | "bun" | "desktop" | "cli" | "engine" | "compose" | "containerd" | "runc";
export type VersionComparison = "equal" | "newer" | "older" | "pre-release" | "unparseable";
/** `identity` is a kernel whose flavour tail differs from the floor; every other tool reports a prefix or grammar difference as unparseable. */
export type FloorComparison = VersionComparison | "identity";
export interface MachineToolComparison { readonly tool: ReadinessTool; readonly status: "verified" | "admitted" | "unverified"; readonly floor: string; readonly detected: string | null; readonly comparison: VersionComparison }
export type DockerProduct = "desktop" | "engine";
export interface ReadinessFloor {
  readonly id: string;
  /** GitHub-hosted runner kernels form CI-only targets (decision #127); they are not required targets. */
  readonly ciOnly: boolean;
  readonly target: { readonly system: "darwin" | "linux"; readonly distribution: "ubuntu" | "debian" | "arch" | null; readonly architecture: "x64" | "arm64"; readonly product: DockerProduct; readonly kernel: string };
  readonly rows: readonly string[];
  /** Componentwise minimum over the target's measured rows. */
  readonly versions: Readonly<Partial<Record<ReadinessTool, string>>>;
}
/** Everything doctor observes before admission. `bun.revision` is `bun --revision`, the only place a canary or debug tag shows. */
export interface ReadinessObservation {
  readonly identity: HostIdentity;
  readonly bun: string | { readonly version: string; readonly revision?: string };
  readonly cli: string;
  readonly compose: string;
  readonly image: string;
  readonly info: unknown;
  readonly server: unknown;
}
export interface ReadinessComparison {
  readonly state: "verified" | "unverified";
  readonly admission: "measured" | "above-floor" | null;
  readonly floor: string | null;
  readonly measuredRows: readonly string[];
  readonly machineTools: readonly MachineToolComparison[];
  /** First machine tool below, before or outside its floor; null when identity itself did not match. */
  readonly blocking: MachineToolComparison | null;
  /** Identity facts that differ from the closest measured row when no row matches. */
  readonly identity: { readonly matched: boolean; readonly mismatches: readonly string[] };
}

const toolOrder: readonly ReadinessTool[] = ["release", "kernel", "bun", "desktop", "cli", "engine", "compose", "containerd", "runc"];
/** Kernel flavours of GitHub-hosted runners; their rows stay CI-only profiles with their own floor id. */
const ciRunnerKernelFlavours: ReadonlySet<string> = new Set(["azure"]);
/** Pre-release tags follow the numeric core directly; checked before any grammar so a grammar cannot swallow them. */
const preReleaseMarker = /^v?\d+(?:\.\d+){0,3}-(?:rc|beta|alpha|canary|debug)(?:[.\d+-]|$)/i;
/** Kernel SCM decorations from scripts/setlocalversion: a bare `+`, `-dirty`, or `-N-g<sha>` identify an unreleased build. */
const unreleasedMarker = /\+$|-dirty(?:$|[-+.])|-\d+-g[0-9a-f]+$/;

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

// Version grammars (research/version-floor-strings.md): a zero-padded numeric core plus an exact identity tail.
interface ParsedVersion { readonly numbers: readonly number[]; readonly identity: string }
const kernelGrammars: readonly { readonly pattern: RegExp; readonly parse: (match: RegExpExecArray) => ParsedVersion }[] = [
  // Ubuntu X.Y.Z-ABI-flavour: the ABI is monotone within a series and the sublevel is always zero.
  { pattern: /^(\d+)\.(\d+)\.(\d+)-(\d+)-([a-z][a-z0-9-]*)$/, parse: (m) => ({ numbers: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])], identity: `ubuntu:${m[5]}` }) },
  // Debian 13+ X.Y[.Z]+debN[.serial]-flavour: the Debian release belongs to identity, the serial is a numeric ABI bump.
  { pattern: /^(\d+)\.(\d+)(?:\.(\d+))?\+deb(\d+)(?:\.(\d+))?-([a-z][a-z0-9-]*)$/, parse: (m) => ({ numbers: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0), Number(m[5] ?? 0)], identity: `debian:deb${m[4]}-${m[6]}` }) },
  // Localversion X.Y[.Z]-name (linuxkit): an upstream `.0` release prints two components.
  { pattern: /^(\d+)\.(\d+)(?:\.(\d+))?-([a-z][a-z0-9-]*)$/, parse: (m) => ({ numbers: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)], identity: `local:${m[4]}` }) },
];
function parseVersion(tool: ReadinessTool, value: string): ParsedVersion | undefined {
  if (tool === "kernel") {
    for (const grammar of kernelGrammars) { const match = grammar.pattern.exec(value); if (match) return grammar.parse(match); }
    return undefined;
  }
  if (tool === "release") {
    const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
    return match ? { numbers: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)], identity: "" } : undefined;
  }
  // Bun, Docker Engine/CLI, Compose, runc and the Desktop product print X.Y.Z; containerd keeps its tag's `v`, and the measured prefix is identity.
  const match = /^(v?)(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? { numbers: [Number(match[2]), Number(match[3]), Number(match[4])], identity: match[1]! } : undefined;
}
/** Stable version of a machine tool as a floor: no pre-release or unreleased marker, parses under the tool grammar. */
function stableVersion(tool: ReadinessTool, value: unknown): ParsedVersion | undefined {
  return typeof value === "string" && !preReleaseMarker.test(value) && !unreleasedMarker.test(value) ? parseVersion(tool, value) : undefined;
}
function order(observed: readonly number[], floor: readonly number[]): "older" | "equal" | "newer" {
  for (let index = 0; index < Math.max(observed.length, floor.length); index += 1) {
    const actual = observed[index] ?? 0, minimum = floor[index] ?? 0;
    if (actual !== minimum) return actual > minimum ? "newer" : "older";
  }
  return "equal";
}
/** Compare one detected machine tool version with its floor. Equal or newer is admitted; the other outcomes each refuse distinctly. */
export function compareMachineTool(tool: ReadinessTool, floor: string, detected: unknown): FloorComparison {
  const minimum = stableVersion(tool, floor);
  if (!minimum || typeof detected !== "string") return "unparseable";
  if (preReleaseMarker.test(detected)) return "pre-release";
  if (unreleasedMarker.test(detected)) return "unparseable";
  const observed = parseVersion(tool, detected);
  if (!observed) return "unparseable";
  if (observed.identity !== minimum.identity) return tool === "kernel" ? "identity" : "unparseable";
  return order(observed.numbers, minimum.numbers);
}
function kernelFlavour(kernel: string): string | undefined { return stableVersion("kernel", kernel)?.identity.split(":")[1]; }

/** Platform names such as `Docker Desktop 4.96.1 (244132)` carry a product prefix (identity), a version (floor) and a free build number. */
function platform(value: unknown): { readonly prefix: string; readonly version: string | null; readonly product: DockerProduct } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(.*?) (\d+\.\d+\.\d+)(?: \(\d+\))?$/.exec(value);
  const prefix = match ? match[1]! : value;
  return { prefix, version: match ? match[2]! : null, product: prefix.startsWith("Docker Desktop") ? "desktop" : "engine" };
}

function validProfile(value: unknown): value is VerifiedReadinessProfile {
  if (!shape(value, ["id", "host", "bun", "cli", "engine", "containerd", "runc", "compose", "image", "evidence"])) return false;
  const host = value.host;
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(value.id) || !shape(host, ["system", "distribution", "release", "architecture"])) return false;
  if ((host.system !== "darwin" && host.system !== "linux") || (host.architecture !== "x64" && host.architecture !== "arm64") || !stableVersion("release", host.release)) return false;
  if (host.system === "darwin" ? host.distribution !== null : (typeof host.distribution !== "string" || !["ubuntu", "debian", "arch"].includes(host.distribution))) return false;
  if (host.distribution === "arch" && host.architecture !== "x64") return false;
  if (!version(value.bun) || !version(value.compose) || !build(value.cli) || !version(value.cli.version) || !/^[a-f0-9]{7,40}$/.test(String(value.cli.commit))) return false;
  const engine = value.engine;
  if (!shape(engine, ["version", "commit", "kernel", "platform", "cgroupDriver", "cgroupVersion", "operatingMode", "securityOptions"]) || !version(engine.version) || typeof engine.commit !== "string" || !/^[a-f0-9]{7,40}$/.test(engine.commit) || !revision(engine.kernel) || !stableVersion("kernel", engine.kernel) || typeof engine.platform !== "string" || !/^[\x20-\x7e]{1,256}$/.test(engine.platform)) return false;
  const product = platform(engine.platform);
  // A Desktop row without a product version cannot define the Desktop floor.
  if (!product || (product.product === "desktop" && product.version === null)) return false;
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
    const tuple = JSON.stringify([value.host.system, value.host.distribution, value.host.release, value.host.architecture, value.bun, value.cli.version, value.cli.commit, value.engine.version, value.engine.commit, value.engine.kernel, value.engine.platform, value.engine.cgroupDriver, value.engine.cgroupVersion, value.engine.operatingMode, securityOptions(value.engine.securityOptions)!.entries, value.containerd.version, value.containerd.commit, value.runc.version, value.runc.commit, value.compose, value.image]);
    if (ids.has(value.id) || tuples.has(tuple)) return Object.freeze([]);
    ids.add(value.id); tuples.add(tuple);
    result.push(Object.freeze({ ...value, host: Object.freeze({ ...value.host }), cli: Object.freeze({ ...value.cli }), engine: Object.freeze({ ...value.engine, securityOptions: Object.freeze([...value.engine.securityOptions].sort()) }), containerd: Object.freeze({ ...value.containerd }), runc: Object.freeze({ ...value.runc }), evidence: Object.freeze({ ...value.evidence }) }));
  }
  // Two targets with one floor id would merge kernel flavours; the catalog is invalid rather than ambiguous.
  return groupTargets(result) ? Object.freeze(result) : Object.freeze([]);
}

// Floors: one per target (OS family and distribution, architecture, Docker product, kernel flavour), componentwise minimum over its rows.
interface Target { readonly key: string; readonly floor: ReadinessFloor; readonly rows: readonly VerifiedReadinessProfile[] }
function toolVersion(row: VerifiedReadinessProfile, tool: ReadinessTool): string | undefined {
  switch (tool) {
    case "release": return row.host.release;
    case "kernel": return row.engine.kernel;
    case "bun": return row.bun;
    case "desktop": return platform(row.engine.platform)?.version ?? undefined;
    case "cli": return row.cli.version;
    case "engine": return row.engine.version;
    case "compose": return row.compose;
    case "containerd": return row.containerd.version;
    case "runc": return row.runc.version;
  }
}
function groupTargets(rows: readonly VerifiedReadinessProfile[]): readonly Target[] | undefined {
  const groups = new Map<string, VerifiedReadinessProfile[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.host.system, row.host.distribution, row.host.architecture, platform(row.engine.platform)!.product, stableVersion("kernel", row.engine.kernel)!.identity]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const targets: Target[] = [];
  for (const [key, members] of groups) {
    const first = members[0]!;
    const product = platform(first.engine.platform)!.product;
    const flavour = kernelFlavour(first.engine.kernel)!;
    const ciOnly = ciRunnerKernelFlavours.has(flavour);
    const id = `${first.host.distribution ?? first.host.system}-${first.host.architecture}-${product}${ciOnly ? `-${flavour}` : ""}`;
    if (targets.some((target) => target.floor.id === id)) return undefined;
    const versions: Partial<Record<ReadinessTool, string>> = {};
    for (const tool of toolOrder) {
      if (tool === "desktop" && product !== "desktop") continue;
      let lowest = toolVersion(first, tool)!;
      for (const row of members) { const value = toolVersion(row, tool)!; if (compareMachineTool(tool, lowest, value) === "older") lowest = value; }
      versions[tool] = lowest;
    }
    const floor: ReadinessFloor = Object.freeze({ id, ciOnly, target: Object.freeze({ system: first.host.system, distribution: first.host.distribution, architecture: first.host.architecture, product, kernel: flavour }), rows: Object.freeze(members.map((row) => row.id)), versions: Object.freeze(versions) });
    targets.push({ key, floor, rows: Object.freeze([...members]) });
  }
  return targets;
}
/** Published floors of a catalog, in first-row order. An invalid catalog publishes nothing. */
export function deriveReadinessFloors(profiles: readonly VerifiedReadinessProfile[]): readonly ReadinessFloor[] {
  const rows = snapshotReadinessProfiles(profiles);
  return Object.freeze((groupTargets(rows) ?? []).map((target) => target.floor));
}

// Observation: identity facts match a measured row exactly, machine tools compare against the target floor.
interface PartialObservation { readonly identity: HostIdentity; readonly bun?: ReadinessObservation["bun"]; readonly cli?: string; readonly compose?: string; readonly image?: string; readonly info?: unknown; readonly server?: unknown }
/** Identity facts in closeness order: a row disagreeing only on a later fact is nearer than one disagreeing on an earlier fact. */
const identityFacts = ["system", "distribution", "architecture", "translated", "daemon", "server", "product", "cgroupDriver", "cgroupVersion", "operatingMode", "securityOptions", "image", "kernel"] as const;
type IdentityFact = typeof identityFacts[number];
function nativeServerArchitecture(identity: HostIdentity): string { return identity.architecture === "x64" ? "amd64" : "arm64"; }
function daemonIdentity(value: unknown): value is RecordValue {
  return object(value) && typeof value.ID === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(value.ID) && typeof value.ServerVersion === "string" && revision(value.KernelVersion) && value.OSType === "linux" && typeof value.Architecture === "string" && value.CgroupVersion === "2" && value.MemoryLimit === true && value.PidsLimit === true && value.CpuCfsPeriod === true && value.CpuCfsQuota === true && (value.CgroupDriver === "systemd" || value.CgroupDriver === "cgroupfs") && securityOptions(value.SecurityOptions) !== undefined;
}
function serverIdentity(value: unknown): value is RecordValue { return object(value) && value.Os === "linux" && typeof value.Arch === "string" && object(value.Platform); }
function identityMismatches(row: VerifiedReadinessProfile, observation: PartialObservation): readonly IdentityFact[] {
  const { identity, info, server, image } = observation;
  const mismatches = new Set<IdentityFact>();
  if (row.host.system !== identity.system) mismatches.add("system");
  if (row.host.distribution !== (identity.distribution ?? null)) mismatches.add("distribution");
  if (row.host.architecture !== identity.architecture) mismatches.add("architecture");
  if (identity.translated !== false) mismatches.add("translated");
  if (image !== undefined && row.image !== image) mismatches.add("image");
  const rowKernel = stableVersion("kernel", row.engine.kernel)!.identity;
  const kernel = (value: unknown) => { const observed = stableVersion("kernel", value); if (observed && observed.identity !== rowKernel) mismatches.add("kernel"); };
  if (info !== undefined) {
    if (!daemonIdentity(info)) mismatches.add("daemon");
    else {
      if (!(identity.architecture === "x64" ? ["amd64", "x86_64"] : ["arm64", "aarch64"]).includes(String(info.Architecture))) mismatches.add("architecture");
      const security = securityOptions(info.SecurityOptions)!;
      if (row.engine.cgroupDriver !== info.CgroupDriver) mismatches.add("cgroupDriver");
      if (row.engine.cgroupVersion !== info.CgroupVersion) mismatches.add("cgroupVersion");
      if (row.engine.operatingMode !== security.operatingMode) mismatches.add("operatingMode");
      if (JSON.stringify(row.engine.securityOptions) !== JSON.stringify(security.entries)) mismatches.add("securityOptions");
      kernel(info.KernelVersion);
    }
  }
  if (server !== undefined) {
    if (!serverIdentity(server)) mismatches.add("server");
    else {
      if (server.Arch !== nativeServerArchitecture(identity)) mismatches.add("architecture");
      if (platform((server.Platform as RecordValue).Name)?.prefix !== platform(row.engine.platform)!.prefix) mismatches.add("product");
      kernel(server.KernelVersion);
    }
  }
  return identityFacts.filter((fact) => mismatches.has(fact));
}

function worst(comparisons: readonly FloorComparison[]): VersionComparison {
  const blocking = comparisons.find((comparison) => comparison !== "equal" && comparison !== "newer");
  if (blocking) return blocking === "identity" ? "unparseable" : blocking;
  return comparisons.includes("newer") ? "newer" : "equal";
}
function component(server: RecordValue, name: string): { readonly version: unknown; readonly commit: unknown } | undefined {
  if (!Array.isArray(server.Components)) return undefined;
  const rows = server.Components.filter((row: unknown) => object(row) && row.Name === name);
  const row: unknown = rows[0];
  return rows.length === 1 && object(row) && object(row.Details) ? { version: row.Version, commit: row.Details.GitCommit } : undefined;
}
/** Observed values for one tool: the first is reported as detected; every value must be admitted. */
function detections(target: Target, tool: ReadinessTool, observation: PartialObservation): readonly unknown[] | undefined {
  const { identity, bun, cli, compose, info, server } = observation;
  const daemon = info !== undefined && daemonIdentity(info) ? info : undefined;
  const build = server !== undefined && serverIdentity(server) ? server : undefined;
  switch (tool) {
    case "release": return [identity.release];
    case "kernel": return daemon || build ? [...(daemon ? [daemon.KernelVersion] : []), ...(build ? [build.KernelVersion] : [])] : undefined;
    case "bun": return bun === undefined ? undefined : [typeof bun === "string" ? bun : bun.version];
    case "desktop": return build ? [platform((build.Platform as RecordValue).Name)?.version ?? null] : undefined;
    case "cli": { if (cli === undefined) return undefined; const match = /^Docker version (\S+), build ([a-f0-9]{7,40})$/.exec(cli.trim()); return [match ? match[1] : cli.trim().slice(0, 128)]; }
    case "engine": {
      if (!daemon && !build) return undefined;
      const engine = build ? component(build, "Engine") : undefined;
      return [...(daemon ? [daemon.ServerVersion] : []), ...(build ? [build.Version, revision(build.GitCommit) && engine && revision(engine.commit) ? engine.version : null] : [])];
    }
    case "compose": return compose === undefined ? undefined : [compose.trim()];
    case "containerd": case "runc": { if (!build) return undefined; const row = component(build, tool); return [row && revision(row.commit) ? row.version : null]; }
  }
}
function compareTool(target: Target, tool: ReadinessTool, observation: PartialObservation): MachineToolComparison | undefined {
  const floor = target.floor.versions[tool];
  const observed = detections(target, tool, observation);
  if (floor === undefined || observed === undefined) return undefined;
  const first = observed[0];
  let detected = typeof first === "string" ? first : null;
  let comparison = worst(observed.map((value) => compareMachineTool(tool, floor, value)));
  if (tool === "bun" && typeof observation.bun === "object" && observation.bun.revision !== undefined) {
    // Bun.version hides canary and debug tags; bun --revision prints X.Y.Z[-tag]+sha for the same executable.
    const revisionText = observation.bun.revision;
    const described = /^(\d+\.\d+\.\d+)(?:\+[0-9a-f]{1,40})?$/.exec(revisionText);
    if (preReleaseMarker.test(revisionText)) { comparison = "pre-release"; detected = revisionText; }
    else if (!described || described[1] !== observation.bun.version) { comparison = "unparseable"; detected = revisionText; }
  }
  return { tool, status: comparison === "equal" ? "verified" : comparison === "newer" ? "admitted" : "unverified", floor, detected, comparison };
}
interface Evaluation { readonly target: Target; readonly matchedRows: readonly VerifiedReadinessProfile[]; readonly machineTools: readonly MachineToolComparison[]; readonly admitted: boolean }
function evaluate(profiles: readonly VerifiedReadinessProfile[], observation: PartialObservation): { readonly evaluations: readonly Evaluation[]; readonly mismatches: readonly IdentityFact[] } {
  const rows = profiles.every(validProfile) ? profiles : [];
  const targets = groupTargets(rows) ?? [];
  const evaluations: Evaluation[] = [];
  let closest: readonly IdentityFact[] | undefined;
  for (const target of targets) {
    const matchedRows = target.rows.filter((row) => {
      const mismatches = identityMismatches(row, observation);
      if (closest === undefined || mismatches.length < closest.length || (mismatches.length === closest.length && identityFacts.indexOf(mismatches[0]!) > identityFacts.indexOf(closest[0]!))) closest = mismatches;
      return mismatches.length === 0;
    });
    if (matchedRows.length === 0) continue;
    const machineTools = toolOrder.map((tool) => compareTool(target, tool, observation)).filter((row): row is MachineToolComparison => row !== undefined);
    evaluations.push({ target, matchedRows, machineTools, admitted: machineTools.every((row) => row.status !== "unverified") });
  }
  return { evaluations, mismatches: evaluations.length ? [] : closest ?? [] };
}

/** Structured floor admission for one complete observation; doctor renders it (#138). */
export function compareReadiness(profiles: readonly VerifiedReadinessProfile[], observation: ReadinessObservation): ReadinessComparison {
  const { evaluations, mismatches } = evaluate(profiles, observation);
  const chosen = evaluations.find((evaluation) => evaluation.admitted) ?? evaluations[0];
  if (!chosen) return { state: "unverified", admission: null, floor: null, measuredRows: [], machineTools: [], blocking: null, identity: { matched: false, mismatches } };
  const expected = toolOrder.filter((tool) => chosen.target.floor.versions[tool] !== undefined);
  const machineTools = expected.map((tool) => chosen.machineTools.find((row) => row.tool === tool) ?? { tool, status: "unverified" as const, floor: chosen.target.floor.versions[tool]!, detected: null, comparison: "unparseable" as const });
  const blocking = machineTools.find((row) => row.status === "unverified") ?? null;
  return {
    state: blocking ? "unverified" : "verified",
    admission: blocking ? null : machineTools.every((row) => row.status === "verified") ? "measured" : "above-floor",
    floor: chosen.target.floor.id, measuredRows: chosen.target.floor.rows, machineTools, blocking, identity: { matched: true, mismatches: [] },
  };
}
/** Rows of every target whose identity matches and whose host, daemon, CLI and Compose observations are admitted; the server build is checked next. */
export function readinessCandidates(profiles: readonly VerifiedReadinessProfile[], identity: HostIdentity, bun: ReadinessObservation["bun"], cli: string, compose: string, image: string, info: unknown): readonly VerifiedReadinessProfile[] {
  return evaluate(profiles, { identity, bun, cli, compose, image, info }).evaluations.filter((evaluation) => evaluation.admitted).flatMap((evaluation) => [...evaluation.target.rows]);
}
/** The admitted row for the authoritative server build: the row measured with exactly these server values, else the target's first row. */
export function matchReadinessServer(profiles: readonly VerifiedReadinessProfile[], identity: HostIdentity, server: unknown): VerifiedReadinessProfile | undefined {
  const admitted = evaluate(profiles, { identity, server }).evaluations.filter((evaluation) => evaluation.admitted);
  if (admitted.length !== 1 || !serverIdentity(server)) return undefined;
  const { target } = admitted[0]!;
  const exact = target.rows.find((row) => row.engine.kernel === server.KernelVersion && row.engine.version === server.Version && row.engine.platform === (server.Platform as RecordValue).Name && row.containerd.version === component(server, "containerd")?.version && row.runc.version === component(server, "runc")?.version);
  return exact ?? target.rows[0];
}
export function sameReadinessDaemon(before: unknown, after: unknown): boolean {
  return daemonIdentity(before) && daemonIdentity(after) && ["ID", "ServerVersion", "KernelVersion", "OSType", "Architecture", "CgroupDriver", "CgroupVersion"].every((key) => before[key] === after[key]) && JSON.stringify(securityOptions(before.SecurityOptions)!.entries) === JSON.stringify(securityOptions(after.SecurityOptions)!.entries);
}

/** Reviewed release authority only. Observations and installer grants do not add entries. Declared last so every grammar constant exists. */
export const nativeReadinessProfiles: readonly VerifiedReadinessProfile[] = snapshotReadinessProfiles(verifiedReadinessProfiles);

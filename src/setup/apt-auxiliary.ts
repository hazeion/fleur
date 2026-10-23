import type { BigIntStats } from "node:fs";
import type { Json, CliOutcome } from "../cli/result.ts";
import { failure } from "../cli/result.ts";
import type { AptInstallProfile } from "./native.ts";
import { aptServicePolicy } from "./apt-service.ts";
import type { CommandInput } from "../cli/catalog.ts";
import type { HostIdentity, SetupHost } from "./commands.ts";
import { readGrants, writeGrants, type Grant } from "./grants.ts";

export interface AptAuxiliaryManifest {
  readonly root: string;
  readonly entries: readonly { readonly path: string; readonly dev: string; readonly ino: string; readonly uid: number; readonly mode: number; readonly directory: boolean; readonly auxiliary: boolean }[];
}
/** Trusted native filesystem boundary only; never selected by project, CLI or environment. */
export interface AptAuxiliaryCustody {
  readonly request: Json;
  readonly inspectorSha256: string;
  readonly inspect: (remaining: () => number) => Promise<Json>;
  readonly verifyReceipt?: (observed: Json) => Promise<void>;
  readonly unchanged: () => Promise<void>;
  readonly close: () => Promise<void>;
}
export class AptInspectionRequired extends Error {
  constructor(readonly outcome: CliOutcome) { super("Separate retained APT inspection is required"); }
}

function inspectionPlan(identity: HostIdentity, operationId: string, pendingSha256: string, profileChecksum: string, custody: AptAuxiliaryCustody) {
  const scope = { action: "recovery-inspect", method: "docker-official-apt", target: `Read-only retained APT evidence for operation ${operationId}`, machine: identity.machineId!, user: process.getuid!() };
  const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify({ ...scope, pendingSha256, profileChecksum, bootId: identity.bootId, inspectorSha256: custody.inspectorSha256, request: custody.request }), "hex");
  return { scope, checksum };
}

/** A prior durable result can be re-observed, never used to replay its grant. */
export async function verifyAptInspectionReceipt(value: Json, host: SetupHost, identity: HostIdentity, operationId: string, pendingSha256: string, profileChecksum: string, custody: AptAuxiliaryCustody): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !custody.verifyReceipt) throw new Error("Prior inspection result unavailable");
  const record = value as Record<string, Json>;
  const { scope, checksum } = inspectionPlan(identity, operationId, pendingSha256, profileChecksum, custody);
  if (Object.keys(record).sort().join(",") !== "checksum,grantId,inspectorSha256,observed,request" || record.checksum !== checksum || record.inspectorSha256 !== custody.inspectorSha256 || JSON.stringify(record.request) !== JSON.stringify(custody.request)) throw new Error("Prior inspection binding differs");
  const grant = (await readGrants(host)).find((candidate) => candidate.id === record.grantId);
  if (!grant || grant.mode !== "once" || !grant.revoked || grant.planChecksum !== checksum || !Object.entries(scope).every(([key, item]) => grant[key as keyof Grant] === item)) throw new Error("Prior inspection authority differs");
  await custody.verifyReceipt(record.observed!);
  await custody.unchanged();
}

/** A new once grant covers this bounded inspection only, never the original installation. */
export async function authorizeAptInspection(input: CommandInput, host: SetupHost, identity: HostIdentity, operationId: string, pendingSha256: string, profileChecksum: string, custody: AptAuxiliaryCustody, remaining: () => number, revalidate: (consumedGrantId?: string) => Promise<void>): Promise<Json> {
  const { scope, checksum } = inspectionPlan(identity, operationId, pendingSha256, profileChecksum, custody);
  const specified = input.args[0] === "--grant" ? input.args[1] : undefined;
  const matches = (grant: Grant) => (!specified || grant.id === specified) && !grant.revoked && grant.mode === "once" && grant.planChecksum === checksum && Object.entries(scope).every(([key, value]) => grant[key as keyof Grant] === value);
  let grants = [...await readGrants(host)]; let grant = grants.find(matches);
  const required = () => new AptInspectionRequired(failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "A human must authorize one bounded read-only inspection of the two retained APT cache directories. Installation authority cannot cover this action; no files or ownership will be changed.", actions: [{ command: "fleur setup", description: "Inspect the separately scoped recovery inspection plan interactively." }] }, { plan: { action: scope.action, method: scope.method, target: scope.target, checksum }, resumable: true, grantsCreated: false }));
  if (!grant && !specified && !input.json && host.interactive && host.confirmHuman) {
    const decision = await host.confirmHuman({ action: scope.action, method: scope.method, target: scope.target, checksum }, remaining());
    if (decision === "once") {
      await revalidate();
      grants = [...await readGrants(host)];
      grant = { ...scope, id: crypto.randomUUID(), planChecksum: checksum, mode: "once", revoked: false };
      await writeGrants(host, [...grants, grant]);
    }
  }
  if (!grant) throw required();
  await revalidate();
  grants = [...await readGrants(host)];
  if (!grants.some((candidate) => candidate.id === grant!.id && matches(candidate))) throw new Error("APT inspection grant changed");
  await writeGrants(host, grants.map((candidate) => candidate.id === grant!.id ? { ...candidate, revoked: true } : candidate));
  await revalidate(grant.id);
  if (remaining() <= 0) throw new Error("APT inspection deadline expired");
  const observed = await custody.inspect(remaining);
  await revalidate(grant.id);
  return { grantId: grant.id, checksum, inspectorSha256: custody.inspectorSha256, request: custody.request, observed };
}

// Unconfirmed privileged reads retain parent descriptors for the rest of this
// process. They never yield a reconciliation receipt or a cleanup claim.
const unconfirmedDescriptors: unknown[] = [];

/** Retain original and auxiliary directory descriptors for the whole reconciliation. */
export async function retainAptAuxiliaries(host: SetupHost, directory: string, manifest: AptAuxiliaryManifest, profile: AptInstallProfile, remaining: () => number): Promise<AptAuxiliaryCustody> {
  const { constants } = await import("node:fs");
  const { open, lstat, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { aptInspectorProgram } = await import("./apt-inspector.ts");
  const inspectorSha256 = Bun.CryptoHasher.hash("sha256", aptInspectorProgram, "hex");
  const paths = [".", "archives", "local-lists", "archives/partial", "local-lists/auxfiles"];
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  const snapshots: { path: string; fd: number; metadata: { dev: string; ino: string; uid: number; gid: number; mode: number; nlink: string; mtimeNs: string; ctimeNs: string } }[] = [];
  const fields = (info: BigIntStats) => ({ dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid), gid: Number(info.gid), mode: Number(BigInt(info.mode) & 0o7777n), nlink: String(info.nlink), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) });
  let inspectionUnconfirmed = false;
  const close = async () => { if (inspectionUnconfirmed) unconfirmedDescriptors.push(...handles); else for (const handle of handles.reverse()) await handle.close(); handles.length = 0; };
  try {
    for (const [index, path] of paths.entries()) {
      if (remaining() <= 0) throw new Error("APT retained directory deadline expired");
      const original = manifest.entries.find((item) => item.path === path);
      if (!original?.directory || original.auxiliary !== (index >= 3)) throw new Error("Unknown APT retained directory");
      const named = join(directory, manifest.root, path);
      // Linux O_PATH permits pinning an unreadable inode without reading it.
      const handle = await open(named, (process.platform === "linux" ? 0x200000 : constants.O_RDONLY) | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      handles.push(handle);
      const info = await handle.stat({ bigint: true }); const visible = await lstat(named, { bigint: true });
      const metadata = fields(info);
      if (!info.isDirectory() || JSON.stringify(metadata) !== JSON.stringify(fields(visible)) || metadata.dev !== original.dev || metadata.ino !== original.ino || metadata.mode !== original.mode || index < 3 && metadata.uid !== original.uid) throw new Error("APT retained directory identity changed");
      snapshots.push({ path, fd: handle.fd, metadata });
    }
    const readAccounts = async () => {
      const file = await open("/etc/passwd", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat({ bigint: true });
        if (!info.isFile() || info.uid !== 0n || (info.mode & 0o022n) !== 0n || info.nlink !== 1n || info.size <= 0n || info.size > 1048576n) throw new Error("Unsafe local account database");
        const bytes = Buffer.alloc(Number(info.size) + 1); let used = 0;
        while (used < bytes.length) { if (remaining() <= 0) throw new Error("Account observation deadline"); const read = await file.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
        if (BigInt(used) !== info.size || JSON.stringify(fields(await file.stat({ bigint: true }))) !== JSON.stringify(fields(info)) || JSON.stringify(fields(await lstat("/etc/passwd", { bigint: true }))) !== JSON.stringify(fields(info))) throw new Error("Local account database changed");
        const rows = bytes.subarray(0, used).toString().split("\n").filter(Boolean).map((line) => line.split(":")); const apt = rows.filter((row) => row[0] === "_apt");
        const uid = Number(apt[0]?.[2]);
        if (apt.length !== 1 || apt[0]!.length !== 7 || !/^[1-9][0-9]*$/.test(apt[0]![2]!) || !Number.isSafeInteger(uid) || uid === process.getuid!() || rows.filter((row) => Number(row[2]) === uid).length !== 1) throw new Error("Local APT account identity unavailable");
        return { sha256: Bun.CryptoHasher.hash("sha256", bytes.subarray(0, used), "hex"), uid };
      } finally { await file.close(); }
    };
    const unchanged = async () => {
      if (accounts) {
        if (JSON.stringify(await readAccounts()) !== JSON.stringify(accounts)) throw new Error("Local APT account identity changed");
        await aptServicePolicy(profile).provenance(host, remaining);
      }
      for (const [index, item] of snapshots.entries()) {
        if (remaining() <= 0 || JSON.stringify(fields(await handles[index]!.stat({ bigint: true }))) !== JSON.stringify(item.metadata) || JSON.stringify(fields(await lstat(join(directory, manifest.root, item.path), { bigint: true }))) !== JSON.stringify(item.metadata)) throw new Error("Retained APT directories changed");
      }
    };
    const needsInspection = snapshots.slice(3).some((item) => item.metadata.uid !== process.getuid!());
    const accounts = needsInspection && process.platform === "linux" ? await readAccounts() : undefined;
    if (!needsInspection) {
      for (const item of snapshots.slice(3)) if ((await readdir(join(directory, manifest.root, item.path))).length) throw new Error("Retained APT auxiliary contents changed");
      return { request: null, inspectorSha256, inspect: async () => { throw new Error("No privileged inspection needed"); }, unchanged, close };
    }
    if (process.platform !== "linux") throw new Error("Native Linux inspection is unavailable");
    if (!accounts) throw new Error("Protected account identity unavailable");
    if (snapshots.slice(3).some((item) => ![0, accounts!.uid, process.getuid!()].includes(item.metadata.uid))) throw new Error("Unknown retained APT directory owner");
    await aptServicePolicy(profile).provenance(host, remaining);
    const stat = (await Bun.file(`/proc/${process.pid}/stat`).text());
    const parentStart = stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/)[19];
    if (!parentStart || !/^[0-9]+$/.test(parentStart)) throw new Error("Original parent process identity unavailable");
    const executable = await open("/proc/self/exe", constants.O_RDONLY); handles.push(executable);
    const info = await executable.stat({ bigint: true });
    if (!info.isFile() || info.size <= 0n || info.size > 268435456n) throw new Error("Bun executable identity unavailable");
    const digest = new Bun.CryptoHasher("sha256"); const buffer = Buffer.alloc(65536); let used = 0;
    while (used <= Number(info.size)) { if (remaining() <= 0) throw new Error("Bun authentication deadline"); const read = await executable.read(buffer, 0, Math.min(buffer.length, Number(info.size) + 1 - used), used); if (!read.bytesRead) break; used += read.bytesRead; digest.update(buffer.subarray(0, read.bytesRead)); }
    if (BigInt(used) !== info.size) throw new Error("Bun executable size changed");
    const request = { formatVersion: 1, accountSha256: accounts.sha256, parentPid: process.pid, parentStart, user: process.getuid!(), executableSha256: digest.digest("hex"), directories: snapshots };
    const validateObservation = (value: unknown, executionRequest: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || !executionRequest || typeof executionRequest !== "object" || Array.isArray(executionRequest)) throw new Error("Invalid privileged APT inspection proof");
      const observed = value as Record<string, unknown>; const execution = executionRequest as Record<string, unknown>;
      if (Object.keys(execution).sort().join(",") !== "accountSha256,deadlineNs,directories,executableSha256,formatVersion,parentPid,parentStart,user" || execution.formatVersion !== 1 || execution.accountSha256 !== accounts!.sha256 || execution.executableSha256 !== request.executableSha256 || execution.user !== process.getuid!() || !Number.isSafeInteger(execution.parentPid) || Number(execution.parentPid) <= 1 || typeof execution.parentStart !== "string" || !/^[0-9]+$/.test(execution.parentStart) || typeof execution.deadlineNs !== "string" || !/^[0-9]{1,20}$/.test(execution.deadlineNs) || !Array.isArray(execution.directories) || execution.directories.length !== 5) throw new Error("Prior APT inspection execution binding differs");
      const descriptors = execution.directories as { path: string; fd: number; metadata: unknown }[];
      if (descriptors.some((item) => !item || Object.keys(item).sort().join(",") !== "fd,metadata,path" || !Number.isSafeInteger(item.fd) || item.fd < 0) || new Set(descriptors.map((item) => item.fd)).size !== 5 || JSON.stringify(descriptors.map(({ path, metadata }) => ({ path, metadata }))) !== JSON.stringify(snapshots.map(({ path, metadata }) => ({ path, metadata })))) throw new Error("Prior APT inspection descriptors differ");
      if (Object.keys(observed).sort().join(",") !== "accountSha256,aptUid,directories,empty,formatVersion,requestSha256" || observed.formatVersion !== 1 || observed.empty !== true || observed.requestSha256 !== Bun.CryptoHasher.hash("sha256", JSON.stringify(execution), "hex") || observed.accountSha256 !== accounts!.sha256 || observed.aptUid !== accounts!.uid || JSON.stringify(observed.directories) !== JSON.stringify(snapshots.map(({ path, metadata }) => ({ path, metadata })))) throw new Error("Privileged APT inspection proof differs");
    };
    const verifyReceipt = async (value: Json) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Prior APT inspection proof missing");
      const record = value as Record<string, Json>; const { executionRequest, ...observed } = record;
      validateObservation(observed, executionRequest); await unchanged();
    };
    return { request: { formatVersion: 1, accountSha256: accounts.sha256, executableSha256: request.executableSha256, directories: snapshots.map(({ path, metadata }) => ({ path, metadata })) }, inspectorSha256, unchanged, close, verifyReceipt, inspect: async () => {
      await aptServicePolicy(profile).provenance(host, remaining);
      await unchanged();
      const executionRequest = { ...request, deadlineNs: String(process.hrtime.bigint() + BigInt(remaining()) * 1000000n) };
      const raw = JSON.stringify(executionRequest);
      inspectionUnconfirmed = true;
      const result = await host.run(["/usr/bin/sudo", "-n", "--", `/proc/${process.pid}/exe`, "--config=/dev/null", "--no-env-file", "--no-macros", "--no-install", "-e", aptInspectorProgram, "--", raw], remaining(), { cwd: "/", cleanEnvironment: true });
      inspectionUnconfirmed = result.status !== "completed" || result.terminationUnconfirmed === true;
      if (result.status === "completed" && result.exitCode === 1 && !result.terminationUnconfirmed && /^sudo: a password is required\s*$/.test(result.stderr)) throw new AptInspectionRequired(failure("setup", 3, { code: "HUMAN_ACTION_REQUIRED", message: "Authenticate the operating system separately, then authorize a fresh retained-evidence inspection. The previous inspection grant was consumed; installation was not repeated.", actions: [] }, { resumable: true }));
      if (result.status !== "completed" || result.exitCode !== 0 || result.terminationUnconfirmed || result.stderr !== "") {
        let stage = "unknown";
        try { const diagnostic = JSON.parse(result.stderr); if (Object.keys(diagnostic).sort().join(",") === "code,stage" && diagnostic.code === "APT_INSPECTION_REFUSED" && ["invocation", "executable", "directories", "account", "contents", "final-custody"].includes(diagnostic.stage)) stage = diagnostic.stage; } catch { /* Unknown output never supplies inspection evidence. */ }
        throw new AptInspectionRequired(failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "The read-only inspection did not establish empty, unchanged retained APT cache directories. Evidence was preserved; inspect current state before retrying.", actions: [] }, { resumable: true, inspection: { state: "incomplete", stage, termination: inspectionUnconfirmed ? "unconfirmed" : "completed" } }));
      }
      const value = JSON.parse(result.stdout);
      validateObservation(value, executionRequest);
      await unchanged(); return { ...value, executionRequest } as Json;
    } };
  } catch (error) { await close(); throw error; }
}

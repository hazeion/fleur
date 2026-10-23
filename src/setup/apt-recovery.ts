import { constants } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostIdentity, SetupHost } from "./commands.ts";
import type { AptInstallProfile } from "./native.ts";
import { validAptProfile } from "./native.ts";
import { aptHealthArgs, healthyDpkgSnapshot } from "./apt-health.ts";
import { readGrants, stateDirectory, type Grant } from "./grants.ts";
import { withSetupLock, syncStateDirectory } from "./lock.ts";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
function requireState(condition: unknown): asserts condition { if (!condition) throw new Error("APT recovery evidence is incomplete or changed"); }
function object(value: unknown): Record<string, unknown> { requireState(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, expected: string): void { requireState(Object.keys(value).sort().join(",") === expected.split(",").sort().join(",")); }
function hash(bytes: string | Uint8Array): string { return Bun.CryptoHasher.hash("sha256", bytes, "hex"); }

/** Read only bounded protected regular state, retaining inode and content custody. */
async function protectedRecord(path: string, remaining: () => number) {
  requireState(remaining() > 0);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    requireState(info.isFile() && info.nlink === 1n && info.uid === BigInt(process.getuid!()) && (info.mode & 0o7777n) === 0o600n && info.size > 0n && info.size <= 1048576n);
    const bytes = Buffer.alloc(Number(info.size) + 1); let used = 0;
    while (used < bytes.length) { requireState(remaining() > 0); const read = await file.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
    requireState(BigInt(used) === info.size);
    const value = object(JSON.parse(bytes.subarray(0, used).toString("utf8")));
    const digest = hash(bytes.subarray(0, used));
    const unchanged = async () => {
      requireState(remaining() > 0);
      const current = await lstat(path, { bigint: true });
      const held = await file.stat({ bigint: true });
      requireState(current.dev === info.dev && current.ino === info.ino && held.size === info.size && current.nlink === 1n && current.uid === info.uid && current.mode === info.mode);
      const check = Buffer.alloc(used + 1); let count = 0;
      while (count < check.length) { requireState(remaining() > 0); const read = await file.read(check, count, check.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
      requireState(count === used && hash(check.subarray(0, count)) === digest);
    };
    await unchanged();
    return { value, digest, unchanged, close: () => file.close() };
  } catch (error) { await file.close(); throw error; }
}

function historicalAuthority(value: unknown, profile: AptInstallProfile, identity: HostIdentity, checksum: string, target: string): readonly Grant[] {
  const actions = ["install", "configuration", "docker-access", "service-start", "service-enable"];
  requireState(Array.isArray(value) && value.length === actions.length);
  const seen = new Set<string>(); const seenIds = new Set<string>();
  return value.map((raw) => {
    const lease = object(raw); keys(lease, "id,action,method,target,planChecksum,machine,user,mode,revoked");
    requireState(typeof lease.id === "string" && uuid.test(lease.id) && typeof lease.action === "string" && actions.includes(lease.action) && !seen.has(lease.action) && !seenIds.has(lease.id));
    requireState(lease.method === profile.method && lease.target === target && lease.planChecksum === checksum && lease.machine === identity.machineId && lease.user === process.getuid!() && (lease.mode === "once" || lease.mode === "remembered") && typeof lease.revoked === "boolean" && (lease.mode !== "once" || lease.revoked));
    seen.add(lease.action); seenIds.add(lease.id);
    return lease as unknown as Grant;
  });
}

interface Entry { path: string; dev: string; ino: string; directory: boolean; uid: number; mode: number; auxiliary: boolean; size?: number; sha256?: string }
function manifest(value: unknown, profile: AptInstallProfile): { root: string; entries: Entry[] } {
  const record = object(value); keys(record, "root,entries");
  requireState(typeof record.root === "string" && /^apt-payloads-[A-Za-z0-9]{6,16}$/.test(record.root) && Array.isArray(record.entries) && record.entries.length <= 64);
  const entries = record.entries.map((raw) => {
    const entry = object(raw); requireState(typeof entry.directory === "boolean");
    keys(entry, entry.directory ? "path,dev,ino,directory,uid,mode,auxiliary" : "path,dev,ino,directory,uid,mode,auxiliary,size,sha256");
    requireState(typeof entry.path === "string" && (entry.path === "." || /^[A-Za-z0-9._~+%:-]+(?:\/[A-Za-z0-9._~+%:-]+)*$/.test(entry.path) && !entry.path.split("/").some((part) => part === "." || part === "..")));
    requireState([entry.dev, entry.ino].every((part) => typeof part === "string" && /^(0|[1-9][0-9]{0,19})$/.test(part) && BigInt(part) <= 18446744073709551615n));
    requireState(entry.uid === process.getuid!() && typeof entry.auxiliary === "boolean");
    requireState(entry.directory ? entry.mode === 0o700 || entry.mode === 0o755 : entry.mode === 0o600 && entry.auxiliary === false && Number.isSafeInteger(entry.size) && Number(entry.size) >= 0 && Number(entry.size) <= 268435456 && typeof entry.sha256 === "string" && sha.test(entry.sha256));
    return entry as unknown as Entry;
  });
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  requireState(byPath.size === entries.length);
  const fixedDirectories = new Map([[".", 0o700], ["archives", 0o700], ["archives/partial", 0o700], ["local-lists", 0o755], ["local-lists/auxfiles", 0o755], ["local-only.parts", 0o700]]);
  for (const [path, mode] of fixedDirectories) { const entry = byPath.get(path); requireState(entry?.directory && entry.mode === mode && entry.auxiliary === ["archives/partial", "local-lists/auxfiles"].includes(path)); }
  const fixedFiles = new Map([["archives/lock", ""], ["local-only.list", ""], ["local-only.conf", "#clear APT::Sources::With;\n"]]);
  for (const [path, bytes] of fixedFiles) { const entry = byPath.get(path); requireState(entry && !entry.directory && entry.size === Buffer.byteLength(bytes) && entry.sha256 === hash(bytes)); }
  const plan = byPath.get("apt-plan.json"); requireState(plan && !plan.directory && plan.size! > 0 && plan.size! <= 65536);
  const accepted = new Set([...fixedDirectories.keys(), ...fixedFiles.keys(), "apt-plan.json"]);
  let selected = 0;
  for (const [name, artifact] of Object.entries(profile.artifacts)) {
    const directory = byPath.get(name); if (!directory) continue;
    requireState(directory.directory && directory.mode === 0o700 && !directory.auxiliary); accepted.add(name); selected++;
    const files = entries.filter((entry) => dirname(entry.path) === name);
    requireState(files.length === 1); const source = files[0]!;
    requireState(!source.directory && source.path.endsWith(".deb") && source.size === artifact.size && source.sha256 === artifact.sha256);
    const copyPath = "archives/" + source.path.slice(name.length + 1); const copy = byPath.get(copyPath);
    requireState(copy && !copy.directory && copy.size === artifact.size && copy.sha256 === artifact.sha256);
    accepted.add(source.path); accepted.add(copyPath);
  }
  requireState(selected > 0 && accepted.size === entries.length && entries.every((entry) => accepted.has(entry.path)));
  return { root: record.root, entries };
}

/** Evidence is inspected and retained, never reconstructed into an executable or disposable stage. */
async function verifyArtifacts(directory: string, evidence: { root: string; entries: Entry[] }, remaining: () => number): Promise<void> {
  const root = join(directory, evidence.root);
  // Parents first: no path may traverse an unchecked retained directory.
  for (const entry of [...evidence.entries].sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))) {
    requireState(remaining() > 0);
    const path = join(root, entry.path);
    const info = await lstat(path, { bigint: true });
    const matches = (current: typeof info) => current.dev === BigInt(entry.dev) && current.ino === BigInt(entry.ino) && current.uid === BigInt(entry.uid) && (current.mode & 0o7777n) === BigInt(entry.mode) && !current.isSymbolicLink() && (entry.directory ? current.isDirectory() : current.isFile() && current.nlink === 1n && current.size === BigInt(entry.size!));
    requireState(matches(info));
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (entry.directory ? constants.O_DIRECTORY : 0));
    try {
      requireState(matches(await file.stat({ bigint: true })));
      if (entry.directory) {
        const children = evidence.entries.filter((child) => child.path !== "." && (dirname(child.path) === "." ? "." : dirname(child.path)) === entry.path).map((child) => child.path.split("/").at(-1)).sort();
        requireState(JSON.stringify((await readdir(path)).sort()) === JSON.stringify(children));
      } else {
        const digest = new Bun.CryptoHasher("sha256"); const buffer = Buffer.alloc(65536); let used = 0;
        while (used <= entry.size!) { requireState(remaining() > 0); const read = await file.read(buffer, 0, Math.min(buffer.length, entry.size! + 1 - used), used); if (!read.bytesRead) break; used += read.bytesRead; digest.update(buffer.subarray(0, read.bytesRead)); }
        requireState(used === entry.size && digest.digest("hex") === entry.sha256);
      }
      requireState(matches(await file.stat({ bigint: true })) && matches(await lstat(path, { bigint: true })));
    } finally { await file.close(); }
  }
}

async function publishReceipt(directory: string, name: string, bytes: string, sync: (directory: string) => Promise<void>): Promise<void> {
  const temporary = `apt-reconciliation-${crypto.randomUUID()}.tmp`;
  const file = await open(join(directory, temporary), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  // A crash leaves a private temporary file, never a truncated authoritative receipt.
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi"); const mac = process.platform === "darwin";
    const symbol = mac ? "renameatx_np" : "renameat2";
    const library = dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { [symbol]: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
    try { const from = Buffer.from(temporary + "\0"), to = Buffer.from(name + "\0"); requireState(library.symbols[symbol]!(parent.fd, ptr(from), parent.fd, ptr(to), mac ? 4 : 1) === 0); }
    finally { library.close(); }
    await sync(directory);
  } finally { await parent.close(); }
}

/** Caller receives permission only to reprobe current readiness, never to replay installation. */
export async function reconcileApt(host: SetupHost, identity: HostIdentity, profile: AptInstallProfile, remaining: () => number): Promise<void> {
  requireState(validAptProfile(profile) && identity.system === "linux" && identity.translated === false && identity.machineId && sha.test(identity.machineId) && identity.bootId && uuid.test(identity.bootId));
  const directory = stateDirectory(host); const pendingPath = join(directory, "apt-transaction-pending.json");
  // Invalid and same-boot evidence remains a read-only refusal, even when no
  // setup lock exists yet. Every eligible record is read and validated again
  // under the normal lock; this preflight never authorizes a state transition.
  const preflight = await protectedRecord(pendingPath, remaining);
  try {
    const record = preflight.value;
    keys(record, "formatVersion,operationId,action,method,machine,user,bootId,checksum,target,authority,artifacts");
    const checksum = hash(JSON.stringify(profile));
    requireState(record.formatVersion === 2 && typeof record.operationId === "string" && uuid.test(record.operationId) && record.action === "install" && record.method === profile.method && record.machine === identity.machineId && record.user === process.getuid!() && typeof record.bootId === "string" && uuid.test(record.bootId) && record.bootId !== identity.bootId && record.checksum === checksum && record.target === `Docker ${profile.distribution} ${profile.release} ${profile.architecture} profile ${checksum}`);
    manifest(record.artifacts, profile);
    historicalAuthority(record.authority, profile, identity, checksum, `Docker ${profile.distribution} ${profile.release} ${profile.architecture} profile ${checksum}`);
    await preflight.unchanged();
    await withSetupLock(directory, async () => {
      const pending = preflight;
      await pending.unchanged();
      const record = pending.value; keys(record, "formatVersion,operationId,action,method,machine,user,bootId,checksum,target,authority,artifacts");
      const checksum = hash(JSON.stringify(profile)); const target = `Docker ${profile.distribution} ${profile.release} ${profile.architecture} profile ${checksum}`;
      requireState(record.formatVersion === 2 && typeof record.operationId === "string" && uuid.test(record.operationId) && record.action === "install" && record.method === profile.method && record.machine === identity.machineId && record.user === process.getuid!() && typeof record.bootId === "string" && uuid.test(record.bootId) && record.bootId !== identity.bootId && record.checksum === checksum && record.target === target);
      const leases = historicalAuthority(record.authority, profile, identity, checksum, target);
      const grants = await readGrants(host);
      for (const lease of leases) {
        const grant = grants.find((candidate) => candidate.id === lease.id);
        requireState(grant && Object.entries(lease).every(([key, value]) => key === "revoked" ? !value || grant.revoked : grant[key as keyof Grant] === value));
      }
      const artifacts = manifest(record.artifacts, profile);
      const currentHealth = async () => {
        requireState(remaining() > 0 && await host.aptPackageLocks?.(remaining()) === "clear");
        const result = await host.run(aptHealthArgs, remaining(), { outputLimitBytes: 2097152 });
        requireState(result.status === "completed" && result.exitCode === 0 && !result.terminationUnconfirmed);
        const inventory = healthyDpkgSnapshot(result.stdout);
        requireState(inventory && Object.entries(profile.packages).every(([name, version]) => inventory.get(name)?.version === version && inventory.get(name)?.status === "installed"));
        return result.stdout;
      };
      const before = await currentHealth();
      await verifyArtifacts(directory, artifacts, remaining);
      const inspectConfig = async () => {
        requireState(remaining() > 0);
        const config = await host.run(["apt-config", "dump"], remaining());
        requireState(config.status === "completed" && config.exitCode === 0 && !config.terminationUnconfirmed && config.stdout.trim() && !config.stdout.includes(artifacts.root));
        return config.stdout;
      };
      const originalConfig = await inspectConfig();
      requireState(await currentHealth() === before);
      await pending.unchanged();
      const receiptName = `apt-reconciled-${record.operationId}.json`;
      const expected = { formatVersion: 1, operationId: record.operationId, pendingSha256: pending.digest, machine: identity.machineId, user: process.getuid!(), checksum, originalBootId: record.bootId, historicalOutcome: "unknown", artifacts: "retained" };
      let receipt;
      try { receipt = await protectedRecord(join(directory, receiptName), remaining); }
      catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
      if (receipt) {
        try { keys(receipt.value, Object.keys(expected).join(",") + ",reconciledBootId"); requireState(Object.entries(expected).every(([key, value]) => receipt.value[key] === value) && typeof receipt.value.reconciledBootId === "string" && uuid.test(receipt.value.reconciledBootId) && receipt.value.reconciledBootId !== record.bootId); await receipt.unchanged(); }
        finally { await receipt.close(); }
        await (host.syncDirectory ?? syncStateDirectory)(directory);
      } else await publishReceipt(directory, receiptName, JSON.stringify({ ...expected, reconciledBootId: identity.bootId }) + "\n", host.syncDirectory ?? syncStateDirectory);
      // Recheck all retained evidence and the live package observations after receipt publication.
      await verifyArtifacts(directory, artifacts, remaining);
      requireState(await inspectConfig() === originalConfig);
      requireState(await currentHealth() === before);
      await pending.unchanged();
      requireState(remaining() > 0);
      await unlink(pendingPath);
      await (host.syncDirectory ?? syncStateDirectory)(directory);
    }, host.syncDirectory);
  } finally { await preflight.close(); }
}

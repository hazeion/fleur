import { closeSync, constants, fstatSync, lstatSync } from "node:fs";
import { lstat, open, readFile, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { digest, privateDirectory, syncDirectory } from "../database/maintenance";
import { privateJson } from "../database/maintenance-authority";
import { dlopen, FFIType, ptr } from "bun:ffi";

const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }, clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
/** One kernel clock across launcher/supervisor; Bun's process-relative hrtime is not a cross-process deadline. */
export function monotonicNanoseconds(): bigint {
  const time = new BigInt64Array(2);
  if (libc.symbols.clock_gettime(process.platform === "darwin" ? 6 : 1, ptr(time)) !== 0) throw new Error("PREREQUISITE_UNAVAILABLE");
  return time[0]! * 1000000000n + time[1]!;
}
/** Kernel-owned lock; death releases it, stale PID records never authorize a signal. */
export async function lock(directory: string, create = true) {
  const file = await open(join(directory, "owner.lock"), constants.O_RDWR | (create ? constants.O_CREAT : 0) | constants.O_NOFOLLOW, 0o600);
  const info = await file.stat();
  if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0) { await file.close(); throw new Error("RECOVERY_REQUIRED"); }
  if (libc.symbols.flock(file.fd, 2 | 4) !== 0) { await file.close(); return null; }
  return { fd: file.fd, close: () => file.close() };
}
/** Read-only discovery never creates an ownership file or infers a PID. */
export async function ownershipHeld(bound: Binding): Promise<boolean> {
  let ownership;
  try { ownership = await lock(bound.directory, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!ownership) return true;
  await ownership.close(); return false;
}
/** The launcher transfers its locked open-file description across exec as fd 3. */
export function adoptLock(directory: string, fd: number): { close(): Promise<void> } {
  const actual = fstatSync(fd), expected = lstatSync(join(directory, "owner.lock"));
  if (!actual.isFile() || expected.isSymbolicLink() || actual.ino !== expected.ino || actual.dev !== expected.dev || actual.uid !== process.getuid?.() || actual.nlink !== 1 || (actual.mode & 0o077) !== 0 || libc.symbols.flock(fd, 2 | 4) !== 0) throw new Error("RECOVERY_REQUIRED");
  return { async close() { closeSync(fd); } };
}
export interface Binding { readonly project: string; readonly id: string; readonly directory: string }
/** A copied checkout, including all ignored files, has a different filesystem identity and never attaches old storage. */
export async function binding(project: string, create = true): Promise<Binding> {
  const root = await realpath(project), info = await lstat(root);
  const metadata: unknown = JSON.parse(await readFile(join(root, "fleur.json"), "utf8"));
  const contract = z.object({ formatVersion: z.literal(1), contractVersion: z.literal(1), fleurVersion: z.string(), compiler: z.literal("microsoft"), projectId: z.string().uuid().optional() }).parse(metadata);
  const id = digest(JSON.stringify([contract.projectId ?? "legacy-project", root, info.dev, info.ino, info.birthtimeMs]));
  const directory = join(homedir(), ".local", "state", "fleur", "development", id);
  if (create) await privateDirectory(directory);
  else {
    try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || await realpath(directory) !== directory) throw new Error("RECOVERY_REQUIRED"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { project: root, id, directory };
}
export async function save(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `next-${crypto.randomUUID()}`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
  await rename(temporary, join(directory, name)); await syncDirectory(directory);
}
const uuid = z.string().uuid();
export const stateSchema = z.strictObject({
  formatVersion: z.literal(1), binding: z.string().regex(/^[a-f0-9]{64}$/), instance: uuid,
  pid: z.number().int().positive(), start: z.string().min(1).max(256),
  token: z.string().regex(/^[a-f0-9]{64}$/), control: z.number().int().min(1).max(65535),
  state: z.enum(["starting", "ready", "maintenance", "failed", "stopped"]),
  url: z.string().nullable(), generation: z.number().int().nonnegative(),
  error: z.string().nullable(), initialization: z.unknown(), initializationSummary: z.string().max(8192).default(""), prerequisites: z.unknown().default(null),
  logs: z.array(z.strictObject({ sequence: z.number().int().positive(), code: z.string().max(64), message: z.string().max(512) })).max(1000),
  logSequence: z.number().int().nonnegative(),
});
export type State = z.infer<typeof stateSchema>;
export async function readState(bound: Binding): Promise<State | null> {
  // An atomic publisher may unlink the inode between privateJson's open and
  // ownership stat. Retry the current name, never accept an unlinked/hardlinked inode.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const value = stateSchema.parse(await privateJson(join(bound.directory, "instance.json")));
      if (value.binding !== bound.id) throw new Error("RECOVERY_REQUIRED");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (attempt === 2) throw new Error("RECOVERY_REQUIRED");
      await Bun.sleep(1);
    }
  }
  throw new Error("RECOVERY_REQUIRED");
}
/** Kernel start time, not process existence. Control authentication additionally proves the incarnation. */
export async function startIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === "linux") {
      const text = await readFile(`/proc/${pid}/stat`, "utf8"), fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      return `${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${fields[19]}`;
    }
    const { ptr } = await import("bun:ffi");
    const library = dlopen("/usr/lib/libproc.dylib", { proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } });
    try {
      const bytes = Buffer.alloc(136);
      if (library.symbols.proc_pidinfo(pid, 3, 0, ptr(bytes), bytes.length) !== bytes.length || bytes.readUInt32LE(12) !== pid) return null;
      const system = dlopen("/usr/lib/libSystem.B.dylib", { sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 } });
      try {
        const boot = Buffer.alloc(16), size = new BigUint64Array([16n]), name = Buffer.from("kern.boottime\0");
        if (system.symbols.sysctlbyname(ptr(name), ptr(boot), ptr(size), null, 0) !== 0) return null;
        return `${boot.readBigUInt64LE(0)}:${boot.readUInt32LE(8)}:${bytes.readBigUInt64LE(120)}:${bytes.readBigUInt64LE(128)}`;
      } finally { system.close(); }
    } finally { library.close(); }
  } catch { return null; }
}

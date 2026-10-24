import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export interface AptLockFileIdentity { readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly mode: bigint; readonly nlink: bigint; readonly regular: boolean }
/** Trusted filesystem boundary for host fixtures; never selected by CLI or environment. */
export interface AptLockFilesystem {
  readonly system: string;
  readonly identity: (path: string) => Promise<AptLockFileIdentity>;
  readonly locks: (deadline: number) => Promise<Uint8Array>;
}
const filesystem: AptLockFilesystem = {
  system: process.platform,
  identity: async (path) => { const info = await lstat(path, { bigint: true }); return { dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode, nlink: info.nlink, regular: info.isFile() && !info.isSymbolicLink() }; },
  locks: async (deadline) => {
    const file = await open("/proc/locks", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let used = 0; const bytes = Buffer.alloc(2097153);
    try {
      const info = await file.stat(); if (!info.isFile() || info.uid !== 0) throw new Error("Unsafe kernel lock observation");
      while (used < bytes.length) { if (performance.now() >= deadline) throw new Error("Lock observation deadline expired"); const read = await file.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
    } finally { await file.close(); }
    return bytes.subarray(0, used);
  },
};

const archiveLock = "/var/cache/apt/archives/lock";
const archiveParents = ["/", "/var", "/var/cache", "/var/cache/apt", "/var/cache/apt/archives"];
function sameIdentity(before: AptLockFileIdentity, after: AptLockFileIdentity): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.uid === after.uid && before.mode === after.mode && before.nlink === after.nlink && before.regular === after.regular;
}

/** Passive kernel observations only. This never acquires, removes or repairs a package lock. */
export async function observeAptLocks(timeoutMs: number, io: AptLockFilesystem = filesystem): Promise<"clear" | "busy" | "unknown"> {
  if (io.system !== "linux" || timeoutMs <= 0) return "unknown";
  const deadline = performance.now() + timeoutMs;
  try {
    const paths = ["/var/lib/dpkg/lock", "/var/lib/dpkg/lock-frontend", "/var/lib/apt/lists/lock", archiveLock];
    const identity = async (path: string): Promise<AptLockFileIdentity | null> => {
      try { return await io.identity(path); }
      catch (error) { if (path === archiveLock && (error as { code?: string })?.code === "ENOENT") return null; throw error; }
    };
    const snapshots = await Promise.all(paths.map(identity));
    if (snapshots.some((info) => info !== null && (!info.regular || info.uid !== 0n || info.nlink !== 1n || (info.mode & 0o022n) !== 0n))) return "unknown";
    // A minimal host using a private archive cache need never have created the
    // global archive lock. Observe its absence only under a protected, stable
    // directory chain. Never create a lock or infer absence from other errors.
    const parents = snapshots.at(-1) === null ? await Promise.all(archiveParents.map((path) => io.identity(path))) : [];
    if (parents.some((info) => info.uid !== 0n || (info.mode & 0o170000n) !== 0o040000n || (info.mode & 0o022n) !== 0n || info.nlink < 1n || info.regular)) return "unknown";
    const identities = snapshots.filter((info) => info !== null).map((info) => ({ major: ((info.dev >> 8n) & 0xfffn) | ((info.dev >> 32n) & 0xfffff000n), minor: (info.dev & 0xffn) | ((info.dev >> 12n) & 0xffffff00n), inode: info.ino }));
    const bytes = await io.locks(deadline);
    if (bytes.byteLength > 2097152) return "unknown";
    for (const line of Buffer.from(bytes).toString("utf8").split("\n").filter(Boolean)) {
      const match = /^[0-9]+: +(?:-> +)?(?:POSIX|FLOCK|OFDLCK) +(?:ADVISORY|MANDATORY) +(?:READ|WRITE) +-?[0-9]+ +([a-fA-F0-9]+):([a-fA-F0-9]+):([0-9]+) +[0-9]+ +(?:[0-9]+|EOF)$/.exec(line);
      if (!match) return "unknown";
      if (identities.some((id) => id.major === BigInt("0x" + match[1]) && id.minor === BigInt("0x" + match[2]) && id.inode === BigInt(match[3]!))) return "busy";
    }
    const after = await Promise.all(paths.map(identity));
    if (after.some((info, index) => { const before = snapshots[index]!; return info === null || before === null ? info !== before : !sameIdentity(before, info); })) return "unknown";
    if (parents.length) {
      const current = await Promise.all(archiveParents.map((path) => io.identity(path)));
      if (current.some((info, index) => !sameIdentity(parents[index]!, info))) return "unknown";
    }
    return performance.now() < deadline ? "clear" : "unknown";
  } catch { return "unknown"; }
}

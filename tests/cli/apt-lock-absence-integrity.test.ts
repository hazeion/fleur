import { expect, test } from "bun:test";
import { observeAptLocks, type AptLockFileIdentity, type AptLockFilesystem } from "../../src/setup/apt-locks.ts";

const archive = "/var/cache/apt/archives/lock";
const locks = ["/var/lib/dpkg/lock", "/var/lib/dpkg/lock-frontend", "/var/lib/apt/lists/lock", archive];
const ancestors = ["/", "/var", "/var/cache", "/var/cache/apt", "/var/cache/apt/archives"];
const error = (code: string) => Object.assign(Error("Controlled observation refusal"), { code });
const file = (ino: number): AptLockFileIdentity => ({ dev: 65025n, ino: BigInt(ino), uid: 0n, mode: 0o100600n, nlink: 1n, regular: true });
function observer(present = false): AptLockFilesystem {
  return {
    system: "linux",
    identity: async (path) => {
      if (path === archive && !present) throw error("ENOENT");
      const i = locks.indexOf(path);
      if (i >= 0) return file(5000 + i);
      const parent = ancestors.indexOf(path);
      if (parent < 0) throw Error("Unexpected path");
      return { ...file(100 + parent), mode: 0o040755n, nlink: 2n, regular: false };
    },
    locks: async () => Buffer.from("1: FLOCK ADVISORY WRITE 700 fe:01:9999 0 EOF\n"),
  };
}

test("archive absence requires ENOENT rather than permission, traversal, or arbitrary failure", async () => {
  for (const code of ["ENOTDIR", "EPERM", "ELOOP", "EIO", "ETIMEDOUT"]) {
    const base = observer();
    expect(await observeAptLocks(1000, { ...base, identity: async (path) => { if (path === archive) throw error(code); return base.identity(path); } })).toBe("unknown");
  }
});

test("every ancestor must remain an accessible protected actual directory", async () => {
  for (const parent of ancestors) {
    for (const change of [{ mode: 0o100755n, regular: true }, { mode: 0o060755n }, { mode: 0o040775n }, { mode: 0o040757n }, { nlink: 0n }]) {
      const base = observer();
      expect(await observeAptLocks(1000, { ...base, identity: async (path) => ({ ...await base.identity(path), ...(path === parent ? change : {}) }) })).toBe("unknown");
    }
    if (parent !== "/var/cache/apt/archives") {
      const base = observer();
      expect(await observeAptLocks(1000, { ...base, identity: async (path) => { if (path === parent) throw error("ENOENT"); return base.identity(path); } })).toBe("unknown");
    }
  }
});

test("all retained ancestor identity fields are rechecked after the kernel inventory", async () => {
  for (const parent of ancestors) {
    for (const change of [{ dev: 65026n }, { ino: 9000n }, { uid: 1000n }, { mode: 0o040700n }, { nlink: 3n }, { regular: true }]) {
      let kernelRead = false; const base = observer();
      expect(await observeAptLocks(1000, { ...base, locks: async (deadline) => { kernelRead = true; return base.locks(deadline); }, identity: async (path) => ({ ...await base.identity(path), ...(kernelRead && path === parent ? change : {}) }) })).toBe("unknown");
    }
  }
});

test("archive absence does not exempt any mandatory lock from held-lock and replacement checks", async () => {
  for (let i = 0; i < 3; i++) {
    const base = observer();
    expect(await observeAptLocks(1000, { ...base, locks: async () => Buffer.from(`1: POSIX ADVISORY WRITE 700 fe:01:${5000 + i} 0 EOF\n`) })).toBe("busy");
    let kernelRead = false;
    expect(await observeAptLocks(1000, { ...base, locks: async (deadline) => { kernelRead = true; return base.locks(deadline); }, identity: async (path) => ({ ...await base.identity(path), ...(kernelRead && path === locks[i] ? { ino: 9900n } : {}) }) })).toBe("unknown");
  }
});

test("an existing archive lock retains its original custody, contention, and stability requirements", async () => {
  const base = observer(true);
  expect(await observeAptLocks(1000, base)).toBe("clear");
  expect(await observeAptLocks(1000, { ...base, locks: async () => Buffer.from("1: POSIX ADVISORY WRITE 700 fe:01:5003 0 EOF\n") })).toBe("busy");
  for (const change of [{ uid: 1000n }, { nlink: 2n }, { mode: 0o100622n }, { regular: false, mode: 0o120777n }]) {
    expect(await observeAptLocks(1000, { ...base, identity: async (path) => ({ ...await base.identity(path), ...(path === archive ? change : {}) }) })).toBe("unknown");
  }
  let kernelRead = false;
  expect(await observeAptLocks(1000, { ...base, locks: async (deadline) => { kernelRead = true; return base.locks(deadline); }, identity: async (path) => { if (kernelRead && path === archive) throw error("ENOENT"); return base.identity(path); } })).toBe("unknown");
});

test("archive absence cannot turn malformed or oversized kernel evidence into clear state", async () => {
  for (const bytes of [Buffer.from("1: FLOCK ADVISORY WRITE 700 fe:01:not-an-inode 0 EOF\n"), Buffer.alloc(2097153)]) {
    expect(await observeAptLocks(1000, { ...observer(), locks: async () => bytes })).toBe("unknown");
  }
});

test("only the measured absent final archive directory may accompany an absent archive lock", async () => {
  const base = observer(); const archiveDirectory = "/var/cache/apt/archives";
  const absentDirectory: AptLockFilesystem = { ...base, identity: async (path) => { if (path === archiveDirectory) throw error("ENOENT"); return base.identity(path); } };
  expect(await observeAptLocks(1000, absentDirectory)).toBe("clear");
  for (const code of ["ENOTDIR", "EACCES", "EPERM", "ELOOP", "EIO"]) {
    expect(await observeAptLocks(1000, { ...base, identity: async (path) => { if (path === archiveDirectory) throw error(code); return base.identity(path); } })).toBe("unknown");
  }
  for (const parent of ancestors.slice(0, -1)) {
    expect(await observeAptLocks(1000, { ...absentDirectory, identity: async (path) => { if (path === parent) throw error("ENOENT"); return absentDirectory.identity(path); } })).toBe("unknown");
  }
});

test("absent final archive directory cannot appear or mask higher-ancestor replacement across kernel observation", async () => {
  for (const path of ancestors) {
    let kernelRead = false; const base = observer();
    const io: AptLockFilesystem = { ...base, locks: async (deadline) => { kernelRead = true; return base.locks(deadline); }, identity: async (current) => {
      if (current === "/var/cache/apt/archives" && (!kernelRead || path !== current)) throw error("ENOENT");
      const info = await base.identity(current);
      return { ...info, ...(kernelRead && path === current && path !== "/var/cache/apt/archives" ? { ino: 88000n } : {}) };
    } };
    expect(await observeAptLocks(1000, io)).toBe("unknown");
  }
  for (const code of ["ENOENT", "EACCES"]) {
    let kernelRead = false; const base = observer();
    expect(await observeAptLocks(1000, { ...base, locks: async (deadline) => { kernelRead = true; return base.locks(deadline); }, identity: async (path) => {
      if (kernelRead && path === "/var/cache/apt/archives") throw error(code);
      return base.identity(path);
    } })).toBe("unknown");
  }
});

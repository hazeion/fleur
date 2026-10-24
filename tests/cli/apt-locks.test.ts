import { expect, test } from "bun:test";
import { observeAptLocks, type AptLockFileIdentity, type AptLockFilesystem } from "../../src/setup/apt-locks.ts";

const paths = ["/var/lib/dpkg/lock", "/var/lib/dpkg/lock-frontend", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock"];
const parents = ["/", "/var", "/var/cache", "/var/cache/apt", "/var/cache/apt/archives"];
const absent = () => Object.assign(new Error("Absent archive cache lock"), { code: "ENOENT" });
function fixture(): AptLockFilesystem {
  return {
    system: "linux",
    identity: async (path): Promise<AptLockFileIdentity> => {
      if (path === paths[3]) throw absent();
      const index = paths.indexOf(path);
      if (index >= 0) return { dev: 65025n, ino: BigInt(5073 + index), uid: 0n, mode: 0o100600n, nlink: 1n, regular: true };
      const parent = parents.indexOf(path);
      if (parent < 0) throw Error("Unexpected lock observation path");
      return { dev: 65025n, ino: BigInt(100 + parent), uid: 0n, mode: 0o040755n, nlink: 2n, regular: false };
    },
    locks: async () => Buffer.from("1: FLOCK  ADVISORY  WRITE 700 fe:01:131665 0 EOF\n"),
  };
}

test("native Debian recovery observes clear locks when only the unused protected archive lock is absent", async () => {
  expect(await observeAptLocks(2000, fixture())).toBe("clear");
});

test("an absent archive lock does not hide a held dpkg lock or malformed kernel inventory", async () => {
  for (const [locks, expected] of [["1: POSIX ADVISORY WRITE 700 fe:01:5073 0 EOF\n", "busy"], ["unknown kernel lock format\n", "unknown"]] as const) {
    expect(await observeAptLocks(2000, { ...fixture(), locks: async () => Buffer.from(locks) })).toBe(expected);
  }
});

test("only exact archive-lock ENOENT may be observed as an absent optional lock", async () => {
  for (const path of paths.slice(0, 3)) {
    const io = fixture();
    expect(await observeAptLocks(2000, { ...io, identity: async (current) => { if (current === path) throw absent(); return io.identity(current); } })).toBe("unknown");
  }
  const io = fixture();
  expect(await observeAptLocks(2000, { ...io, identity: async (path) => { if (path === paths[3]) throw Object.assign(Error("denied"), { code: "EACCES" }); return io.identity(path); } })).toBe("unknown");
});

test("missing archive-lock observation refuses an unsafe ancestor or ancestor replacement", async () => {
  for (const path of parents) {
    for (const mutation of [{ uid: 1000n }, { mode: 0o040777n }, { mode: 0o120777n }]) {
      const io = fixture();
      expect(await observeAptLocks(2000, { ...io, identity: async (current) => ({ ...await io.identity(current), ...(current === path ? mutation : {}) }) })).toBe("unknown");
    }
    let reads = 0; const io = fixture();
    expect(await observeAptLocks(2000, { ...io, identity: async (current) => ({ ...await io.identity(current), ...(current === path && ++reads > 1 ? { ino: 999n } : {}) }) })).toBe("unknown");
  }
});

test("archive lock appearing across the kernel observation remains uncertain", async () => {
  let reads = 0; const io = fixture();
  expect(await observeAptLocks(2000, { ...io, identity: async (path) => {
    if (path === paths[3] && ++reads > 1) return { dev: 65025n, ino: 900n, uid: 0n, mode: 0o100600n, nlink: 1n, regular: true };
    return io.identity(path);
  } })).toBe("unknown");
});

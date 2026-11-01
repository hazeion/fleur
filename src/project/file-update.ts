import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmdirSync, unlinkSync, writeFileSync, ftruncateSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { releaseVersion } from "./release";

export const updatePaths = ["AGENTS.md", "CLAUDE.md", ".agents/skills/fleur-tdd/SKILL.md", "docs/fleur.md", ".fleur-guidance.json", "fleur.json", "package.json", "bun.lock", "lint/package.json", "lint/bun.lock"] as const;
export type UpdatePath = typeof updatePaths[number];
export type FileChange = { path: UpdatePath; before: string | null; after: string };
function readBounded(fd: number, limit: number): string {
  const buffer = Buffer.alloc(limit + 1);
  let bytes = 0;
  while (bytes < buffer.length) {
    const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
    if (!count) break; bytes += count;
  }
  if (bytes > limit) throw new Error("Update file exceeds bound");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes));
}
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export function readOwned(root: string, path: UpdatePath): string {
  assertParents(root, path);
  const fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error("Unsafe update file");
    const content = readBounded(fd, 1024 * 1024);
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Update file too large");
    return content;
  } finally { closeSync(fd); }
}
function assertParents(root: string, path: string) {
  let directory = dirname(join(root, path));
  for (;;) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe update directory");
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
}
function syncDirectory(path: string) { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
export const updatePending = (root: string): boolean => existsSync(join(root, ".fleur/update"));
export function readOptional(root: string, path: UpdatePath): string | null {
  try { return readOwned(root, path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { assertParents(root, path); return null; } throw error; }
}
interface Entry extends FileChange { ino: number | null; dev: number | null }
interface Journal { formatVersion: 1; sourceVersion: string; journalFile?: { ino: number; dev: number }; pid: number; entries: Entry[]; parents: { path: string; ino: number; dev: number }[] }
export function findUpdateRoot(selected: string): string {
  let root = selected;
  for (;;) {
    if (updatePending(root)) return root;
    const parent = dirname(root); if (parent === root) return selected; root = parent;
  }
}
function checkParents(root: string, journal: Journal) {
  if (journal.journalFile) {
    const stat = lstatSync(join(root, ".fleur/update/journal.json"));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.ino !== journal.journalFile.ino || stat.dev !== journal.journalFile.dev) throw new Error("Update journal replaced");
  }
  for (const parent of journal.parents) {
    assertParents(root, parent.path + "/_");
    const stat = lstatSync(join(root, parent.path));
    if (stat.ino !== parent.ino || stat.dev !== parent.dev) throw new Error("Update directory replaced");
  }
}
function replace(root: string, entry: Entry, from: string | null, to: string | null, journal: Journal) {
  checkParents(root, journal);
  if (to === null) {
    if (readOwned(root, entry.path) !== from) throw new Error("New update file changed");
    unlinkSync(join(root, entry.path)); syncDirectory(dirname(join(root, entry.path))); return;
  }
  const fd = openSync(join(root, entry.path), constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | (from === null ? constants.O_CREAT | constants.O_EXCL : 0), 0o644);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (from !== null && entry.ino !== null && (stat.ino !== entry.ino || stat.dev !== entry.dev)) || stat.size > 1024 * 1024 || readBounded(fd, 1024 * 1024) !== (from ?? "")) throw new Error("Update file changed concurrently");
    const bytes = Buffer.from(to);
    let offset = 0;
    while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error("Incomplete write"); offset += count; }
    ftruncateSync(fd, bytes.length); fsyncSync(fd);
    checkParents(root, journal);
    const pathStat = lstatSync(join(root, entry.path));
    if (pathStat.ino !== stat.ino || pathStat.dev !== stat.dev || pathStat.isSymbolicLink()) throw new Error("Update file replaced");
  } finally { closeSync(fd); }
}
function retire(root: string, journal: Journal) {
  checkParents(root, journal);
  unlinkSync(join(root, ".fleur/update/journal.json"));
  // Refuse a renamed/replaced lock before removing its directory.
  const lock = journal.parents.find(parent => parent.path === ".fleur/update")!;
  const stat = lstatSync(join(root, lock.path));
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== lock.ino || stat.dev !== lock.dev) throw new Error("Update lock replaced");
  rmdirSync(join(root, ".fleur/update")); syncDirectory(join(root, ".fleur"));
}
function restore(root: string, journal: Journal): string[] {
  const unrestored: string[] = [];
  for (const entry of [...journal.entries].reverse()) {
    try {
      checkParents(root, journal);
      const current = readOptional(root, entry.path);
      if (current === entry.before) continue;
      replace(root, entry, entry.after, entry.before, journal);
    } catch { unrestored.push(entry.path); }
  }
  if (!unrestored.length) { try { retire(root, journal); } catch { unrestored.push(".fleur/update"); } }
  return unrestored;
}
export async function applyFiles(root: string, changes: FileChange[], validate: () => Promise<void> = async () => {}, afterWrite?: (path: UpdatePath) => void, deadline = Infinity): Promise<{ ok: boolean; unrestored: string[] }> {
  const guardDeadline = () => { if (performance.now() >= deadline) throw new Error("UPDATE_TIMEOUT"); };
  guardDeadline();
  if (updatePending(root)) return { ok: false, unrestored: [".fleur/update"] };
  const directories = [...new Set([".", ".fleur", ...changes.map(change => dirname(change.path))])];
  const journal: Journal = { formatVersion: 1, sourceVersion: releaseVersion, pid: process.pid, entries: changes.map(change => { if (readOptional(root, change.path) !== change.before) throw new Error("Preview changed"); const stat = change.before === null ? null : lstatSync(join(root, change.path)); return { ...change, ino: stat?.ino ?? null, dev: stat?.dev ?? null }; }), parents: directories.map(path => { assertParents(root, path + "/_"); const stat = lstatSync(join(root, path)); return { path, ino: stat.ino, dev: stat.dev }; }) };
  // The journal is durable before the first protected file changes. A retained journal blocks all later updates.
  guardDeadline();
  mkdirSync(join(root, ".fleur/update"), { mode: 0o700 });
  const updateIdentity = lstatSync(join(root, ".fleur/update"));
  journal.parents.push({ path: ".fleur/update", ino: updateIdentity.ino, dev: updateIdentity.dev });
  try {
    checkParents(root, journal);
    const fd = openSync(join(root, ".fleur/update/journal.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { const identity = fstatSync(fd); journal.journalFile = { ino: identity.ino, dev: identity.dev }; writeFileSync(fd, JSON.stringify(journal)); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(join(root, ".fleur/update")); syncDirectory(join(root, ".fleur"));
    for (const entry of journal.entries) { guardDeadline(); replace(root, entry, entry.before, entry.after, journal); afterWrite?.(entry.path); }
    guardDeadline(); await validate(); guardDeadline();
    for (const entry of journal.entries) if (readOwned(root, entry.path) !== entry.after) throw new Error("Update validation changed files");
    retire(root, journal);
    return { ok: true, unrestored: [] };
  } catch { return { ok: false, unrestored: restore(root, journal) }; }
}
export function recoverFiles(root: string): { ok: boolean; unrestored: string[] } {
  if (!updatePending(root)) return { ok: true, unrestored: [] };
  try {
    assertParents(root, ".fleur/update/journal.json");
    const fd = openSync(join(root, ".fleur/update/journal.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let journal: Journal;
    try { if (!fstatSync(fd).isFile() || fstatSync(fd).size > 24 * 1024 * 1024) throw new Error("Invalid journal"); journal = JSON.parse(readBounded(fd, 24 * 1024 * 1024)) as Journal; } finally { closeSync(fd); }
    if (journal.formatVersion !== 1 || journal.sourceVersion !== releaseVersion || !journal.journalFile || !Number.isSafeInteger(journal.pid) || journal.pid < 1 || !Array.isArray(journal.entries) || journal.entries.length > updatePaths.length || !Array.isArray(journal.parents) || journal.parents.length > 12) throw new Error("Invalid journal");
    try { process.kill(journal.pid, 0); return { ok: false, unrestored: [".fleur/update"] }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    for (const entry of journal.entries) if (!updatePaths.includes(entry.path) || (entry.before !== null && typeof entry.before !== "string") || typeof entry.after !== "string" || Buffer.byteLength(entry.before ?? "") > 1024 * 1024 || Buffer.byteLength(entry.after) > 1024 * 1024) throw new Error("Invalid journal entry");
    const allowedParents = new Set([".", ".fleur", ".fleur/update", ...updatePaths.map(path => dirname(path))]);
    for (const parent of journal.parents) if (!allowedParents.has(parent.path)) throw new Error("Invalid journal parent");
    const unrestored = restore(root, journal);
    return { ok: unrestored.length === 0, unrestored };
  } catch { return { ok: false, unrestored: [".fleur/update"] }; }
}

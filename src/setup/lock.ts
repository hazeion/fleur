import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
export class SetupBusy extends Error {}
export async function withSetupLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const missing: string[] = [];
  let parent = resolve(directory);
  while (true) {
    try {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error("Unsafe setup parent");
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      missing.unshift(parent);
      const next = dirname(parent);
      if (next === parent) throw new Error("Missing setup parent");
      parent = next;
    }
  }
  for (const path of missing) {
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Unsafe setup directory");
  }
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) throw new Error("Unsafe setup state");
  const file = await open(join(directory, "setup.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Unsafe setup lock");
    const { dlopen, FFIType } = await import("bun:ffi");
    const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    try {
      if (library.symbols.flock(file.fd, 2 | 4) !== 0) throw new SetupBusy("Another setup operation holds the lock");
      try { return await operation(); } finally { library.symbols.flock(file.fd, 8); }
    } finally { library.close(); }
  } finally { await file.close(); }
}

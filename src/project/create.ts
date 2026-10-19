import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { failure, success } from "../cli/result.ts";
import { generatedGuidance, tddGuidance } from "./guidance.ts";
const version = "0.1.0";
const directories = ["client", "server", "shared", "assets", "tests", "migrations", "seeds", ".agents", ".agents/skills", ".agents/skills/fleur-tdd", ".fleur"];
async function stat(path: string) {
  try { return await lstat(path); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
}
export async function createProject(command: string, target: string, git: boolean, timeoutSeconds: number) {
  const deadline = performance.now() + timeoutSeconds * 1000;
  const files: Record<string, string> = {
    ".fleur/.gitignore": "*\n",
    "fleur.json": JSON.stringify({ formatVersion: 1, fleurVersion: version, contractVersion: 1, compiler: "microsoft" }, null, 2) + "\n",
    "package.json": await readFile(new URL("./template/package.json.txt", import.meta.url), "utf8"),
    "bun.lock": await readFile(new URL("./template/bun.lock.txt", import.meta.url), "utf8"),
    ".agents/skills/fleur-tdd/SKILL.md": tddGuidance,
  };
  const parents = new Map<string, { ino: number; dev: number }>();
  const collisions: string[] = [];
  let ancestor = target;
  for (;;) {
    const item = await stat(ancestor);
    if (item) {
      if (!item.isDirectory() || item.isSymbolicLink()) collisions.push(ancestor);
      else parents.set(ancestor, { ino: item.ino, dev: item.dev });
    }
    const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  for (const name of [".agents", ".agents/skills", ".agents/skills/fleur-tdd", "AGENTS.md", "CLAUDE.md"]) {
    const item = await stat(resolve(target, name));
    if (item && (item.isSymbolicLink() || (name.endsWith(".md") ? !item.isFile() : !item.isDirectory()))) collisions.push(name);
    if (item?.isDirectory() && !item.isSymbolicLink()) parents.set(resolve(target, name), { ino: item.ino, dev: item.dev });
    if (item?.isFile() && name.endsWith(".md") && (await readFile(resolve(target, name), "utf8")).includes("<!-- fleur:generated:")) collisions.push(name);
  }
  for (const name of [...directories.slice(0, 7), ".fleur", ...Object.keys(files)]) if (await stat(resolve(target, name))) collisions.push(name);
  if (collisions.length) return failure(command, 5, { code: "PROJECT_COLLISION", message: "Project files already exist; no files were changed.", actual: collisions, actions: [{ command: "fleur new <empty-directory>", description: "Choose a directory without application or protected file collisions." }] });
  const created: { path: string; ino: number; dev: number; directory: boolean; bytes?: Buffer }[] = [];
  let attemptedGit = false;
  const modified: { path: string; ino: number; dev: number; before: Buffer; after: Buffer }[] = [];
  const validateParents = async () => {
    for (const [path, identity] of parents) {
      const item = await stat(path);
      if (!item || !item.isDirectory() || item.isSymbolicLink() || item.ino !== identity.ino || item.dev !== identity.dev) throw new Error("Project directory changed concurrently");
    }
  };
  const guard = async () => {
    if (performance.now() >= deadline) throw new Error("Creation timeout");
    await validateParents();
  };
  const verifyFile = async (path: string, identity: { ino: number; dev: number }) => {
    await guard();
    const current = await stat(path);
    if (!current?.isFile() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("Project file changed concurrently");
  };
  const remember = async (path: string, directory: boolean, identity?: { ino: number; dev: number }, bytes?: Buffer) => {
    const item = identity ?? await lstat(path);
    const entry = { path, directory, ino: item.ino, dev: item.dev, bytes };
    created.push(entry);
    if (directory) parents.set(path, { ino: item.ino, dev: item.dev });
    return entry;
  };
  const ensure = async (path: string): Promise<void> => {
    const item = await stat(path);
    if (item) {
      if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("Unsafe project path");
      const previous = parents.get(path);
      if (previous && (previous.ino !== item.ino || previous.dev !== item.dev)) throw new Error("Project directory changed concurrently");
      parents.set(path, { ino: item.ino, dev: item.dev });
      await guard();
      return;
    }
    const parent = dirname(path);
    if (parent !== path) await ensure(parent);
    await guard();
    await mkdir(path);
    await remember(path, true);
    await guard();
  };
  try {
    await ensure(target);
    for (const directory of directories) await ensure(resolve(target, directory));
    for (const [name, content] of Object.entries(files)) {
      const path = resolve(target, name);
      await guard();
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try {
        const identity = await handle.stat();
        const owned = await remember(path, false, identity, Buffer.alloc(0));
        await verifyFile(path, identity);
        await handle.writeFile(content);
        owned.bytes = Buffer.from(content);
        await verifyFile(path, identity);
      } finally { await handle.close(); }
    }
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const path = resolve(target, name);
      await guard();
      const existing = await stat(path);
      const handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | (existing ? 0 : constants.O_CREAT | constants.O_EXCL), 0o644);
      try {
        const identity = await handle.stat();
        const owned = existing ? null : await remember(path, false, identity, Buffer.alloc(0));
        if (!identity.isFile()) throw new Error("Unsafe guidance path");
        await verifyFile(path, identity);
        const before = await handle.readFile();
        if (owned && before.length !== 0) throw new Error("New guidance changed concurrently");
        if (before.includes(Buffer.from("<!-- fleur:generated:"))) throw new Error("Guidance changed concurrently");
        const appended = Buffer.from((before.length && before[before.length - 1] !== 10 ? "\n" : "") + generatedGuidance);
        const after = Buffer.concat([before, appended]);
        if (existing) modified.push({ path, ino: identity.ino, dev: identity.dev, before, after });
        await verifyFile(path, identity);
        await handle.writeFile(appended);
        if (owned) owned.bytes = after;
        await verifyFile(path, identity);
      } finally { await handle.close(); }
    }
    await guard();
    let gitState = "disabled";
    if (git) {
      let cursor = target;
      let existing = false;
      for (;;) {
        if (await stat(resolve(cursor, ".git"))) { existing = true; break; }
        const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
      }
      if (existing) gitState = "existing";
      else {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) throw new Error("Creation timeout");
        attemptedGit = true;
        const child = Bun.spawn(["git", "init", "--quiet", "--template=", "--initial-branch=main", "--", target], { timeout: remaining, killSignal: "SIGKILL", stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
        const exit = await child.exited;
        if (exit !== 0) throw new Error("Git initialization failed");
        gitState = "created";
      }
    }
    await guard();
    for (const item of [...created.filter((entry) => !entry.directory).map((entry) => ({ ...entry, expected: entry.bytes })), ...modified.map((entry) => ({ ...entry, expected: entry.after }))]) {
      await verifyFile(item.path, item);
      const handle = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const identity = await handle.stat();
        if (!item.expected || identity.ino !== item.ino || identity.dev !== item.dev || identity.size !== item.expected.length) throw new Error("Generated files changed concurrently");
        const bytes = await handle.readFile();
        if (!bytes.equals(item.expected)) throw new Error("Generated files changed concurrently");
        await verifyFile(item.path, item);
      } finally { await handle.close(); }
    }
    await guard();
    return success(command, { fleurVersion: version, compiler: "microsoft", git: gitState });
  } catch {
    const incomplete: string[] = [];
    if (attemptedGit && await stat(resolve(target, ".git"))) incomplete.push(resolve(target, ".git"));
    for (const item of modified.reverse()) {
      try {
        await validateParents();
        const handle = await open(item.path, constants.O_RDWR | constants.O_NOFOLLOW);
        try {
          const current = await handle.stat();
          const bytes = await handle.readFile();
          if (current.ino !== item.ino || current.dev !== item.dev) throw new Error("Guidance changed concurrently");
          if (bytes.equals(item.before)) continue;
          if (!bytes.equals(item.after)) throw new Error("Guidance changed concurrently");
          await handle.write(item.before, 0, item.before.length, 0); await handle.truncate(item.before.length);
        } finally { await handle.close(); }
      } catch { incomplete.push(item.path); }
    }
    for (const item of created.reverse()) {
      try {
        const ancestors = [...parents].filter(([path]) => path !== item.path && item.path.startsWith(path + "/"));
        for (const [path, identity] of ancestors) { const parent = await stat(path); if (!parent || parent.isSymbolicLink() || parent.ino !== identity.ino || parent.dev !== identity.dev) throw new Error("Rollback parent changed"); }
        const current = await stat(item.path);
        if (!current) continue;
        if (current.ino !== item.ino || current.dev !== item.dev || current.isSymbolicLink()) throw new Error("Path changed concurrently");
        if (item.directory) await rmdir(item.path);
        else {
          const handle = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const identity = await handle.stat();
            const bytes = await handle.readFile();
            if (identity.ino !== item.ino || identity.dev !== item.dev || !item.bytes || !bytes.equals(item.bytes)) throw new Error("Created file changed concurrently");
            const currentPath = await stat(item.path);
            if (!currentPath || currentPath.ino !== item.ino || currentPath.dev !== item.dev || currentPath.isSymbolicLink()) throw new Error("Created path changed concurrently");
            await unlink(item.path);
          } finally { await handle.close(); }
        }
      } catch { incomplete.push(item.path); }
    }
    return failure(command, incomplete.length ? 5 : 1, { code: incomplete.length ? "RECOVERY_REQUIRED" : "PROJECT_CREATION_FAILED", message: incomplete.length ? "Creation failed and some owned changes could not be restored safely." : "Creation failed; newly created files were removed and user guidance restored.", actual: { unrestored: incomplete }, actions: incomplete.length ? [{ command: "fleur doctor", description: "Inspect the reported paths before retrying creation." }] : [] });
  }
}

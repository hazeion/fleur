import assert from "node:assert/strict";
import { readFile, readlink, lstat } from "node:fs/promises";
import { join } from "node:path";
/** Freeze source identity without recording local paths, credentials or generated runtime files. */
export async function proofSource(directory: string) {
  async function git(args: string[]) {
    const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "ignore", timeout: 10000, killSignal: "SIGKILL" });
    const output = await new Response(child.stdout).text(); assert.equal(await child.exited, 0); return output;
  }
  const files = (await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).sort();
  const hash = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    const path = join(directory, file), metadata = await lstat(path);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new Error("Source identity requires regular files or symbolic links");
    const contents = metadata.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path);
    hash.update(JSON.stringify({ file, kind: metadata.isSymbolicLink() ? "link" : "file", executable: Boolean(metadata.mode & 0o111), bytes: contents.byteLength }) + "\n");
    hash.update(contents);
  }
  return { commit: (await git(["rev-parse", "HEAD"])).trim(), dirty: (await git(["status", "--porcelain"])).length > 0, treeSha256: hash.digest("hex"), files: files.length };
}

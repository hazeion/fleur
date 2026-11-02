import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { proofSource } from "../../scripts/proof-source";

test("source identity hashes a directory symlink as a link without reading its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-source-identity-"));
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    expect(child.exitCode).toBe(0);
  };
  try {
    git("init", "--quiet", "--template=");
    await mkdir(join(root, "directory")); await writeFile(join(root, "directory/file"), "Recorded source");
    await symlink("directory", join(root, "link"));
    git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "source fixture");
    const first = await proofSource(root);
    expect(first.dirty).toBe(false); expect(first.files).toBe(2);
    await unlink(join(root, "link")); await symlink("../unavailable-directory", join(root, "link"));
    const second = await proofSource(root);
    expect(second.treeSha256).not.toBe(first.treeSha256); expect(second.dirty).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

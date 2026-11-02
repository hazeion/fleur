import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import release from "../../package.json" with { type: "json" };

test("packing excludes host Python caches while retaining runtime sources and generated-project templates", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-pack-selection-"));
  const repository = resolve(import.meta.dir, "../..");
  const marker = "fleur-test-host-cache-should-never-ship";
  try {
    await writeFile(join(root, "package.json"), JSON.stringify(release));
    for (const path of [".gitignore", "bin/fleur.ts", "src/schema.ts", "src/runtime/native/controller.py", "src/project/template/package.json.txt"]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await cp(join(repository, path), join(root, path));
    }
    await cp(join(repository, "src/.npmignore"), join(root, "src/.npmignore")).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    for (const path of ["src/runtime/native/__pycache__/controller.cpython-313.pyc", "src/project/__pycache__/helper.pyc", "src/runtime/native/optimized.pyo"]) {
      await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), marker);
    }
    const archive = join(root, "candidate.tgz");
    const packed = Bun.spawnSync([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 4000 });
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);
    const listed = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe", timeout: 4000 });
    expect(listed.exitCode).toBe(0);
    const names = listed.stdout.toString().split("\n");
    for (const path of ["bin/fleur.ts", "src/schema.ts", "src/runtime/native/controller.py", "src/project/template/package.json.txt"]) expect(names).toContain(`package/${path}`);
    expect(names.some(path => path.includes("__pycache__") || /\.py[co]$/.test(path))).toBe(false);
    expect(Buffer.from(Bun.gunzipSync(await readFile(archive))).includes(Buffer.from(marker))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

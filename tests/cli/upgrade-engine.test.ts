import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile, rename, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProject } from "../../src/project/create";
import { upgradeProject, type UpgradePath } from "../../src/project/upgrade";
import { applyFiles, readOwned, recoverFiles, updatePending } from "../../src/project/file-update";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project() { const root = await realpath(await mkdtemp(join(tmpdir(), "fleur-upgrade-proof-"))); roots.push(root); expect((await createProject("init", root, false, 60)).exitCode).toBe(0); return root; }
const path: UpgradePath = { from: "0.1.0", to: "0.1.1", compiler: "microsoft", contractVersion: 1, breaking: false, instructions: "Preserve contracts; application and database content remain unchanged.", changes: async root => [{ path: "docs/fleur.md", before: readOwned(root, "docs/fleur.md"), after: "Synthetic 0.1.1 offline reference\n" }], check: async () => {} };
test("a supported exact path previews before applying and preserves user application content", async () => {
  const root = await project();
  await writeFile(join(root, "server/user.ts"), "// Existing application edit\n");
  const pin = readOwned(root, "fleur.json"), manifest = readOwned(root, "package.json");
  const preview = await upgradeProject(root, "0.1.1", true, undefined, [path]);
  expect(preview.exitCode).toBe(0);
  expect(preview.result.data).toMatchObject({ from: "0.1.0", to: "0.1.1", databaseChanged: false, changes: expect.arrayContaining([expect.objectContaining({ path: "fleur.json", before: pin }), expect.objectContaining({ path: "package.json", before: manifest })]) });
  expect(readOwned(root, "fleur.json")).toBe(pin);
  const applied = await upgradeProject(root, "0.1.1", false, undefined, [path]);
  expect(applied.exitCode).toBe(0);
  expect(JSON.parse(readOwned(root, "fleur.json")).fleurVersion).toBe("0.1.1");
  expect(JSON.parse(readOwned(root, "package.json")).fleur.version).toBe("0.1.1");
  expect(await readFile(join(root, "server/user.ts"), "utf8")).toBe("// Existing application edit\n");
});
test("pre-1.0 breaking minor paths require explicit instructions and content-bound acceptance", async () => {
  const root = await project(); const pin = readOwned(root, "fleur.json");
  const breaking = { ...path, to: "0.2.0", breaking: true, instructions: "Review API changes before changing application code." };
  expect((await upgradeProject(root, "0.2.0", false, undefined, [breaking])).result.error?.code).toBe("UPGRADE_REVIEW_REQUIRED");
  expect(readOwned(root, "fleur.json")).toBe(pin);
  expect((await upgradeProject(root, "0.2.0", true, undefined, [{ ...breaking, instructions: "" }])).result.error?.code).toBe("UPGRADE_PATH_UNSUPPORTED");
  const preview = await upgradeProject(root, "0.2.0", true, undefined, [breaking]);
  expect((await upgradeProject(root, "0.2.0", false, (preview.result.data as { token: string }).token, [breaking])).exitCode).toBe(0);
});
test("same-major contracts cannot silently break in patches or stable minor releases", async () => {
  for (const from of ["0.1.0", "1.1.0"]) {
    const root = await project(); await writeFile(join(root, "fleur.json"), JSON.stringify({ ...JSON.parse(readOwned(root, "fleur.json")), fleurVersion: from }));
    const to = from === "0.1.0" ? "0.1.1" : "1.2.0";
    expect((await upgradeProject(root, to, true, undefined, [{ ...path, from, to, breaking: true }])).result.error?.code).toBe("UPGRADE_PATH_UNSUPPORTED");
  }
});
test("failed post-upgrade compatibility restores every previous file and pin", async () => {
  const root = await project(); const names = ["fleur.json", "package.json", "docs/fleur.md"] as const;
  const before = names.map(name => readOwned(root, name)); let checks = 0;
  const result = await upgradeProject(root, "0.1.1", false, undefined, [{ ...path, check: async () => { if (++checks === 2) throw new Error("Incompatible target"); } }]);
  expect(result.result.error?.code).toBe("UPGRADE_FAILED");
  expect(names.map(name => readOwned(root, name))).toEqual(before);
  expect(updatePending(root)).toBe(false);
});
test("concurrent edits survive rollback and retain recovery evidence", async () => {
  const root = await project(); const before = readOwned(root, "docs/fleur.md");
  const result = await applyFiles(root, [{ path: "docs/fleur.md", before, after: "Updated docs\n" }], async () => { await writeFile(join(root, "docs/fleur.md"), "Concurrent user edit\n"); throw new Error("Failure"); });
  expect(result).toEqual({ ok: false, unrestored: ["docs/fleur.md"] });
  expect(updatePending(root)).toBe(true);
  expect(await readFile(join(root, "docs/fleur.md"), "utf8")).toBe("Concurrent user edit\n");
});
test("replaced parents and linked protected files refuse without modifying the replacement", async () => {
  const root = await project(); const before = readOwned(root, "docs/fleur.md");
  const result = await applyFiles(root, [{ path: "docs/fleur.md", before, after: "Updated docs\n" }], async () => { await rename(join(root, "docs"), join(root, "saved-docs")); await mkdir(join(root, "docs")); await writeFile(join(root, "docs/fleur.md"), "Replacement\n"); throw new Error("Failure"); });
  expect(result.ok).toBe(false); expect(result.unrestored).toContain("docs/fleur.md");
  expect(await readFile(join(root, "docs/fleur.md"), "utf8")).toBe("Replacement\n");
  await rm(join(root, "docs/fleur.md")); await symlink(join(root, "saved-docs/fleur.md"), join(root, "docs/fleur.md"));
  expect(() => readOwned(root, "docs/fleur.md")).toThrow();
});
test("an interrupted owner is recoverable from durable originals without replaying an upgrade", async () => {
  const root = await project(), before = readOwned(root, "docs/fleur.md");
  const module = new URL("../../src/project/file-update.ts", import.meta.url).href;
  const script = `import {applyFiles,readOwned} from ${JSON.stringify(module)}; const root=process.argv[1]; await applyFiles(root,[{path:"docs/fleur.md",before:readOwned(root,"docs/fleur.md"),after:"Interrupted docs\\n"}],async()=>{},()=>process.exit(91));`;
  const child = Bun.spawn([process.execPath, "--eval", script, root], { stdout: "ignore", stderr: "pipe" });
  expect(await child.exited).toBe(91);
  expect(readOwned(root, "docs/fleur.md")).toBe("Interrupted docs\n");
  expect(recoverFiles(root)).toEqual({ ok: true, unrestored: [] });
  expect(readOwned(root, "docs/fleur.md")).toBe(before);
  expect(updatePending(root)).toBe(false);
});
test("a synthetic target release previews and applies through its actual CLI despite an older pinned install", async () => {
  const root = await project();
  const { cp } = await import("node:fs/promises");
  const repository = new URL("../../", import.meta.url).pathname;
  const target = join(root, "target-release"); await mkdir(target);
  for (const name of ["src", "bin"]) await cp(join(repository, name), join(target, name), { recursive: true });
  const metadata = JSON.parse(await readFile(join(repository, "package.json"), "utf8")); metadata.version = "0.1.1";
  await writeFile(join(target, "package.json"), JSON.stringify(metadata));
  await symlink(join(repository, "node_modules"), join(target, "node_modules"));
  const upgrade = join(target, "src/project/upgrade.ts");
  await writeFile(upgrade, (await readFile(upgrade, "utf8")).replace('export const supportedUpgrades: readonly UpgradePath[] = [];', `export const supportedUpgrades: readonly UpgradePath[] = [{ from: "0.1.0", to: "0.1.1", contractVersion: 1, compiler: "microsoft", breaking: false, instructions: "Synthetic target patch with unchanged application contracts.", changes: async root => { const {guidanceFiles,guidanceManifest} = await import("./guidance-state"); const files = await guidanceFiles(); return [...Object.entries(files).map(([path, after]) => ({ path: path as import("./file-update").UpdatePath, before: readOwned(root, path as import("./file-update").UpdatePath), after })), {path: ".fleur-guidance.json", before: readOwned(root,".fleur-guidance.json"), after: guidanceManifest(files)}]; }, check: async root => { if (JSON.parse(readOwned(root,"fleur.json")).compiler !== "microsoft") throw new Error("Incompatible compiler"); } }];`));
  async function invoke(...args: string[]) {
    const child = Bun.spawn([process.execPath, join(target, "bin/fleur.ts"), "upgrade", "--to", "0.1.1", ...args, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [text, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { exit, result: JSON.parse(text) };
  }
  const preview = await invoke("--preview");
  expect(preview.exit).toBe(0); expect(preview.result.data).toMatchObject({ from: "0.1.0", to: "0.1.1" });
  expect(JSON.parse(readOwned(root, "fleur.json")).fleurVersion).toBe("0.1.0");
  const result = await invoke(); expect(result.exit).toBe(0);
  expect(JSON.parse(readOwned(root, "fleur.json")).fleurVersion).toBe("0.1.1");
  expect(readOwned(root, "AGENTS.md")).toContain("# Fleur 0.1.1 project");
});
test("an exact installed Fleur package pin upgrades only with a reviewed target lock diff", async () => {
  const root = await project();
  const manifest = JSON.parse(readOwned(root, "package.json")); manifest.devDependencies.fleur = "0.1.0";
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  const graphPath = { ...path, changes: async (root: string) => [...await path.changes(root, new AbortController().signal), { path: "bun.lock" as const, before: readOwned(root, "bun.lock"), after: "Synthetic reviewed target frozen graph\n" }] };
  const result = await upgradeProject(root, "0.1.1", false, undefined, [graphPath]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readOwned(root, "package.json")).devDependencies.fleur).toBe("0.1.1");
  expect(readOwned(root, "bun.lock")).toBe("Synthetic reviewed target frozen graph\n");
});
test("incompatible contracts, compilers and undeclared package transitions refuse before files change", async () => {
  for (const mutation of [{ contractVersion: 2 }, { compiler: "rust-experimental" }]) {
    const root = await project();
    await writeFile(join(root, "fleur.json"), JSON.stringify({ ...JSON.parse(readOwned(root, "fleur.json")), ...mutation }));
    const before = readOwned(root, "fleur.json");
    expect((await upgradeProject(root, "0.1.1", false, undefined, [path])).result.error?.code).toBe("VERSION_MISMATCH");
    expect(readOwned(root, "fleur.json")).toBe(before);
    expect(updatePending(root)).toBe(false);
  }
  const root = await project();
  const manifest = JSON.parse(readOwned(root, "package.json")); manifest.dependencies.fleur = "0.1.0";
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  const before = readOwned(root, "package.json");
  expect((await upgradeProject(root, "0.1.1", false, undefined, [path])).result.error?.code).toBe("UPGRADE_INCOMPATIBLE");
  expect(readOwned(root, "package.json")).toBe(before);
  expect(updatePending(root)).toBe(false);
});

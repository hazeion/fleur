import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject } from "../../src/project/create";
import type { CliOutcome } from "../../src/cli/result";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleur-guidance-proof-"))); roots.push(root);
  expect((await createProject("init", root, false, 60)).exitCode).toBe(0);
  return root;
}
async function invoke(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, new URL("../../bin/fleur.ts", import.meta.url).pathname, ...args, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: "" } });
  const [stdout, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, result: JSON.parse(stdout) } as CliOutcome;
}
test("catalog-derived offline docs and schemas share the shipped operations", async () => {
  const root = await project();
  const result = await invoke(root, "docs", "catalog");
  expect(result.exitCode).toBe(0);
  expect(result.result.data).toMatchObject({ catalogVersion: 1, fleurVersion: "0.1.0", commands: expect.arrayContaining([expect.objectContaining({ name: "docs refresh" }), expect.objectContaining({ name: "upgrade" })]) });
  expect(await readFile(join(root, "docs/fleur.md"), "utf8")).toContain("upgrade --to <exact-version>");
});
test("refresh preserves user instructions and pin/packages; edited content requires a content-bound preview choice", async () => {
  const root = await project();
  const files = ["fleur.json", "package.json", "bun.lock", "lint/bun.lock"];
  const before = await Promise.all(files.map(name => readFile(join(root, name), "utf8")));
  const instructions = await readFile(join(root, "AGENTS.md"), "utf8");
  await writeFile(join(root, "AGENTS.md"), "User prefix\n" + instructions.replace("# Fleur 0.1.0 project", "# Edited generated title") + "User suffix\n");
  const blocked = await invoke(root, "docs", "refresh");
  expect(blocked.result.error?.code).toBe("GUIDANCE_CONFLICT");
  const preview = await invoke(root, "docs", "refresh", "--preview");
  expect(preview.exitCode).toBe(0);
  const data = preview.result.data as { token: string; changes: { path: string; before: string; after: string }[] };
  expect(data.changes.find(change => change.path === "AGENTS.md")?.before).toContain("Edited generated title");
  expect((await invoke(root, "docs", "refresh", "--replace", data.token)).exitCode).toBe(0);
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("User prefix\n" + instructions + "User suffix\n");
  expect(await Promise.all(files.map(name => readFile(join(root, name), "utf8")))).toEqual(before);
});
test("a preview cannot authorize later edits; doctor diagnoses mismatch and verify refuses before tools", async () => {
  const root = await project();
  const path = join(root, ".agents/skills/fleur-tdd/SKILL.md");
  await writeFile(path, "Edited skill\n");
  const preview = await invoke(root, "docs", "refresh", "--preview");
  const token = (preview.result.data as { token: string }).token;
  await writeFile(path, "Later edit\n");
  expect((await invoke(root, "docs", "refresh", "--replace", token)).result.error?.code).toBe("PREVIEW_CHANGED");
  expect((await invoke(root, "doctor")).result.error?.code).toBe("GUIDANCE_MISMATCH");
  expect((await invoke(root, "verify")).result.error?.code).toBe("GUIDANCE_MISMATCH");
  expect((await invoke(root, "docs", "catalog")).exitCode).toBe(0);
  expect(await readFile(path, "utf8")).toBe("Later edit\n");
});
test("unsupported exact upgrades refuse without touching project content or accepting ranges", async () => {
  const root = await project();
  const original = await readFile(join(root, "fleur.json"), "utf8");
  expect((await invoke(root, "upgrade", "--to", "latest")).exitCode).toBe(2);
  expect((await invoke(root, "upgrade", "--to", "0.2.0", "--preview")).result.error?.code).toBe("UPGRADE_PATH_UNSUPPORTED");
  expect(await readFile(join(root, "fleur.json"), "utf8")).toBe(original);
});
test("legacy projects without checksums can preview and explicitly adopt current guidance", async () => {
  const root = await project();
  await rm(join(root, ".fleur-guidance.json"));
  await writeFile(join(root, "docs/fleur.md"), "Legacy generated documentation\n");
  const preview = await invoke(root, "docs", "refresh", "--preview");
  expect(preview.exitCode).toBe(0);
  const token = (preview.result.data as { token: string }).token;
  expect((await invoke(root, "docs", "refresh")).result.error?.code).toBe("GUIDANCE_CONFLICT");
  expect((await invoke(root, "docs", "refresh", "--replace", token)).exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(root, ".fleur-guidance.json"), "utf8"))).toMatchObject({ formatVersion: 1, fleurVersion: "0.1.0" });
});
test("an expired refresh deadline refuses before changing generated content", async () => {
  const root = await project();
  const original = await readFile(join(root, "AGENTS.md"));
  const result = await invoke(root, "docs", "refresh", "--timeout", "0.000001");
  expect(result.result.error?.code).toBe("UPDATE_TIMEOUT");
  expect(await readFile(join(root, "AGENTS.md"))).toEqual(original);
});
test("unchanged stale generated content refreshes directly while user text and packages remain intact", async () => {
  const root = await project();
  const { digest } = await import("../../src/project/file-update");
  const baseline = JSON.parse(await readFile(join(root, ".fleur-guidance.json"), "utf8"));
  const previous = "Earlier generated offline guidance\n";
  await writeFile(join(root, "docs/fleur.md"), previous); baseline.hashes["docs/fleur.md"] = digest(previous);
  await writeFile(join(root, ".fleur-guidance.json"), JSON.stringify(baseline));
  const instructions = await readFile(join(root, "AGENTS.md"), "utf8");
  await writeFile(join(root, "AGENTS.md"), "User content\n" + instructions + "User suffix\n");
  const packages = await readFile(join(root, "package.json"));
  expect((await invoke(root, "docs", "refresh")).exitCode).toBe(0);
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("User content\n" + instructions + "User suffix\n");
  expect(await readFile(join(root, "package.json"))).toEqual(packages);
  const docs = await readFile(join(root, "docs/fleur.md"), "utf8");
  expect(docs).toContain("fleur verify");
  expect(docs).not.toContain("combined verification commands remain unavailable");
});
test("target-release upgrade still requires an authoritative exact project pin", async () => {
  const root = await project();
  await writeFile(join(root, "fleur.json"), "damaged metadata\n");
  const result = await invoke(root, "upgrade", "--to", "0.1.0", "--preview");
  expect(result.exitCode).toBe(4);
  expect(result.result.error?.code).toBe("VERSION_MISMATCH");
  expect(await readFile(join(root, "fleur.json"), "utf8")).toBe("damaged metadata\n");
});

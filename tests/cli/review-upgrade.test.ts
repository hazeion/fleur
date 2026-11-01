import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject } from "../../src/project/create";
import { applyFiles, readOwned } from "../../src/project/file-update";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project() { const root = await realpath(await mkdtemp(join(tmpdir(), "fleur-review-upgrade-"))); roots.push(root); expect((await createProject("init", root, false, 60)).exitCode).toBe(0); return root; }

test("review: documented CLI recovery works after interruption changed the authoritative pin", async () => {
  const root = await project();
  const before = readOwned(root, "fleur.json");
  const module = new URL("../../src/project/file-update.ts", import.meta.url).href;
  const script = `import {applyFiles,readOwned} from ${JSON.stringify(module)}; const root=process.argv[1],before=readOwned(root,"fleur.json"); await applyFiles(root,[{path:"fleur.json",before,after:JSON.stringify({...JSON.parse(before),fleurVersion:"0.1.1"})}],async()=>{},()=>process.exit(91));`;
  const writer = Bun.spawn([process.execPath, "--eval", script, root], { stdout: "ignore", stderr: "ignore" });
  expect(await writer.exited).toBe(91);
  const recovery = Bun.spawn([process.execPath, new URL("../../bin/fleur.ts", import.meta.url).pathname, "docs", "refresh", "--recover", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [output, , exit] = await Promise.all([new Response(recovery.stdout).text(), new Response(recovery.stderr).text(), recovery.exited]);
  expect(JSON.parse(output).error).toBeNull();
  expect(exit).toBe(0);
  expect(readOwned(root, "fleur.json")).toBe(before);
});

test("review: a replaced update directory cannot delete unrelated journal content", async () => {
  const root = await project();
  const outside = join(root, "unrelated"); await mkdir(outside);
  await writeFile(join(outside, "journal.json"), "Unrelated user content\n");
  await applyFiles(root, [{ path: "docs/fleur.md", before: readOwned(root, "docs/fleur.md"), after: "Updated docs\n" }], async () => {
    await rename(join(root, ".fleur/update"), join(root, ".fleur/update.saved"));
    await symlink(outside, join(root, ".fleur/update"));
  }).catch(() => undefined);
  expect(await readFile(join(outside, "journal.json"), "utf8").catch(() => "MISSING")).toBe("Unrelated user content\n");
});

test("review: refresh never re-encodes invalid UTF-8 bytes in user instruction content", async () => {
  const root = await project();
  const generated = readOwned(root, "AGENTS.md");
  const original = Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from(generated.replace("# Fleur 0.1.0 project", "# Edited generated section"))]);
  await writeFile(join(root, "AGENTS.md"), original);
  const command = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, new URL("../../bin/fleur.ts", import.meta.url).pathname, "docs", "refresh", ...args, "--json"], { cwd: root, stdout: "pipe", stderr: "ignore" });
    const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { output: JSON.parse(output), exit };
  };
  const preview = await command("--preview");
  if (preview.exit === 0) await command("--replace", preview.output.data.token);
  expect(await readFile(join(root, "AGENTS.md"))).toEqual(original);
});

test("review: refresh preserves a valid UTF-8 BOM in user instruction content", async () => {
  const root = await project();
  const generated = readOwned(root, "AGENTS.md");
  const prefix = Buffer.from([0xef, 0xbb, 0xbf]);
  await writeFile(join(root, "AGENTS.md"), Buffer.concat([prefix, Buffer.from(generated.replace("# Fleur 0.1.0 project", "# Edited generated section"))]));
  const command = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, new URL("../../bin/fleur.ts", import.meta.url).pathname, "docs", "refresh", ...args, "--json"], { cwd: root, stdout: "pipe", stderr: "ignore" });
    const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { output: JSON.parse(output), exit };
  };
  const preview = await command("--preview");
  expect(preview.exit).toBe(0);
  expect((await command("--replace", preview.output.data.token)).exit).toBe(0);
  expect(await readFile(join(root, "AGENTS.md"))).toEqual(Buffer.concat([prefix, Buffer.from(generated)]));
});

test("review: an expired refresh deadline refuses before replacing edited guidance", async () => {
  const root = await project();
  const original = readOwned(root, "docs/fleur.md") + "Edited generated documentation\n";
  await writeFile(join(root, "docs/fleur.md"), original);
  const command = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, new URL("../../bin/fleur.ts", import.meta.url).pathname, "docs", "refresh", ...args, "--json"], { cwd: root, stdout: "pipe", stderr: "ignore" });
    const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { output: JSON.parse(output), exit };
  };
  const preview = await command("--preview");
  expect(preview.exit).toBe(0);
  const result = await command("--replace", preview.output.data.token, "--timeout", "0.000001");
  expect(result.exit).not.toBe(0);
  expect(readOwned(root, "docs/fleur.md")).toBe(original);
});

test("review: explicit upgrades are evaluated by the requested target release", async () => {
  const root = await project();
  await writeFile(join(root, "fleur.json"), JSON.stringify({ ...JSON.parse(readOwned(root, "fleur.json")), fleurVersion: "0.0.9" }));
  await writeFile(join(root, "package.json"), JSON.stringify({ ...JSON.parse(readOwned(root, "package.json")), fleur: { version: "0.0.9" } }));
  const old = join(root, "node_modules/fleur"); await mkdir(join(old, "bin"), { recursive: true });
  await writeFile(join(old, "package.json"), JSON.stringify({ name: "fleur", version: "0.0.9", bin: "bin/fleur.ts" }));
  await writeFile(join(old, "bin/fleur.ts"), 'process.stdout.write(JSON.stringify({error:{code:"OLD_PIN_EXECUTED"}})+"\\n");process.exit(90);');
  const child = Bun.spawn([process.execPath, new URL("../../bin/fleur.ts", import.meta.url).pathname, "upgrade", "--to", "0.1.0", "--preview", "--json"], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exit).toBe(4);
  expect(JSON.parse(output).error.code).toBe("UPGRADE_PATH_UNSUPPORTED");
  expect(JSON.parse(readOwned(root, "fleur.json")).fleurVersion).toBe("0.0.9");
});

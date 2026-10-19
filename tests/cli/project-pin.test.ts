import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let scratch: string;
let executable: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fleur-pin-"));
  const archive = join(scratch, "release.tgz");
  const pack = Bun.spawn([process.execPath, "pm", "pack", "--filename", archive], { cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe" });
  if (await pack.exited !== 0) throw new Error(await new Response(pack.stderr).text());
  const extract = Bun.spawn(["/usr/bin/tar", "-xzf", archive, "-C", scratch], { stdout: "pipe", stderr: "pipe" });
  if (await extract.exited !== 0) throw new Error(await new Response(extract.stderr).text());
  executable = join(scratch, "package/bin/fleur.ts");
});
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });
async function invoke(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, executable, "--json", ...args], { cwd, env: { PATH: "", HOME: scratch }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 3000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exit, stderr, result: JSON.parse(stdout) };
  } finally { clearTimeout(timer); }
}
test("configured projects with missing, malformed or nonexact Fleur pins stop before creation writes", async () => {
  const configs = [{}, { fleurVersion: "^0.1.0" }, { fleurVersion: "latest" }, { fleurVersion: 1 }, "invalid JSON"];
  for (const [index, config] of configs.entries()) {
    const project = join(scratch, `invalid-${index}`);
    await mkdir(project);
    await writeFile(join(project, "fleur.json"), typeof config === "string" ? config : JSON.stringify(config));
    const before = await readdir(project);
    const response = await invoke(project, "new", "child", "--no-git");
    expect(response.exit).toBe(4);
    expect(response.result).toMatchObject({ command: "new", ok: false, data: null, error: { code: "VERSION_MISMATCH", expected: "exact Fleur version", actual: "invalid or missing pin" } });
    expect(response.result.error.actions.length).toBeGreaterThan(0);
    expect(await readdir(project)).toEqual(before);
  }
});
test("a different exact project pin with no matching local installation stops without fetching or writes", async () => {
  const project = join(scratch, "older-missing");
  await mkdir(project);
  await writeFile(join(project, "fleur.json"), JSON.stringify({ fleurVersion: "0.0.9" }));
  const response = await invoke(project, "new", "child", "--no-git");
  expect(response.exit).toBe(4);
  expect(response.result.error).toMatchObject({ code: "VERSION_MISMATCH", expected: "0.0.9", actual: "0.1.0" });
  expect(await readdir(project)).toEqual(["fleur.json"]);
});
test("newer temporary launcher executes only the installed exact project-local release through Bun", async () => {
  const project = join(scratch, "older-installed");
  const local = join(project, "node_modules/fleur");
  await mkdir(join(local, "bin"), { recursive: true });
  await writeFile(join(project, "fleur.json"), JSON.stringify({ fleurVersion: "0.0.9" }));
  await writeFile(join(local, "package.json"), JSON.stringify({ name: "fleur", version: "0.0.9", bin: { fleur: "./bin/fleur.ts" } }));
  await writeFile(join(local, "bin/fleur.ts"), 'process.stdout.write(JSON.stringify({formatVersion:1,command:"new",ok:true,data:{version:"0.0.9",runtime:typeof Bun,args:process.argv.slice(2)},error:null,truncated:false})+"\\n");\n');
  const response = await invoke(project, "new", "child", "--no-git");
  expect(response.exit).toBe(0);
  expect(response.stderr).toBe("");
  expect(response.result.data).toEqual({ version: "0.0.9", runtime: "object", args: ["--json", "new", "child", "--no-git"] });
  expect(await Bun.file(join(project, "child/fleur.json")).exists()).toBe(false);
});
test("help remains available for a broken project pin without running project operations", async () => {
  const project = join(scratch, "diagnostic");
  await mkdir(project);
  await writeFile(join(project, "fleur.json"), "not JSON");
  const response = await invoke(project, "--help");
  expect(response.exit).toBe(0);
  expect(response.result).toMatchObject({ command: "help", ok: true });
  expect(await readdir(project)).toEqual(["fleur.json"]);
});
test("explicit nested project selection honors its ancestor pin and refuses an incompatible installed package", async () => {
  const project = join(scratch, "selected-project");
  await mkdir(join(project, "nested"), { recursive: true });
  await mkdir(join(project, "node_modules/fleur"), { recursive: true });
  await writeFile(join(project, "fleur.json"), JSON.stringify({ fleurVersion: "0.0.8" }));
  await writeFile(join(project, "node_modules/fleur/package.json"), JSON.stringify({ name: "fleur", version: "0.0.9", bin: "evil.ts" }));
  await writeFile(join(project, "node_modules/fleur/evil.ts"), 'throw new Error("wrong-package-executed");');
  const response = await invoke(scratch, "--project", join(project, "nested"), "new", "child", "--no-git");
  expect(response.exit).toBe(4);
  expect(response.stderr).toBe("");
  expect(response.result.error).toMatchObject({ code: "VERSION_MISMATCH", expected: "0.0.8" });
  expect(await readdir(join(project, "nested"))).toEqual([]);
});
test("an exact installed package cannot delegate to a bin outside its package", async () => {
  const project = join(scratch, "escaped-bin");
  const local = join(project, "node_modules/fleur");
  await mkdir(local, { recursive: true });
  await writeFile(join(project, "fleur.json"), JSON.stringify({ fleurVersion: "0.0.9" }));
  await writeFile(join(local, "package.json"), JSON.stringify({ name: "fleur", version: "0.0.9", bin: "../../escape.ts" }));
  await writeFile(join(project, "escape.ts"), 'throw new Error("escaped-bin-executed");');
  const response = await invoke(project, "new", "child", "--no-git");
  expect(response.exit).toBe(4);
  expect(response.stderr).toBe("");
  expect(response.result.error.code).toBe("VERSION_MISMATCH");
});
test("current release rejects incompatible or incomplete project contracts before writes", async () => {
  const valid = { formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" };
  const configs = [{ ...valid, formatVersion: 999 }, { ...valid, contractVersion: 999 }, { ...valid, compiler: "rust-experimental" }, { fleurVersion: "0.1.0" }];
  for (const [index, config] of configs.entries()) {
    const project = join(scratch, `incompatible-${index}`);
    await mkdir(project);
    await writeFile(join(project, "fleur.json"), JSON.stringify(config));
    const response = await invoke(project, "new", "child", "--no-git");
    expect(response.exit).toBe(4);
    expect(response.result.error.code).toBe("VERSION_MISMATCH");
    expect(response.result.error.actions.length).toBeGreaterThan(0);
    expect(await readdir(project)).toEqual(["fleur.json"]);
    expect((await invoke(project, "--help")).exit).toBe(0);
  }
});

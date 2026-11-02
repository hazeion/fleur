import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let root: string;
const repository = resolve(import.meta.dir, "../.."), executable = join(repository, "bin/fleur.ts");
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "fleur-tool-process-")));
  const created = Bun.spawn([process.execPath, executable, "new", root, "--no-git", "--json"], { stdout: "pipe", stderr: "pipe" });
  expect(await created.exited, await new Response(created.stdout).text()).toBe(0);
  await symlink(join(repository, "node_modules"), join(root, "node_modules"));
  await symlink(join(repository, "lint/node_modules"), join(root, "lint/node_modules"));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
function cli(...args: string[]) { return Bun.spawn([process.execPath, executable, ...args, "--project", root, "--json"], { stdout: "pipe", stderr: "pipe" }); }
test("path filter selects Bun underscore test filenames, including a failing file", async () => {
  await writeFile(join(root, "tests/path_test.ts"), 'import {test,expect} from "bun:test"; test("selected failure",()=>expect(false).toBe(true));');
  const child = cli("test", "--filter", "path_test.ts");
  const result = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(1); expect(result.data.failed).toBe("tests");
  await writeFile(join(root, "tests/path_test.ts"), 'import {test,expect} from "bun:test"; test("selected success",()=>expect(4).toBeGreaterThan(3));');
  const passing = cli("test", "--filter", "path_test.ts");
  expect(await passing.exited, await new Response(passing.stdout).text()).toBe(0);
});
test("an expired tool deadline reports unavailable category rather than a test failure", async () => {
  await writeFile(join(root, "tests/deadline.test.ts"), 'import {test} from "bun:test"; test("slow",async()=>{await Bun.sleep(60000)});');
  const child = cli("test", "--filter", "deadline.test.ts", "--timeout", "0.5");
  const result = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(4); expect(result.error.code).toBe("VERIFY_TIMEOUT");
});
test("terminating the launcher retires its running tool child with signal-derived exit", async () => {
  const marker = join(root, "started");
  await writeFile(join(root, "tests/signal.test.ts"), 'import {test} from "bun:test"; test("signal",async()=>{await Bun.write("started",String(process.pid)); await Bun.sleep(60000)});');
  const child = cli("test", "--filter", "signal.test.ts");
  let pid: number | undefined;
  try {
    const deadline = performance.now() + 5000;
    while (!pid && performance.now() < deadline) { pid = await readFile(marker, "utf8").then(Number, () => undefined); if (!pid) await Bun.sleep(20); }
    expect(pid).toBeDefined(); child.kill("SIGTERM"); await child.exited;
    expect(child.signalCode === "SIGTERM" || child.exitCode === 143).toBe(true);
    let alive = false; try { process.kill(pid!, 0); alive = true; } catch { /* A retired PID is expected. */ }
    expect(alive).toBe(false);
  } finally { child.kill("SIGKILL"); await child.exited; if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already retired. */ } } }
});
test("full lint refuses edited engine profiles before evaluating user configuration", async () => {
  const path = join(root, "lint/eslint.config.mjs"), original = await readFile(path, "utf8");
  try {
    await writeFile(path, 'await Bun.write("configuration-executed", "unexpected"); export default [];');
    const child = cli("lint");
    const result = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(4); expect(result.error.code).toBe("VERSION_MISMATCH");
    expect(await Bun.file(join(root, "configuration-executed")).exists()).toBe(false);
  } finally { await writeFile(path, original); }
});
test("types cannot silently disable strict checking or omit the application tree", async () => {
  const path = join(root, "tsconfig.json"), original = await readFile(path, "utf8");
  try {
    const config = JSON.parse(original); config.compilerOptions.strict = false;
    await writeFile(path, JSON.stringify(config));
    const child = cli("types");
    const result = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(4); expect(result.error.code).toBe("VERSION_MISMATCH");
  } finally { await writeFile(path, original); }
});
test("force-killing the launcher closes ownership and retires the active tool", async () => {
  const marker = join(root, "force-started");
  await writeFile(join(root, "tests/force.test.ts"), 'import {test} from "bun:test"; test("force",async()=>{await Bun.write("force-started",String(process.pid)); await Bun.sleep(60000)});');
  const child = cli("test", "--filter", "force.test.ts");
  let pid: number | undefined;
  try {
    const ready = performance.now() + 5000;
    while (!pid && performance.now() < ready) { pid = await readFile(marker, "utf8").then(Number, () => undefined); if (!pid) await Bun.sleep(20); }
    expect(pid).toBeDefined(); child.kill("SIGKILL"); await child.exited;
    expect(child.signalCode === "SIGKILL" || child.exitCode === 137).toBe(true);
    let alive = true;
    const retired = performance.now() + 1000;
    while (alive && performance.now() < retired) { try { process.kill(pid!, 0); } catch { alive = false; } if (alive) await Bun.sleep(20); }
    expect(alive).toBe(false);
  } finally { child.kill("SIGKILL"); await child.exited; if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already retired. */ } } }
});
test("an uninstalled pinned compiler is environment failure without hidden installation", async () => {
  const { rename } = await import("node:fs/promises");
  const current = join(root, "node_modules"), moved = join(root, "saved-node-modules");
  await rename(current, moved);
  try {
    const child = cli("types");
    const result = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(4); expect(result.error.code).toBe("VERSION_MISMATCH");
    expect(await Bun.file(join(root, "node_modules/typescript/package.json")).exists()).toBe(false);
  } finally { await rename(moved, current); }
});

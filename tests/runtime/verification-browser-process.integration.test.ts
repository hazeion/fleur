import { expect, test } from "bun:test";
import { mkdtemp, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const repository = resolve(import.meta.dir, "../.."), executable = join(repository, "bin/fleur.ts");
for (const signal of ["SIGTERM", "SIGKILL"] as const) test(`verification ${signal} retires its selected browser tool and real Chromium`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleur-verification-browser-")));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let owned: { tool: number; browser: number } | undefined;
  try {
    const created = Bun.spawn([process.execPath, executable, "new", root, "--no-git", "--json"], { stdout: "pipe", stderr: "pipe" });
    expect(await created.exited, await new Response(created.stdout).text()).toBe(0);
    await symlink(join(repository, "node_modules"), join(root, "node_modules"));
    await writeFile(join(root, "tests/browser-owner.test.ts"), 'import {test} from "bun:test"; import {chromium} from "@playwright/test"; test("owned browser",async()=>{ const browser=await chromium.launchServer({headless:true,host:"127.0.0.1",timeout:10000}); await Bun.write("owner.json",JSON.stringify({tool:process.pid,browser:browser.process().pid})); await Bun.sleep(60000); },60000);');
    child = Bun.spawn([process.execPath, executable, "test", "--filter", "browser-owner.test.ts", "--timeout", "30", "--project", root, "--json"], { stdout: "pipe", stderr: "pipe" });
    const readiness = performance.now() + 15000;
    while (!owned && performance.now() < readiness) {
      owned = await readFile(join(root, "owner.json"), "utf8").then(value => JSON.parse(value), () => undefined);
      if (!owned) await Bun.sleep(20);
    }
    expect(owned).toBeDefined();
    for (const pid of [owned!.tool, owned!.browser]) expect(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid).toBe(true);
    child.kill(signal); await child.exited;
    expect(child.signalCode === signal || child.exitCode === (signal === "SIGTERM" ? 143 : 137)).toBe(true);
    const end = performance.now() + 2000;
    let alive: number[] = [];
    do {
      alive = [owned!.tool, owned!.browser].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
      if (alive.length) await Bun.sleep(20);
    } while (alive.length && performance.now() < end);
    expect(alive).toEqual([]);
  } finally {
    if (child) { child.kill("SIGKILL"); await child.exited; }
    if (owned) for (const pid of [owned.tool, owned.browser]) if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) try { process.kill(-pid, "SIGKILL"); } catch {}
    await rm(root, { recursive: true, force: true });
  }
}, 25000);

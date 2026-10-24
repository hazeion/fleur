import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("Debian recovery rejects altered packages, boot ledgers and configuration", async () => {
  const child = Bun.spawn(["python3", "-I", "-m", "unittest", "discover", "-s", "scripts", "-p", "test_debian_recovery*.py"], {
    cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe", timeout: 15000,
  });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, error, code }).toMatchObject({ out: "", code: 0 });
  expect(error).toMatch(/Ran [1-9][0-9]+ tests/);
  expect(error).toContain("OK");
});

test("Debian recovery refuses a local host before artifact interpretation", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/verify-debian-recovery.ts"), "--run"], {
    env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(error).toBe("");
  expect(code).toBe(4);
  expect(JSON.parse(out)).toMatchObject({ scope: "debian-interrupted-full-system-guest", ok: false, executed: false, error: { code: "OWNED_HOST_REQUIRED" } });
});

import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("recorded helper selector and handoff preserve original owned scope", async () => {
  const python = Bun.which("python3");
  if (!python) throw new Error("Existing Python required for artifact protocol fixtures");
  const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/guest-recorded-binding.py"), resolve(import.meta.dir, "../../scripts/fresh-linux-guest.py")], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stdout + stderr).toBe(0);
  expect(stderr).toContain("OK");
}, 15000);

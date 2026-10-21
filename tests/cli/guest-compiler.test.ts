import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("guest compiler prerequisite obeys authenticated-file and offline-package contracts", async () => {
  const python = Bun.which("python3");
  if (!python) throw new Error("Existing Python is required for compiler custody verification");
  const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/guest-compiler-contract.py"), resolve(import.meta.dir, "../../scripts/prepare-guest-compiler.py")], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stdout + stderr).toBe(0);
  expect(stderr).toContain("Ran 9 tests");
  expect(stderr).toContain("OK");
});

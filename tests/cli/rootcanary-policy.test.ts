import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the actual Debian canary root policy preserves custody, detached rules and service execution boundaries", async () => {
  const child = Bun.spawn(["python3", "-B", "-I", resolve(import.meta.dir, "fixtures/rootcanary_policy_test.py")], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60000, killSignal: "SIGKILL",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr + stdout).toBe(0);
}, 65000);

import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the source-owned canary collector bounds output and retires owned children on failures", async () => {
  const child = Bun.spawn(["python3", "-I", resolve(import.meta.dir, "fixtures/rootcanary_collector_test.py")], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000, killSignal: "SIGKILL",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exit, stderr + stdout).toBe(0);
});

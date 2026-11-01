import { expect, test } from "bun:test";
import { resolve } from "node:path";
test("native workout source reconstruction and browser prerequisite preservation contracts", () => {
  const result = Bun.spawnSync(["python3", "-I", resolve(import.meta.dir, "../../scripts/test_native_workout_guest.py")], { stdout: "pipe", stderr: "pipe", timeout: 10000 });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
});

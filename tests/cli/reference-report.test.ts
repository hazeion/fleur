import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workoutReference } from "../../scripts/workout-reference";
test("a fresh checkout retains incomplete reference evidence even when cancelled before admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-reference-report-"));
  const report = join(root, "absent", "report.json");
  const controller = new AbortController(); controller.abort();
  try {
    const options = { report, signal: controller.signal } as Parameters<typeof workoutReference>[0];
    await expect(workoutReference(options)).rejects.toMatchObject({ name: "AbortError" });
    expect(JSON.parse(await readFile(report, "utf8"))).toEqual({ formatVersion: 1, passed: false, state: "incomplete" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native verification requires disposable-host opt-in before any prerequisite access", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-native-optin-"));
  try {
    const report = join(scratch, "report.json");
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/verify-native-setup.ts")], {
      env: { ...process.env, PATH: scratch, FLEUR_OWNED_DISPOSABLE_HOST: undefined, FLEUR_NATIVE_REPORT: report },
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 10000,
    });
    expect(await child.exited).toBe(1);
    const observed = JSON.parse(await readFile(report, "utf8"));
    expect(observed.ok).toBe(false);
    expect(observed.error).toBe("Explicit FLEUR_OWNED_DISPOSABLE_HOST=yes opt-in required before Docker access.");
    expect(observed.runs).toEqual([]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

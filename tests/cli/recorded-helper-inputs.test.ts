import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageRecordedHelperInputs } from "../../scripts/verify-fresh-linux.ts";
// Fixed-policy refusal coverage only. Tiny data cannot establish compiled-policy success.
for (const kind of ["wrong-bytes", "missing-second", "symlink", "occupied-output"] as const) {
  test(`recorded input ${kind} refuses before execution and preserves uncertain entries`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-recorded-input-"));
    try {
      const input = join(root, "input"); const output = join(root, "output"); await mkdir(input, { mode: 0o700 });
      await writeFile(join(input, "filter.so"), "not compiled", { mode: 0o600 });
      if (kind !== "missing-second") await writeFile(join(input, "abuse"), "not compiled", { mode: 0o600 });
      if (kind === "symlink") { await rm(join(input, "filter.so")); await symlink(join(input, "abuse"), join(input, "filter.so")); }
      if (kind === "occupied-output") { await mkdir(output, { mode: 0o700 }); await writeFile(join(output, "foreign"), "preserve"); }
      let error: unknown;
      try { await stageRecordedHelperInputs(input, output); } catch (observed) { error = observed; }
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ artifactCleanupConfirmed: false, artifactStagingRetained: true });
      if (kind === "occupied-output") expect(await readFile(join(output, "foreign"), "utf8")).toBe("preserve");
      else expect(await readdir(output)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);
}

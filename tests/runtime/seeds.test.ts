import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { column, defineTable, defineSeed } from "../../src/database";

const table = defineTable("seed_names", { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(8) } });
test("seed declarations validate ownership keys and values and freeze the declaration", () => {
  const rows = [{ ownerKey: "first", values: { id: 1, name: "Squat" } }];
  const seed = defineSeed({ key: "exercises", table, rows });
  rows[0]!.values.name = "Changed";
  expect(seed.rows[0]!.values.name).toBe("Squat");
  expect(Object.isFrozen(seed.rows[0]!.values)).toBe(true);
  for (const key of ["", " a", "a/b"]) expect(() => defineSeed({ key, table, rows })).toThrow("SEED_INVALID");
  expect(() => defineSeed({ key: "names", table, rows: [...rows, ...rows] })).toThrow("SEED_INVALID");
  expect(() => defineSeed({ key: "names", table, rows: [{ ownerKey: "first", values: { id: 1, name: "Overlong name" } }] })).toThrow("SEED_INVALID");
  expect(() => defineSeed({ key: "names", table, rows: [{ ownerKey: "first", values: { id: 1, name: "Valid", version: 9 } as never }] })).toThrow("SEED_INVALID");
});

test("seed declarations cross registration as validated data with table identity and dependency ordering", async () => {
  // Registration reads process-wide registries, which earlier files in the same
  // `bun test` process populate. A fresh process registers only these exports,
  // as the real registration worker does.
  const { restoreManifest } = await import("../../src/runtime/manifest-wire");
  const rows = [{ ownerKey: "first", values: { id: 1, name: "Squat" } }];
  const child = Bun.spawn([process.execPath, "-e", `
    import { column, defineTable, defineSeed } from "./src/database.ts";
    import { makeRunner } from "./src/runtime/worker-entry.ts";
    const table = defineTable("seed_names", { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(8) } });
    const seed = defineSeed({ key: "names", table, rows: ${JSON.stringify(rows)} });
    const result = await makeRunner({ table, seed })({ mode: "register", session: crypto.randomUUID() }, () => { throw new Error("No capability dispatch"); });
    console.log(JSON.stringify(result));
  `], { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  const result = JSON.parse(stdout) as { kind: string; value: unknown };
  expect(result.kind).toBe("complete");
  const registry = restoreManifest(result.value);
  expect(registry.seeds[0]!.table).toBe(registry.tables[0]!);
  expect(registry.seeds[0]!.rows).toEqual(rows);
});

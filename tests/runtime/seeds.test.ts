import { expect, test } from "bun:test";
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
  const { makeRunner } = await import("../../src/runtime/worker-entry");
  const { restoreManifest } = await import("../../src/runtime/manifest-wire");
  const seed = defineSeed({ key: "names", table, rows: [{ ownerKey: "first", values: { id: 1, name: "Squat" } }] });
  const runner = makeRunner({ table, seed });
  const result = await runner({ mode: "register", session: crypto.randomUUID() }, () => { throw new Error("No capability dispatch"); });
  expect(result.kind).toBe("complete");
  const registry = restoreManifest((result as { value: unknown }).value);
  expect(registry.seeds[0]!.table).toBe(registry.tables[0]!);
  expect(registry.seeds[0]!.rows).toEqual(seed.rows);
});

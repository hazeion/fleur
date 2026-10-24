import { expect, test } from "bun:test";
import { column, defineTable } from "../../src/database";
import { schema } from "../../src/schema";
import { describeTables, restoreTables } from "../../src/runtime/table-wire";
import { definition } from "../../src/runtime/declarations";

test("worker table declarations reconstruct only registered, typed read authority", () => {
  const exercises = defineTable("wire_exercises", { columns: { id: column.uuid().primaryKey(), name: column.string().max(100), note: column.string().nullable() } });
  const described = describeTables([exercises]);
  const received = restoreTables(JSON.parse(JSON.stringify(described)));
  expect(received[0]).toHaveProperty("version");
  expect(definition(received[0]!.note!).check.parse(null)).toBeNull();
  expect(() => definition(received[0]!.name!).check.parse("x".repeat(101))).toThrow();
  for (const invalid of [
    [...described, ...described],
    [{ ...described[0], sql: "select * from pg_authid" }],
    [{ ...described[0], name: 'public".secrets' }],
    [{ ...described[0], columns: { ...described[0]!.columns, secret: { kind: "raw", primary: false, nullable: false } } }],
  ]) expect(() => restoreTables(invalid)).toThrow();
  expect(schema.safeInteger().parse(1)).toBe(1);
});

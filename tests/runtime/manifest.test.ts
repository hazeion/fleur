import { expect, test } from "bun:test";
import { column, defineTable } from "../../src/database";
import { schema } from "../../src/schema";
import { describeTables, restoreTables } from "../../src/runtime/table-wire";
import { definition } from "../../src/runtime/declarations";

test("worker table declarations reconstruct only registered, typed read authority", () => {
  const ingredients = defineTable("wire_ingredients", { columns: { id: column.uuid().primaryKey(), name: column.string().max(100), note: column.string().nullable() } });
  const described = describeTables([ingredients]);
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

// Requirements: issue #93. Index declarations cross the worker boundary and migration snapshots only in canonical form.
test("table index declarations round-trip through the wire and reject non-canonical or unknown keys", () => {
  const parents = defineTable("wire_index_parents", { columns: { id: column.uuid().primaryKey() } });
  const children = defineTable("wire_index_children", {
    columns: { id: column.uuid().primaryKey(), parentId: column.uuid().references(parents.id, { onDelete: "cascade" }), position: column.safeInteger() },
    indexes: [{ fields: ["parentId", { field: "position", direction: "desc" }] }],
  });
  const described = describeTables([parents, children]);
  const received = restoreTables(JSON.parse(JSON.stringify(described)));
  expect(describeTables(received)).toEqual(described);
  const child = described[1]!;
  expect(child.indexes).toEqual([{ fields: [{ field: "parentId", direction: "asc" }, { field: "position", direction: "desc" }] }]);
  for (const indexes of [
    [],
    [{ fields: ["parentId"] }],
    [{ fields: [{ field: "parentId", direction: "asc" }], sql: "CREATE INDEX x ON y (z)" }],
    [{ fields: [{ field: "missing", direction: "asc" }] }],
    [{ fields: [{ field: "parentId", direction: "asc", collate: "C" }] }],
  ]) expect(() => restoreTables([described[0], { ...child, indexes }])).toThrow();
});

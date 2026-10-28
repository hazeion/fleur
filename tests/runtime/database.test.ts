import { expect, test } from "bun:test";
import { column, defineTable, type ColumnShape } from "../../src/database";

test("table declarations preserve primary keys, nullable values and managed versions", () => {
  const exercises = defineTable("exercises", { columns: { id: column.uuid().primaryKey(), name: column.string().max(100), note: column.string().nullable() } });
  expect(exercises.id).toBeDefined();
  expect(exercises.version).toBeDefined();
  expect(() => defineTable("unsafe; DROP TABLE exercises", { columns: { id: column.uuid().primaryKey() } })).toThrow();
  expect(() => defineTable("bad", { columns: { id: column.uuid().primaryKey(), version: column.safeInteger() } })).toThrow();
  expect(() => column.string().nullable().primaryKey()).toThrow();
});

test("foreign keys reject incompatible declarations and set-null on required columns", () => {
  const exercises = defineTable("exercises", { columns: { id: column.uuid().primaryKey() } });
  expect(() => column.safeInteger().references(exercises.id as never, { onDelete: "restrict" })).toThrow();
  expect(() => column.uuid().references(exercises.id, { onDelete: "set null" } as never)).toThrow();
  expect(() => column.uuid().nullable().references(exercises.id, { onDelete: "set null" })).not.toThrow();
  expect(() => column.uuid().references(column.uuid().primaryKey(), { onDelete: "restrict" })).toThrow();
});

test("filters validate column values and relation declarations check registered references", async () => {
  const { eq, and, defineRelations } = await import("../../src/database");
  const exercises = defineTable("exercises", { columns: { id: column.uuid().primaryKey(), name: column.string() } });
  const entries = defineTable("entries", { columns: { id: column.uuid().primaryKey(), exerciseId: column.uuid().nullable().references(exercises.id, { onDelete: "set null" }) } });
  expect(() => eq(exercises.name, 1 as never)).toThrow();
  expect(() => and()).toThrow();
  expect(() => defineRelations(entries, ({ one }) => ({ exercise: one(exercises, { fields: [entries.exerciseId], references: [exercises.id] }) }))).not.toThrow();
  expect(() => defineRelations(entries, ({ one }) => ({ bad: one(exercises, { fields: [entries.id], references: [exercises.name] } as never) }))).toThrow();
});

test("foreign keys reject unknown referential actions at runtime", () => {
  const exercises = defineTable("exercises", { columns: { id: column.uuid().primaryKey() } });
  expect(() => column.uuid().references(exercises.id, { onDelete: "NOT AN ACTION" } as never)).toThrow();
});

// Requirements: issue #93. Non-unique, optionally composite and ordered indexes declared on the table.
test("tables declare non-unique indexes over their own columns, with optional descending keys", async () => {
  const { describeTables } = await import("../../src/runtime/table-wire");
  const parents = defineTable("index_parents", { columns: { id: column.uuid().primaryKey() } });
  const children = defineTable("index_children", {
    columns: { id: column.uuid().primaryKey(), parentId: column.uuid().references(parents.id, { onDelete: "cascade" }), position: column.safeInteger(), performedOn: column.localDate() },
    indexes: [{ fields: ["parentId", "position"] }, { fields: [{ field: "performedOn", direction: "desc" }, { field: "id", direction: "asc" }] }],
  });
  expect(describeTables([parents, children])[1]!.indexes).toEqual([
    { fields: [{ field: "parentId", direction: "asc" }, { field: "position", direction: "asc" }] },
    { fields: [{ field: "performedOn", direction: "desc" }, { field: "id", direction: "asc" }] },
  ]);
  // A table without indexes keeps the snapshot shape of earlier releases, so committed migrations stay valid.
  expect(Object.keys(describeTables([parents])[0]!)).toEqual(["name", "versioned", "columns"]);
  expect(Object.keys(describeTables([defineTable("index_none", { columns: { id: column.uuid().primaryKey() }, indexes: [] })])[0]!)).toEqual(["name", "versioned", "columns"]);
});

test("index declarations reject unknown, repeated, redundant or malformed keys", () => {
  const columns = { id: column.uuid().primaryKey(), code: column.string().unique(), label: column.string().unique({ caseFold: true }), position: column.safeInteger(), rank: column.safeInteger() };
  const declare = (indexes: unknown) => () => defineTable("index_invalid", { columns, indexes } as never);
  /** A two-slot array whose first slot is a hole. */
  const afterHole = (entry: unknown) => { const sparse: unknown[] = []; sparse[1] = entry; return sparse; };
  expect(declare([{ fields: ["position"] }, { fields: [{ field: "rank", direction: "desc" }, "position"] }])).not.toThrow();
  // The case-folded unique index keys on the folded value, so it cannot serve ordered reads of the column itself.
  expect(declare([{ fields: ["label"] }])).not.toThrow();
  // Fleur's descending order keeps nulls last; the existing ascending index scanned backwards puts them first.
  expect(declare([{ fields: [{ field: "id", direction: "desc" }] }, { fields: [{ field: "code", direction: "desc" }] }])).not.toThrow();
  for (const invalid of [
    {},
    [{}],
    [null],
    ["position"],
    [{ fields: [] }],
    [{ fields: "position" }],
    [{ fields: ["missing"] }],
    [{ fields: ["version"] }],
    [{ fields: ["toString"] }],
    [{ fields: ["position", "position"] }],
    [{ fields: ["position", { field: "position", direction: "desc" }] }],
    [{ fields: [{ field: "position" }] }],
    [{ fields: [{ field: "position", direction: "DESC" }] }],
    [{ fields: [{ field: "position", direction: "desc", nulls: "first" }] }],
    [{ fields: ["position"], unique: true }],
    [{ fields: ["position"], where: "position > 0" }],
    [{ fields: ["position"] }, { fields: [{ field: "position", direction: "asc" }] }],
    [{ fields: ["id"] }],
    [{ fields: [{ field: "id", direction: "asc" }] }],
    [{ fields: ["code"] }],
    // Sparse arrays: holes are neither indexes nor keys.
    afterHole({ fields: ["position"] }),
    [{ fields: afterHole("position") }],
    [{ fields: Array.from({ length: 33 }, () => "position") }],
  ]) expect({ invalid, thrown: (() => { try { declare(invalid)(); return false; } catch { return true; } })() }).toEqual({ invalid, thrown: true });
  // PostgreSQL admits at most 32 key columns per index; Fleur admits at most 32 declared indexes per table.
  const wide: ColumnShape = { id: column.uuid().primaryKey(), ...Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`c${index}`, column.safeInteger()])) };
  const keys = Object.keys(wide).slice(1);
  expect(() => defineTable("index_wide", { columns: wide, indexes: [{ fields: keys.slice(0, 32) as [string, ...string[]] }] })).not.toThrow();
  expect(() => defineTable("index_wide", { columns: wide, indexes: keys.slice(0, 32).map(key => ({ fields: [key] })) })).not.toThrow();
  expect(() => defineTable("index_wide", { columns: wide, indexes: [{ fields: keys as [string, ...string[]] }] })).toThrow();
  expect(() => defineTable("index_wide", { columns: wide, indexes: keys.map(key => ({ fields: [key] })) })).toThrow();
});

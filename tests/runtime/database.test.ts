import { expect, test } from "bun:test";
import { column, defineTable } from "../../src/database";

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

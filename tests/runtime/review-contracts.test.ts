import { expect, test } from "bun:test";
import { alias, column, defineTable, eq, isNull, type Join, type ReadDb } from "../../src/database";
import { schema } from "../../src/schema";
import { compileRead } from "../../src/runtime/database/selection";
import { restoreSchema } from "../../src/runtime/schema-wire";

for (const key of ["__proto__", "constructor", "prototype"]) {
  test(`strict declarations cannot silently omit required ${key} fields`, () => {
    expect(() => schema.object({ [key]: schema.string() }).parse({})).toThrow();
    expect(() => restoreSchema({ type: "object", properties: { [key]: { type: "string" } } }).parse({})).toThrow();
  });

  test(`optional ${key} fields still validate supplied values`, () => {
    expect(() => schema.object({ [key]: schema.string().optional() }).parse({ [key]: 123 })).toThrow();
    expect(() => restoreSchema({ type: "object", properties: { [key]: { type: "string", optional: true } } }).parse({ [key]: 123 })).toThrow();
  });
}

const parents = defineTable("review_parents", { columns: { id: column.safeInteger().primaryKey() } });
const children = defineTable("review_children", { columns: { id: column.safeInteger().primaryKey(), parentId: column.safeInteger(), name: column.string() } });

test("left joins can filter absent matches using a nonnullable stored key", () => {
  const p = alias(parents, "p"), c = alias(children, "c");
  const plan = compileRead({
    from: p,
    joins: [{ type: "left", table: c, on: eq(p.id, c.parentId) }],
    fields: { id: p.id },
    where: isNull(c.id),
  }, new Set([parents, children]), new Uint8Array(32));
  expect(plan.sql).toContain('"c"."id" IS NULL');
});

// Compiler regression: annotation must not erase possible LEFT JOIN nulls.
function widenedJoinContract(db: ReadDb) {
  const joins: Join[] = [{ type: "left", table: children, on: eq(parents.id, children.parentId) }];
  const rows = db.selectJoined({ from: parents, joins, fields: { name: children.name } });
  // @ts-expect-error A widened Join[] may contain a left join with no match.
  const unsafe: Promise<{ name: string }[]> = rows;
  return unsafe;
}
void widenedJoinContract;

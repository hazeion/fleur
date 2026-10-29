import { schema, type Infer, type LocalDate, type Timestamp } from "../../src/schema";
import { column, defineTable, type Row, type Insert } from "../../src/database";
const publicIngredient = schema.object({ id: schema.uuid(), name: schema.string(), deleted: schema.boolean().nullable(), note: schema.string().optional() });
type Ingredient = Infer<typeof publicIngredient>;
const id = schema.uuid().parse("550e8400-e29b-41d4-a716-446655440000");
const accepted: Ingredient = { id, name: "Sage", deleted: null };
// @ts-expect-error Nullable remains required.
const missingNullable: Ingredient = { id, name: "Sage" };
// @ts-expect-error UUID is validated, not an arbitrary string.
const arbitraryId: Ingredient = { id: "wrong", name: "Sage", deleted: null };
const date: LocalDate = schema.localDate().parse("2024-02-29");
// @ts-expect-error LocalDate and Timestamp are distinct.
const instant: Timestamp = date;
const ingredients = defineTable("ingredients", { columns: { id: column.uuid().primaryKey().generated(), name: column.string(), note: column.string().nullable() } });
const row: Row<typeof ingredients> = { id, name: "Sage", note: null, version: 1 };
const insert: Insert<typeof ingredients> = { name: "Sage", note: null };
// @ts-expect-error Managed version cannot be supplied for insert.
const badInsert: Insert<typeof ingredients> = { name: "Sage", note: null, version: 1 };
// @ts-expect-error Required nullable column cannot be omitted.
const missingColumn: Insert<typeof ingredients> = { name: "Sage" };
// @ts-expect-error Foreign key types must match.
column.safeInteger().references(ingredients.id, { onDelete: "restrict" });
// @ts-expect-error Set-null requires a nullable source.
column.uuid().references(ingredients.id, { onDelete: "set null" });
// Index keys name the table's own declared columns, with an optional asc/desc direction.
const indexed = defineTable("indexed", { columns: { id: column.uuid().primaryKey(), parentId: column.uuid(), position: column.safeInteger() }, indexes: [{ fields: ["parentId", { field: "position", direction: "desc" }] }] });
const indexedRow: Row<typeof indexed> = { id, parentId: id, position: 1, version: 1 };
// @ts-expect-error Index keys must be declared columns of the same table.
defineTable("indexed_unknown", { columns: { id: column.uuid().primaryKey(), position: column.safeInteger() }, indexes: [{ fields: ["missing"] }] });
// @ts-expect-error The managed version column is not an index key.
defineTable("indexed_version", { columns: { id: column.uuid().primaryKey(), position: column.safeInteger() }, indexes: [{ fields: ["version"] }] });
// @ts-expect-error Directions are asc or desc.
defineTable("indexed_direction", { columns: { id: column.uuid().primaryKey(), position: column.safeInteger() }, indexes: [{ fields: [{ field: "position", direction: "down" }] }] });
// @ts-expect-error An index needs at least one key.
defineTable("indexed_empty", { columns: { id: column.uuid().primaryKey(), position: column.safeInteger() }, indexes: [{ fields: [] }] });
// @ts-expect-error Indexes declare keys only; partial and expression indexes are not part of the surface.
defineTable("indexed_partial", { columns: { id: column.uuid().primaryKey(), position: column.safeInteger() }, indexes: [{ fields: ["position"], where: "position > 0" }] });
void [accepted, missingNullable, arbitraryId, instant, row, insert, badInsert, missingColumn, indexed, indexedRow];

import { defineQuery } from "../../src/schema";
import { eq, defineRelations } from "../../src/database";
import { definePage, href } from "../../src/routing";
import { defineIsland } from "../../src/client";
import { h } from "preact";
const list = defineQuery({ input: schema.object({ count: schema.safeInteger() }), output: schema.array(publicIngredient) });
const page = definePage({ path: "/ingredients/:id", params: schema.object({ id: schema.uuid() }) });
href(page, { id });
// @ts-expect-error Required route parameter cannot be omitted.
href(page, {});
// @ts-expect-error Path placeholders must match the declared schema.
definePage({ path: "/ingredients/:wrong", params: schema.object({ id: schema.uuid() }) });
// @ts-expect-error Filter value follows the column type.
eq(ingredients.name, 1);
const Name = defineIsland({ props: schema.object({ name: schema.string() }), component: ({ name }) => h("span", null, name) });
// @ts-expect-error Island props are contextually inferred.
Name({ name: 4 }, {});
// @ts-expect-error Relation references require matching column types.
defineRelations(ingredients, ({ one }) => ({ invalid: one(ingredients, { fields: [ingredients.name], references: [ingredients.id] }) }));
void list;
// @ts-expect-error Optional path parameters do not satisfy a required placeholder.
definePage({ path: "/ingredients/:id", params: schema.object({ id: schema.string().optional() }) });
// @ts-expect-error Route parameters must be string-compatible.
definePage({ path: "/ingredients/:id", params: schema.object({ id: schema.safeInteger() }) });

import type { ReadDb } from "../../src/database";
function readContract(db: ReadDb) {
  const result: Promise<{ id: typeof id; name: string }[]> = db.select(ingredients, { fields: ["id", "name"], limit: 100 });
  // @ts-expect-error Selection fields must exist on the table.
  db.select(ingredients, { fields: ["secret"] });
  // @ts-expect-error Read handlers receive no write capability.
  db.insert(ingredients, { values: { name: "bad", note: null }, returning: ["id"] });
  // @ts-expect-error Read handlers cannot open transactions.
  db.transaction(() => {});
  // @ts-expect-error Read handlers cannot obtain raw SQL connections.
  db.connection();
  return result;
}
void readContract;

import { alias } from "../../src/database";
const tags = defineTable("tags", { columns: { id: column.safeInteger().primaryKey(), ingredientId: column.uuid().references(ingredients.id, { onDelete: "restrict" }), label: column.string() } });
function joinedContract(db: ReadDb) {
  const e = alias(ingredients, "e"), t = alias(tags, "t");
  const result = db.selectJoined({ from: e, joins: [{ type: "left", table: t, on: eq(e.id, t.ingredientId) }], fields: { ingredient: e.name, tag: t.label } });
  const correct: Promise<{ ingredient: string; tag: string | null }[]> = result;
  // @ts-expect-error Left-joined fields can be absent even when the stored column is required.
  const nonnullable: Promise<{ ingredient: string; tag: string }[]> = result;
  void nonnullable;
  return correct;
}
void joinedContract;

function relationAndCursorContract(db: ReadDb) {
  const parent = defineTable("parent", { columns: { id: column.safeInteger().primaryKey() } });
  const child = defineTable("child", { columns: { id: column.safeInteger().primaryKey(), parentId: column.safeInteger().references(parent.id, { onDelete: "restrict" }) } });
  defineRelations(parent, ({ one }) => ({
    // @ts-expect-error Relation fields belong to the source, references to the target.
    backwards: one(child, { fields: [child.parentId], references: [parent.id] }),
  }));
  const cursor = db.cursor(parent, { after: { id: 1 } });
  // @ts-expect-error Cursor table identity must match the selected table.
  db.select(child, { fields: ["id"], cursor });
}
void relationAndCursorContract;

import { defineMutation } from "../../src/schema";
import { handleMutation } from "../../src/server";
import { useMutation, useQuery } from "../../src/client";
import type { WriteDb } from "../../src/database";
const saveContract = defineMutation({ input: schema.object({ name: schema.string() }), output: schema.boolean() });
handleMutation(saveContract, async ({ input }) => input.name.length > 0);
// @ts-expect-error Handler output is inferred from the contract.
handleMutation(saveContract, async () => "wrong");
function mutationTypes(db: WriteDb) {
  const mutation = useMutation(saveContract);
  mutation.run({ name: "Sage" });
  // @ts-expect-error Client input is inferred.
  mutation.run({ name: 1 });
  const generated = defineTable("generated", { columns: { id: column.uuid().generated().primaryKey(), name: column.string() } });
  const defaulted = defineTable("defaulted", { columns: { id: column.uuid().generated().primaryKey(), name: column.string().default("Initial"), changed: column.timestamp().defaultNow() } });
  db.updateVersioned(defaulted, { id, expectedVersion: 1, set: { name: "Edited", changed: schema.timestamp().parse("2026-10-24T12:34:56Z") }, returning: ["name", "changed"] });
  // @ts-expect-error Defaulted columns retain their value types on update.
  db.updateVersioned(defaulted, { id, expectedVersion: 1, set: { name: 4 }, returning: ["name"] });
  const managedOnly = defineTable("managed_only", { columns: { id: column.uuid().generated().primaryKey() } });
  // @ts-expect-error A table containing only managed fields still rejects assignments.
  db.updateVersioned(managedOnly, { id, expectedVersion: 1, set: { id }, returning: ["id"] });
  // @ts-expect-error Generated branding survives fluent declaration order.
  db.insert(generated, { values: { id, name: "Forbidden" }, returning: ["id"] });
  // @ts-expect-error Managed version cannot be assigned.
  db.updateVersioned(ingredients, { id, expectedVersion: 1, set: { version: 3 }, returning: ["id"] });
  // @ts-expect-error Expected version is mandatory.
  db.deleteVersioned(ingredients, { id });
  // @ts-expect-error Versioned tables cannot use unversioned writes.
  db.update(ingredients, { id, set: { name: "Wrong" }, returning: ["id"] });
  const unversioned = defineTable("unversioned", { versioned: false, columns: { id: column.uuid().primaryKey(), name: column.string() } });
  // @ts-expect-error Unversioned tables cannot use versioned writes.
  db.updateVersioned(unversioned, { id, expectedVersion: 1, set: { name: "Wrong" }, returning: ["id"] });
  // @ts-expect-error Primary keys cannot be changed.
  db.update(unversioned, { id, set: { id }, returning: ["id"] });
  db.update(unversioned, { id, set: { name: "Allowed" }, returning: ["id"] });
}
void mutationTypes;
function reactiveTypes() {
  const result = useQuery(list, { count: 10 });
  const data: readonly Ingredient[] | undefined = result.data;
  const refreshing: boolean = result.refreshing;
  void data; void refreshing;
  // @ts-expect-error Query input derives from its contract.
  useQuery(list, { count: "10" });
  // @ts-expect-error Mutation contracts are not reactive read contracts.
  useQuery(saveContract, { name: "test" });
  // @ts-expect-error Output remains the inferred public ingredient array.
  const wrong: number = result.data;
  void wrong;
}
void reactiveTypes;

import { defineSeed } from "../../src/database";
const typedSeed = defineSeed({ key: "ingredients", table: ingredients, rows: [{ ownerKey: "sage", values: { name: "Sage", note: null } }] });
const seedName: string = typedSeed.rows[0]!.values.name;
void seedName;
// @ts-expect-error Seed values retain the table's inferred insert types.
defineSeed({ key: "invalid", table: ingredients, rows: [{ ownerKey: "bad", values: { name: 4, note: null } }] });
// @ts-expect-error Seed values cannot assign a managed version.
defineSeed({ key: "invalid", table: ingredients, rows: [{ ownerKey: "bad", values: { name: "Sage", note: null, version: 4 } }] });

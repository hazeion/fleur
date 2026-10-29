import { afterAll, beforeAll, expect, test } from "bun:test";
import { column, defineTable, eq } from "../../src/database";
import { ReadBroker } from "../../src/runtime/database/broker";
import { ownedPostgres } from "./owned-postgres";

const ingredients = defineTable("mutation_ingredients", { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(100) } });
let fixture: Awaited<ReturnType<typeof ownedPostgres>>;
let broker: ReadBroker;
beforeAll(async () => {
  fixture = await ownedPostgres();
  await fixture.sql.unsafe('CREATE TABLE mutation_ingredients (id bigint PRIMARY KEY, name text NOT NULL UNIQUE, version bigint NOT NULL DEFAULT 1)');
  await fixture.reviewSchema([ingredients]);
  broker = new ReadBroker({ url: fixture.url, tables: [ingredients] });
}, 180_000);
afterAll(async () => { await broker?.close(); await fixture?.cleanup(); });

test("mutation commits validated writes and rolls back output failure", async () => {
  expect(typeof broker.mutate).toBe("function");
  expect(await broker.mutate(async db => db.insert(ingredients, { values: { id: 1, name: "Sage" }, returning: ["id", "name", "version"] }))).toEqual({ id: 1, name: "Sage", version: 1 });
  await expect(broker.mutate(async db => {
    await db.insert(ingredients, { values: { id: 2, name: "Rollback" }, returning: ["id"] });
    throw new Error("Invalid output contains private details");
  })).rejects.toThrow("INTERNAL_FAILURE");
  expect(await broker.read(db => db.select(ingredients, { fields: ["id", "name"] }))).toEqual([{ id: 1, name: "Sage" }]);
});

for (let repeat = 1; repeat <= 2; repeat++) test(`competing expected versions have one winner; stale, missing and constraint failures differ, repeat ${repeat}`, async () => {
  const id = 10 + repeat;
  await broker.mutate(db => db.insert(ingredients, { values: { id, name: `Initial ${repeat}` }, returning: ["id"] }));
  const results = await Promise.allSettled(["Left", "Right"].map(name => broker.mutate(db => db.updateVersioned(ingredients, { id, expectedVersion: 1, set: { name: `${name} ${repeat}` }, returning: ["name", "version"] }))));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
  const winner = results.find(result => result.status === "fulfilled");
  expect(winner).toMatchObject({ value: { version: 2 } });
  await expect(broker.mutate(db => db.deleteVersioned(ingredients, { id, expectedVersion: 1 }))).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(broker.mutate(db => db.updateVersioned(ingredients, { id: 9999, expectedVersion: 1, set: { name: "Absent" }, returning: ["id"] }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(broker.mutate(db => db.updateVersioned(ingredients, { id, expectedVersion: 2, set: { name: "Sage" }, returning: ["id"] }))).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect(await broker.mutate(db => db.deleteVersioned(ingredients, { id, expectedVersion: 2 }))).toEqual({ deleted: true });
  expect(await broker.read(db => db.select(ingredients, { fields: ["id"], where: eq(ingredients.id, id) }))).toEqual([]);
});

test("caught helper failures still roll back earlier writes and generated fields are protected", async () => {
  await expect(broker.mutate(async db => {
    await db.insert(ingredients, { values: { id: 20, name: "Must disappear" }, returning: ["id"] });
    try { await db.insert(ingredients, { values: { id: 21, name: "Sage" }, returning: ["id"] }); } catch { /* cannot authorize commit */ }
    return true;
  })).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect(await broker.read(db => db.select(ingredients, { fields: ["id"], where: eq(ingredients.id, 20) }))).toEqual([]);
  await expect(broker.mutate(db => db.updateVersioned(ingredients, { id: 1, expectedVersion: 1, set: { version: 100 } as never, returning: ["id"] }))).rejects.toThrow("REQUEST_DENIED");
});

for (let repeat = 1; repeat <= 2; repeat++) test(`deadline rolls back preceding writes and releases connection, repeat ${repeat}`, async () => {
  const lock = await fixture.sql.reserve();
  await lock.unsafe("BEGIN");
  await lock.unsafe("SELECT * FROM mutation_ingredients WHERE id=1 FOR UPDATE");
  try {
    await expect(broker.mutate(async db => {
      await db.insert(ingredients, { values: { id: 30 + repeat, name: `Timed out ${repeat}` }, returning: ["id"] });
      return db.updateVersioned(ingredients, { id: 1, expectedVersion: 1, set: { name: "Blocked" }, returning: ["id"] });
    })).rejects.toThrow("QUERY_TIMEOUT");
  } finally { await lock.unsafe("ROLLBACK"); lock.release(); }
  expect(await broker.read(db => db.select(ingredients, { fields: ["id"], where: eq(ingredients.id, 30 + repeat) }))).toEqual([]);
  expect(await broker.read(db => db.select(ingredients, { fields: ["name"], where: eq(ingredients.id, 1) }))).toEqual([{ name: "Sage" }]);
}, 15_000);

test("unawaited helpers cannot race a successful commit", async () => {
  await expect(broker.mutate(async db => {
    void db.insert(ingredients, { values: { id: 50, name: "Unawaited" }, returning: ["id"] });
    return true;
  })).rejects.toThrow("REQUEST_DENIED");
  expect(await broker.read(db => db.select(ingredients, { fields: ["id"], where: eq(ingredients.id, 50) }))).toEqual([]);
});

test("foreign-key failures roll back all rows and explicit unversioned writes reject versioned tables", async () => {
  const notes = defineTable("mutation_notes", { versioned: false, columns: { id: column.safeInteger().primaryKey(), ingredientId: column.safeInteger().references(ingredients.id, { onDelete: "restrict" }), note: column.string().default("Default note") } });
  await fixture.sql.unsafe('CREATE TABLE mutation_notes (id bigint PRIMARY KEY, "ingredientId" bigint NOT NULL REFERENCES mutation_ingredients(id), note text NOT NULL DEFAULT \'Default note\')');
  await fixture.reviewSchema([ingredients, notes]);
  const writer = new ReadBroker({ url: fixture.url, tables: [ingredients, notes] });
  try {
    await expect(writer.mutate(async db => {
      await db.insert(ingredients, { values: { id: 60, name: "Atomic parent" }, returning: ["id"] });
      await db.insert(notes, { values: { id: 1, ingredientId: 9999 }, returning: ["id"] });
      return true;
    })).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
    expect(await writer.read(db => db.select(ingredients, { fields: ["id"], where: eq(ingredients.id, 60) }))).toEqual([]);
    expect(await writer.mutate(db => db.insert(notes, { values: { id: 2, ingredientId: 1, note: "Explicit default replacement" }, returning: ["note"] }))).toEqual({ note: "Explicit default replacement" });
    await expect(writer.mutate(db => db.deleteVersioned(ingredients, { id: 1, expectedVersion: 1 }))).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
    await expect(writer.mutate(db => db.delete(ingredients as never, { id: 1 } as never))).rejects.toThrow("REQUEST_DENIED");
    await expect(writer.mutate(db => db.deleteVersioned(notes as never, { id: 2, expectedVersion: 1 } as never))).rejects.toThrow("REQUEST_DENIED");
    expect(await writer.mutate(db => db.delete(notes, { id: 2 }))).toEqual({ deleted: true });
  } finally { await writer.close(); }
});

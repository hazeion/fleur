import { afterAll, beforeAll, expect, test } from "bun:test";
import { column, defineTable, eq } from "../../src/database";
import { ReadBroker } from "../../src/runtime/database/broker";
import { ownedPostgres } from "./owned-postgres";

const exercises = defineTable("mutation_exercises", { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(100) } });
let fixture: Awaited<ReturnType<typeof ownedPostgres>>;
let broker: ReadBroker;
beforeAll(async () => {
  fixture = await ownedPostgres();
  await fixture.sql.unsafe('CREATE TABLE mutation_exercises (id bigint PRIMARY KEY, name text NOT NULL UNIQUE, version bigint NOT NULL DEFAULT 1)');
  broker = new ReadBroker({ url: fixture.url, tables: [exercises] });
}, 180_000);
afterAll(async () => { await broker?.close(); await fixture?.cleanup(); });

test("mutation commits validated writes and rolls back output failure", async () => {
  expect(typeof broker.mutate).toBe("function");
  expect(await broker.mutate(async db => db.insert(exercises, { values: { id: 1, name: "Squat" }, returning: ["id", "name", "version"] }))).toEqual({ id: 1, name: "Squat", version: 1 });
  await expect(broker.mutate(async db => {
    await db.insert(exercises, { values: { id: 2, name: "Rollback" }, returning: ["id"] });
    throw new Error("Invalid output contains private details");
  })).rejects.toThrow("INTERNAL_FAILURE");
  expect(await broker.read(db => db.select(exercises, { fields: ["id", "name"] }))).toEqual([{ id: 1, name: "Squat" }]);
});

for (let repeat = 1; repeat <= 2; repeat++) test(`competing expected versions have one winner; stale, missing and constraint failures differ, repeat ${repeat}`, async () => {
  const id = 10 + repeat;
  await broker.mutate(db => db.insert(exercises, { values: { id, name: `Initial ${repeat}` }, returning: ["id"] }));
  const results = await Promise.allSettled(["Left", "Right"].map(name => broker.mutate(db => db.updateVersioned(exercises, { id, expectedVersion: 1, set: { name: `${name} ${repeat}` }, returning: ["name", "version"] }))));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
  const winner = results.find(result => result.status === "fulfilled");
  expect(winner).toMatchObject({ value: { version: 2 } });
  await expect(broker.mutate(db => db.deleteVersioned(exercises, { id, expectedVersion: 1 }))).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(broker.mutate(db => db.updateVersioned(exercises, { id: 9999, expectedVersion: 1, set: { name: "Absent" }, returning: ["id"] }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(broker.mutate(db => db.updateVersioned(exercises, { id, expectedVersion: 2, set: { name: "Squat" }, returning: ["id"] }))).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect(await broker.mutate(db => db.deleteVersioned(exercises, { id, expectedVersion: 2 }))).toEqual({ deleted: true });
  expect(await broker.read(db => db.select(exercises, { fields: ["id"], where: eq(exercises.id, id) }))).toEqual([]);
});

test("caught helper failures still roll back earlier writes and generated fields are protected", async () => {
  await expect(broker.mutate(async db => {
    await db.insert(exercises, { values: { id: 20, name: "Must disappear" }, returning: ["id"] });
    try { await db.insert(exercises, { values: { id: 21, name: "Squat" }, returning: ["id"] }); } catch { /* cannot authorize commit */ }
    return true;
  })).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
  expect(await broker.read(db => db.select(exercises, { fields: ["id"], where: eq(exercises.id, 20) }))).toEqual([]);
  await expect(broker.mutate(db => db.updateVersioned(exercises, { id: 1, expectedVersion: 1, set: { version: 100 } as never, returning: ["id"] }))).rejects.toThrow("REQUEST_DENIED");
});

for (let repeat = 1; repeat <= 2; repeat++) test(`deadline rolls back preceding writes and releases connection, repeat ${repeat}`, async () => {
  const lock = await fixture.sql.reserve();
  await lock.unsafe("BEGIN");
  await lock.unsafe("SELECT * FROM mutation_exercises WHERE id=1 FOR UPDATE");
  try {
    await expect(broker.mutate(async db => {
      await db.insert(exercises, { values: { id: 30 + repeat, name: `Timed out ${repeat}` }, returning: ["id"] });
      return db.updateVersioned(exercises, { id: 1, expectedVersion: 1, set: { name: "Blocked" }, returning: ["id"] });
    })).rejects.toThrow("QUERY_TIMEOUT");
  } finally { await lock.unsafe("ROLLBACK"); lock.release(); }
  expect(await broker.read(db => db.select(exercises, { fields: ["id"], where: eq(exercises.id, 30 + repeat) }))).toEqual([]);
  expect(await broker.read(db => db.select(exercises, { fields: ["name"], where: eq(exercises.id, 1) }))).toEqual([{ name: "Squat" }]);
}, 15_000);

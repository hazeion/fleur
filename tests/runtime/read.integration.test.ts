import { afterAll, beforeAll, expect, test } from "bun:test";
import { column, defineTable, eq } from "../../src/database";
import { ReadBroker } from "../../src/runtime/database/broker";
import { ownedPostgres } from "./owned-postgres";

let fixture: Awaited<ReturnType<typeof ownedPostgres>>;
const exercises = defineTable("exercises", { columns: { id: column.safeInteger().primaryKey(), name: column.string(), note: column.string().nullable() } });
const cancelledReads = defineTable("cancelled_reads", { columns: { id: column.safeInteger().primaryKey(), name: column.string() } });
let broker: ReadBroker;
beforeAll(async () => {
  fixture = await ownedPostgres();
  await fixture.sql.unsafe("CREATE TABLE exercises (id bigint PRIMARY KEY, name text NOT NULL, note text, version bigint NOT NULL DEFAULT 1)");
  await fixture.sql.unsafe("INSERT INTO exercises (id,name) SELECT n, 'Exercise ' || n FROM generate_series(1, 502) n");
  await fixture.sql.unsafe("CREATE FUNCTION cancelled_read() RETURNS text LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cancelled by server' USING ERRCODE = '57014'; END $$");
  await fixture.sql.unsafe("CREATE VIEW cancelled_reads AS SELECT 1::bigint AS id, cancelled_read() AS name");
  await fixture.reviewSchema([exercises, cancelledReads]);
  broker = new ReadBroker({ url: fixture.url, tables: [exercises, cancelledReads] });
}, 180_000);
afterAll(async () => { await broker?.close(); await fixture?.cleanup(); });

test("server cancellation before the host timer retains the public query timeout", async () => {
  await expect(broker.read(db => db.select(cancelledReads, { fields: ["id", "name"] }))).rejects.toThrow("QUERY_TIMEOUT");
  expect(await broker.read(db => db.select(exercises, { fields: ["id"], limit: 1 }))).toEqual([{ id: 1 }]);
});

test("registered read selection defaults to 100 rows and projects only declared fields", async () => {
  const rows = await broker.read(db => db.select(exercises, { fields: ["id", "name"], orderBy: [{ field: "id", direction: "asc" }] }));
  expect(rows).toHaveLength(100);
  expect(rows[0]).toEqual({ id: 1, name: "Exercise 1" });
  expect(rows[99]).toEqual({ id: 100, name: "Exercise 100" });
  expect(await broker.read(db => db.select(exercises, { fields: ["name", "note"], where: eq(exercises.id, 2) }))).toEqual([{ name: "Exercise 2", note: null }]);
  await expect(broker.read(db => db.select(exercises, { fields: ["id"], limit: 501 }))).rejects.toThrow("QUERY_LIMIT");
}, 15_000);

test("reads reject oversized UTF-8 results and expose no write or raw connection helpers", async () => {
  await fixture.sql.unsafe("UPDATE exercises SET name = $1 WHERE id = 502", ["💪".repeat(270_000)]);
  await expect(broker.read(db => db.select(exercises, { fields: ["name"], where: eq(exercises.id, 502) }))).rejects.toThrow("RESULT_TOO_LARGE");
  expect(await broker.read(async db => Object.keys(db))).toEqual(["cursorJoined", "cursor", "selectJoined", "select"]);
  const foreign = defineTable("other_exercises", { columns: { id: column.safeInteger().primaryKey() } });
  await expect(broker.read(db => db.select(foreign, { fields: ["id"] }))).rejects.toThrow("REQUEST_DENIED");
}, 15_000);

for (let repeat = 1; repeat <= 2; repeat++) test(`query deadline includes queued work and leaves healthy reads usable, repeat ${repeat}`, async () => {
  const lock = await fixture.sql.reserve();
  await lock.unsafe("BEGIN");
  await lock.unsafe("LOCK TABLE exercises IN ACCESS EXCLUSIVE MODE");
  try {
    const start = performance.now();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => broker.read(db => db.select(exercises, { fields: ["id"], limit: 1 }))));
    expect(results.every(result => result.status === "rejected" && result.reason instanceof Error && result.reason.message === "QUERY_TIMEOUT")).toBe(true);
    expect(performance.now() - start).toBeLessThan(6000);
  } finally { await lock.unsafe("ROLLBACK"); lock.release(); }
  expect(await broker.read(db => db.select(exercises, { fields: ["id"], limit: 1 }))).toEqual([{ id: 1 }]);
}, 15_000);

test("stable cursors bind filter and ordering and retain the unique tie-breaker", async () => {
  const first = await broker.read(db => db.select(exercises, { fields: ["id", "name"], orderBy: [{ field: "id", direction: "asc" }], limit: 2 }));
  const cursor = await broker.read(async db => db.cursor(exercises, { orderBy: [{ field: "id", direction: "asc" }], after: first[1]! }));
  expect(await broker.read(db => db.select(exercises, { fields: ["id"], orderBy: [{ field: "id", direction: "asc" }], limit: 2, cursor }))).toEqual([{ id: 3 }, { id: 4 }]);
  await expect(broker.read(db => db.select(exercises, { fields: ["id"], orderBy: [{ field: "id", direction: "desc" }], cursor }))).rejects.toThrow("REQUEST_DENIED");
  await expect(broker.read(db => db.select(exercises, { fields: ["id"], where: eq(exercises.id, 3), cursor }))).rejects.toThrow("REQUEST_DENIED");
  await expect(broker.read(db => db.select(exercises, { fields: ["id"], cursor: "not-a-cursor" }))).rejects.toThrow("REQUEST_DENIED");
});

test("public cursors do not disclose internal SQL or server filter values", async () => {
  const cursor = await broker.read(async db => db.cursor(exercises, { where: eq(exercises.name, "private-filter-value-for-issue25"), after: { id: 1 } }));
  expect(cursor.split(".").map(part => Buffer.from(part, "base64url").toString()).join(" ")).not.toContain("private-filter-value-for-issue25");
});

test("timestamp projections preserve PostgreSQL microseconds", async () => {
  const events = defineTable("events", { columns: { id: column.safeInteger().primaryKey(), stamp: column.timestamp() } });
  await fixture.sql.unsafe("CREATE TABLE events (id bigint PRIMARY KEY, stamp timestamptz NOT NULL, version bigint NOT NULL DEFAULT 1)");
  await fixture.sql.unsafe("INSERT INTO events (id, stamp) VALUES (1, '2024-02-29T12:00:00.123456Z')");
  await fixture.reviewSchema([events]);
  const reader = new ReadBroker({ url: fixture.url, tables: [events] });
  try {
    const result = await reader.read(db => db.select(events, { fields: ["stamp"] }));
    expect(String(result[0]?.stamp)).toBe("2024-02-29T12:00:00.123456Z");
  } finally { await reader.close(); }
});

test("left joins return typed projected rows with nullable missing matches", async () => {
  const { alias } = await import("../../src/database");
  const tags = defineTable("tags", { columns: { id: column.safeInteger().primaryKey(), exerciseId: column.safeInteger().references(exercises.id, { onDelete: "restrict" }), label: column.string() } });
  await fixture.sql.unsafe("CREATE TABLE tags (id bigint PRIMARY KEY, \"exerciseId\" bigint REFERENCES exercises(id), label text NOT NULL, version bigint NOT NULL DEFAULT 1)");
  await fixture.sql.unsafe("INSERT INTO tags (id,\"exerciseId\",label) VALUES (1,2,'barbell'),(2,2,'strength')");
  await fixture.reviewSchema([exercises, tags]);
  const reader = new ReadBroker({ url: fixture.url, tables: [exercises, tags] });
  try {
    const e = alias(exercises, "e"), t = alias(tags, "t");
    const rows = await reader.read(db => db.selectJoined({ from: e, joins: [{ type: "left", table: t, on: eq(e.id, t.exerciseId) }], fields: { id: e.id, label: t.label }, limit: 3 }));
    expect(rows).toEqual([{ id: 1, label: null }, { id: 2, label: "barbell" }, { id: 2, label: "strength" }]);
    const selection = { from: e, joins: [{ type: "left" as const, table: t, on: eq(e.id, t.exerciseId) }], fields: { id: e.id, tagId: t.id, label: t.label } };
    const first = await reader.read(db => db.selectJoined({ ...selection, limit: 2 }));
    const cursor = await reader.read(async db => db.cursorJoined({ ...selection, after: first[1]! }));
    expect(await reader.read(db => db.selectJoined({ ...selection, limit: 2, cursor }))).toEqual([{ id: 2, tagId: 2, label: "strength" }, { id: 3, tagId: null, label: null }]);
  } finally { await reader.close(); }
});

test("read handlers cannot gain write authority through a database function", async () => {
  await fixture.sql.unsafe("CREATE FUNCTION try_write() RETURNS text LANGUAGE plpgsql AS $$ BEGIN UPDATE exercises SET name='unauthorized' WHERE id=1; RETURN 'written'; END $$");
  await fixture.sql.unsafe("CREATE VIEW forbidden_reads AS SELECT 1::bigint AS id, try_write() AS name, 1::bigint AS version");
  const forbidden = defineTable("forbidden_reads", { columns: { id: column.safeInteger().primaryKey(), name: column.string() } });
  await fixture.reviewSchema([forbidden, exercises]);
  const reader = new ReadBroker({ url: fixture.url, tables: [forbidden, exercises] });
  try {
    await expect(reader.read(db => db.select(forbidden, { fields: ["name"] }))).rejects.toThrow("INTERNAL_FAILURE");
    expect(await reader.read(db => db.select(exercises, { fields: ["name"], where: eq(exercises.id, 1) }))).toEqual([{ name: "Exercise 1" }]);
  } finally { await reader.close(); }
});

test("sequential reads retain Read Committed semantics without an implicit shared snapshot", async () => {
  const results = await broker.read(async db => {
    const before = await db.select(exercises, { fields: ["name"], where: eq(exercises.id, 501) });
    await fixture.sql.unsafe("UPDATE exercises SET name='Changed after first read' WHERE id=501");
    const after = await db.select(exercises, { fields: ["name"], where: eq(exercises.id, 501) });
    return { before, after };
  });
  expect(results).toEqual({ before: [{ name: "Exercise 501" }], after: [{ name: "Changed after first read" }] });
});

test("registered application tables cannot resolve through PostgreSQL's implicit catalog search path", async () => {
  const settings = defineTable("pg_settings", { columns: { name: column.string().primaryKey(), setting: column.string() }, versioned: false });
  await fixture.reviewSchema([settings]);
  const reader = new ReadBroker({ url: fixture.url, tables: [settings] });
  try { await expect(reader.read(db => db.select(settings, { fields: ["name", "setting"], limit: 1 }))).rejects.toThrow("INTERNAL_FAILURE"); }
  finally { await reader.close(); }
});

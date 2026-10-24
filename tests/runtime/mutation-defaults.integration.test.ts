import { expect, test } from "bun:test";
import { column, defineTable } from "../../src/database";
import { schema } from "../../src/schema";
import { ReadBroker } from "../../src/runtime/database/broker";
import { tableDDL } from "../../src/runtime/database/table-ddl";
import { ownedPostgres } from "./owned-postgres";

test("database defaults remain editable while generated columns stay managed", async () => {
  const table = defineTable("default_values", { columns: { id: column.uuid().generated().primaryKey(), name: column.string().default("Initial"), changed: column.timestamp().defaultNow() } });
  const fixture = await ownedPostgres();
  const broker = new ReadBroker({ url: fixture.url, tables: [table] });
  try {
    for (const statement of tableDDL([table])) await fixture.sql.unsafe(statement);
    const row = await broker.mutate(db => db.insert(table, { values: {}, returning: ["id", "name", "version"] }));
    expect(row.name).toBe("Initial");
    const changed = schema.timestamp().parse("2026-10-24T12:34:56.123456Z");
    expect(await broker.mutate(db => db.updateVersioned(table, { id: row.id, expectedVersion: 1, set: { name: "Edited", changed }, returning: ["name", "changed", "version"] }))).toEqual({ name: "Edited", changed, version: 2 });
    await expect(broker.mutate(db => db.updateVersioned(table, { id: row.id, expectedVersion: 2, set: { id: row.id } as never, returning: ["id"] }))).rejects.toThrow("REQUEST_DENIED");
  } finally { await broker.close(); await fixture.cleanup(); }
}, 30_000);

test("an acknowledged deferred constraint rejection at COMMIT is a known failure", async () => {
  const parents = defineTable("deferred_parents", { columns: { id: column.safeInteger().primaryKey() } });
  const children = defineTable("deferred_children", { columns: { id: column.safeInteger().primaryKey(), parentId: column.safeInteger().references(parents.id, { onDelete: "restrict" }) } });
  const fixture = await ownedPostgres();
  const broker = new ReadBroker({ url: fixture.url, tables: [parents, children] });
  try {
    await fixture.sql.unsafe('CREATE TABLE deferred_parents(id bigint PRIMARY KEY, version bigint NOT NULL DEFAULT 1)');
    await fixture.sql.unsafe('CREATE TABLE deferred_children(id bigint PRIMARY KEY, "parentId" bigint REFERENCES deferred_parents(id) DEFERRABLE INITIALLY DEFERRED, version bigint NOT NULL DEFAULT 1)');
    await expect(broker.mutate(db => db.insert(children, { values: { id: 1, parentId: 99 }, returning: ["id"] }))).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
    expect(await broker.read(db => db.select(children, { fields: ["id"] }))).toEqual([]);
  } finally { await broker.close(); await fixture.cleanup(); }
}, 30_000);

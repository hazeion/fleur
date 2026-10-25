import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { column, defineTable, defineSeed } from "../../src/database";
import { ownedPostgres } from "./owned-postgres";
import { generateMigration } from "../../src/runtime/database/migration-plan";
import { applyMigrations } from "../../src/runtime/database/migrations";
import { seedDatabase } from "../../src/runtime/database/seeds";
import { ReadBroker } from "../../src/runtime/database/broker";

test("seeds update only unchanged owned rows and preserve user edits, tombstones and removed declarations", async () => {
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), "fleur-seeds-"));
  const table = defineTable("seed_rows", { columns: { id: column.safeInteger().primaryKey(), name: column.string().max(20) } });
  const broker = new ReadBroker({ url: fixture.url, tables: [table], maintenance: { stateRoot: root } });
  const seed = (name: string) => defineSeed({ key: "catalog", table, rows: [{ ownerKey: "squat", values: { id: 1, name } }, { ownerKey: "press", values: { id: 2, name: "Press" } }] });
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    await generateMigration(root, [table]); await applyMigrations(fixture.url, root, config);
    expect(await seedDatabase(fixture.url, root, [seed("Squat")], config)).toMatchObject({ inserted: 2, updated: 0, skipped: [] });
    expect(await seedDatabase(fixture.url, root, [seed("Squat")], config)).toMatchObject({ inserted: 0, updated: 0 });
    expect(await seedDatabase(fixture.url, root, [seed("Back squat")], config)).toMatchObject({ updated: 1 });
    await broker.mutate(db => db.updateVersioned(table, { id: 1, expectedVersion: 2, set: { name: "My squat" }, returning: ["id"] }));
    expect(await seedDatabase(fixture.url, root, [seed("Front squat")], config)).toMatchObject({ updated: 0, skipped: [{ seed: "catalog", ownerKey: "squat", reason: "user-edited" }] });
    await broker.mutate(db => db.deleteVersioned(table, { id: 2, expectedVersion: 1 }));
    expect(await seedDatabase(fixture.url, root, [seed("Front squat")], config)).toMatchObject({ inserted: 0, skipped: [{ seed: "catalog", ownerKey: "squat", reason: "user-edited" }, { seed: "catalog", ownerKey: "press", reason: "deleted" }] });
    await seedDatabase(fixture.url, root, [], config);
    expect(await broker.read(db => db.select(table, { fields: ["id", "name", "version"] }))).toEqual([{ id: 1, name: "My squat", version: 3 }]);
    await broker.mutate(db => db.insert(table, { values: { id: 2, name: "User recreation" }, returning: ["id"] }));
    await expect(seedDatabase(fixture.url, root, [seed("Squat")], config)).rejects.toThrow("SEED_CONFLICT");
    expect(await broker.read(db => db.select(table, { fields: ["name"], orderBy: [{ field: "id", direction: "asc" }] }))).toEqual([{ name: "My squat" }, { name: "User recreation" }]);
  } finally { await broker.close(); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("declared seed dependencies order parent writes and missing graphs fail atomically", async () => {
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), "fleur-seed-graph-"));
  const parent = defineTable("seed_parents", { columns: { id: column.safeInteger().primaryKey(), name: column.string() } });
  const child = defineTable("seed_children", { columns: { id: column.safeInteger().primaryKey(), parent: column.safeInteger().references(parent.id, { onDelete: "cascade" }) } });
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    await generateMigration(root, [parent, child]); await applyMigrations(fixture.url, root, config);
    const parents = defineSeed({ key: "parents", table: parent, rows: [{ ownerKey: "first", values: { id: 1, name: "First" } }] });
    const children = defineSeed({ key: "children", table: child, rows: [{ ownerKey: "first", values: { id: 1, parent: 1 } }] });
    await expect(seedDatabase(fixture.url, root, [parents, children], config)).rejects.toThrow("SEED_INVALID");
    const linked = defineSeed({ key: "children", table: child, rows: children.rows, dependsOn: [parents] });
    expect(await seedDatabase(fixture.url, root, [linked, parents], config)).toMatchObject({ inserted: 2 });
    const broker = new ReadBroker({ url: fixture.url, tables: [parent, child], maintenance: config });
    try {
      await broker.mutate(db => db.deleteVersioned(parent, { id: 1, expectedVersion: 1 }));
      expect(await seedDatabase(fixture.url, root, [linked, parents], config)).toMatchObject({ inserted: 0, skipped: [{ reason: "deleted" }, { reason: "deleted" }] });
      expect(await broker.read(db => db.select(child, { fields: ["id"] }))).toEqual([]);
    } finally { await broker.close(); }
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("unversioned fingerprints preserve edits and a later ownership collision rolls back earlier writes", async () => {
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), "fleur-unversioned-seed-"));
  const table = defineTable("seed_unversioned", { versioned: false, columns: { id: column.safeInteger().primaryKey(), name: column.string().unique() } });
  const broker = new ReadBroker({ url: fixture.url, tables: [table], maintenance: { stateRoot: root } });
  const make = (name: string) => defineSeed({ key: "plain", table, rows: [{ ownerKey: "one", values: { id: 1, name } }] });
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    await generateMigration(root, [table]); await applyMigrations(fixture.url, root, config);
    await seedDatabase(fixture.url, root, [make("First")], config);
    expect(await seedDatabase(fixture.url, root, [make("Second")], config)).toMatchObject({ updated: 1 });
    await broker.mutate(db => db.insert(table, { values: { id: 2, name: "Occupied" }, returning: ["id"] }));
    const conflict = defineSeed({ key: "plain", table, rows: [{ ownerKey: "one", values: { id: 1, name: "Rolled back" } }, { ownerKey: "two", values: { id: 2, name: "Collision" } }] });
    await expect(seedDatabase(fixture.url, root, [conflict], config)).rejects.toThrow("SEED_CONFLICT");
    expect(await broker.read(db => db.select(table, { fields: ["name"], orderBy: [{ field: "id", direction: "asc" }] }))).toEqual([{ name: "Second" }, { name: "Occupied" }]);
    await broker.mutate(db => db.update(table, { id: 1, set: { name: "User edit" }, returning: ["id"] }));
    expect(await seedDatabase(fixture.url, root, [make("Third")], config)).toMatchObject({ skipped: [{ reason: "user-edited" }] });
  } finally { await broker.close(); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

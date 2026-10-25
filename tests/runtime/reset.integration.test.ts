import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQL } from "bun";
import { column, defineTable, defineSeed } from "../../src/database";
import { ownedPostgres } from "./owned-postgres";
import { generateMigration } from "../../src/runtime/database/migration-plan";
import { applyMigrations } from "../../src/runtime/database/migrations";
import { resetDatabase } from "../../src/runtime/database/reset";
import { MaintenanceLease } from "../../src/runtime/database/maintenance";

test("reset refuses unbound/production targets, verifies backup and recreates only the approved development database", async () => {
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), "fleur-reset-"));
  const table = defineTable("reset_rows", { columns: { id: column.safeInteger().primaryKey(), name: column.string() } });
  let connection: SQL | undefined;
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    await generateMigration(root, [table]); await applyMigrations(fixture.url, root, config);
    await fixture.sql.unsafe("INSERT INTO public.reset_rows VALUES(1,'Keep until approved',1)");
    const before = await MaintenanceLease.acquire(fixture.url, false, config); const old = before.target.oid; await before.close();
    await expect(resetDatabase(fixture.url, root, [], config)).rejects.toThrow("REQUEST_DENIED");
    await expect(resetDatabase(fixture.url, root, [], { ...config, developmentUrl: fixture.url })).rejects.toThrow("AUTHORITY_REQUIRED");
    const result = await resetDatabase(fixture.url, root, [], { ...config, developmentUrl: fixture.url, confirm: async request => request.action === "reset" });
    expect(result.reset).toBe(true); expect(result.backup.verified).toBe(true);
    connection = new SQL(fixture.url, { max: 1 });
    expect(await connection.unsafe("SELECT * FROM public.reset_rows")).toEqual([]);
    const after = await MaintenanceLease.acquire(fixture.url, false, config); try { expect(after.target.oid).not.toBe(old); expect((await after.marker())!.stage).toBe("committed"); } finally { await after.close(); }
    const seeded = defineSeed({ key: "reset", table, rows: [{ ownerKey: "first", values: { id: 1, name: "Fresh" } }] });
    const second = await resetDatabase(fixture.url, root, [seeded], { ...config, developmentUrl: fixture.url, seed: true, confirm: async () => true });
    expect(second.seeded).toMatchObject({ inserted: 1 });
    await connection.close({ timeout: 0 }); connection = new SQL(fixture.url, { max: 1 });
    expect(await connection.unsafe("SELECT name FROM public.reset_rows")).toEqual([{ name: "Fresh" }]);
  } finally { await connection?.close({ timeout: 0 }); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

test("reset excludes startup and competing reset and rejects plan changes made during approval", async () => {
  const { ReadBroker } = await import("../../src/runtime/database/broker");
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), "fleur-reset-race-"));
  const original = defineTable("reset_race", { columns: { id: column.safeInteger().primaryKey() } });
  const broker = new ReadBroker({ url: fixture.url, tables: [original], maintenance: { stateRoot: root } });
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")), developmentUrl: fixture.url };
    await generateMigration(root, [original]); await applyMigrations(fixture.url, root, config);
    await fixture.sql.unsafe("INSERT INTO public.reset_race VALUES(1,1)");
    await expect(resetDatabase(fixture.url, root, [], { ...config, confirm: async () => {
      await expect(broker.read(db => db.select(original, { fields: ["id"] }))).rejects.toThrow("MAINTENANCE_BUSY");
      await expect(resetDatabase(fixture.url, root, [], config)).rejects.toThrow("MAINTENANCE_BUSY");
      await generateMigration(root, [defineTable("reset_race", { columns: { id: column.safeInteger().primaryKey(), name: column.string().nullable() } })]);
      return true;
    } })).rejects.toThrow("MIGRATION_EDITED");
    expect(await fixture.sql.unsafe("SELECT id FROM public.reset_race")).toEqual([{ id: "1" }]);
  } finally { await broker.close(); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

for (const missing of [false, true]) test(`failed recreation retains its fence and explicitly restores the retained backup, missing target ${missing}`, async () => {
  const { restoreDatabase } = await import("../../src/runtime/database/migrations");
  const { inspectMaintenance } = await import("../../src/runtime/database/recovery");
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), "fleur-reset-interrupted-"));
  const table = defineTable("reset_interrupted", { columns: { id: column.safeInteger().primaryKey(), name: column.string() } });
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")), developmentUrl: fixture.url };
    await generateMigration(root, [table]); await applyMigrations(fixture.url, root, config);
    await fixture.sql.unsafe("INSERT INTO public.reset_interrupted VALUES(1,'Before reset',1)");
    const conflicting = defineSeed({ key: "conflict", table, rows: [{ ownerKey: "a", values: { id: 1, name: "A" } }, { ownerKey: "b", values: { id: 1, name: "B" } }] });
    await expect(resetDatabase(fixture.url, root, [conflicting], { ...config, seed: true, confirm: async () => true })).rejects.toThrow("SEED_CONFLICT");
    if (missing) {
      const owner = await MaintenanceLease.acquire(fixture.url, true, config, true);
      try { await owner.sql.unsafe(`DROP DATABASE "${owner.target.database}" WITH (FORCE)`); } finally { await owner.close(); }
    }
    const inspection = await inspectMaintenance(fixture.url, config);
    expect(inspection.maintenance!.stage).toBe("recovery required");
    expect(inspection.classification).toBe("uncertain");
    if (!missing) await expect(MaintenanceLease.acquire(fixture.url, false, config)).rejects.toThrow("RECOVERY_REQUIRED");
    if (!missing) await expect(resetDatabase(fixture.url, root, [], { ...config, confirm: async () => true })).rejects.toThrow("RECOVERY_REQUIRED");
    expect(await restoreDatabase(fixture.url, root, inspection.maintenance!.backup!, { ...config, confirm: async () => true })).toMatchObject({ restored: true });
    const sql = new SQL(fixture.url, { max: 1 });
    try { expect(await sql.unsafe("SELECT name FROM public.reset_interrupted")).toEqual([{ name: "Before reset" }]); } finally { await sql.close({ timeout: 0 }); }
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 240_000);

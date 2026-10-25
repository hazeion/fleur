import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedPostgres } from "./owned-postgres";
import { ReadBroker } from "../../src/runtime/database/broker";
import { column, defineTable } from "../../src/database";
import { SQL } from "bun";

const table = defineTable("maintenance_rows", { columns: { id: column.safeInteger().primaryKey(), name: column.string() } });
for (let repeat = 1; repeat <= 2; repeat++) test(`an external exclusive maintenance lock refuses a new operation before handler dispatch, repeat ${repeat}`, async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-maintenance-"));
  const controlUrl = new URL(fixture.url); controlUrl.pathname = "/postgres";
  const control = new SQL(controlUrl.toString(), { max: 1 });
  const broker = new ReadBroker({ url: fixture.url, tables: [table] });
  try {
    await fixture.sql.unsafe("CREATE TABLE maintenance_rows (id bigint PRIMARY KEY, name text NOT NULL, version bigint NOT NULL DEFAULT 1)");
    await fixture.reviewSchema([table]);
    // This is the documented database-level Fleur lock key, independently calculated in SQL.
    const identity = await control.unsafe("SELECT system_identifier::text AS cluster FROM pg_control_system()");
    const database = new URL(fixture.url).pathname.slice(1);
    const key = new Bun.CryptoHasher("sha256").update(`fleur:maintenance:v1:${identity[0].cluster}:${database}`).digest("hex").slice(0, 16);
    const signed = BigInt.asIntN(64, BigInt(`0x${key}`)).toString();
    await control.unsafe("SELECT pg_advisory_lock($1::bigint)", [signed]);
    let dispatched = false;
    await expect(broker.read(async () => { dispatched = true; return []; })).rejects.toThrow("MAINTENANCE_BUSY");
    expect(dispatched).toBe(false);
    await control.unsafe("SELECT pg_advisory_unlock($1::bigint)", [signed]);
    expect(await broker.read(db => db.select(table, { fields: ["id"] }))).toEqual([]);
  } finally { await broker.close(); await control.close(); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 180_000);

test("interrupted maintenance remains blocked after its owner releases the database lock", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-interrupted-"));
  const broker = new ReadBroker({ url: fixture.url, tables: [table], maintenance: { stateRoot: root } });
  try {
    const { MaintenanceLease } = await import("../../src/runtime/database/maintenance");
    const maintenance = await MaintenanceLease.acquire(fixture.url, true, { stateRoot: root });
    await maintenance.persist({ formatVersion: 1, target: maintenance.target, stage: "preparing", planChecksum: "a".repeat(64), backup: null, epoch: crypto.randomUUID() });
    await maintenance.close();
    let called = false;
    await expect(broker.read(async () => { called = true; return []; })).rejects.toThrow("RECOVERY_REQUIRED");
    expect(called).toBe(false);
    const status = await MaintenanceLease.acquire(fixture.url, false, { stateRoot: root }, true);
    try { expect((await status.marker())?.stage).toBe("preparing"); } finally { await status.close(); }
  } finally { await broker.close(); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 180_000);

test("read-only recovery inspection survives absence of the replaceable database", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-missing-target-"));
  const { MaintenanceLease } = await import("../../src/runtime/database/maintenance");
  const owner = await MaintenanceLease.acquire(fixture.url,true,{stateRoot:root});
  try {
    await owner.persist({formatVersion:1,target:owner.target,stage:"preparing",backup:null,planChecksum:"c".repeat(64),epoch:crypto.randomUUID()});
    await fixture.sql.close({timeout:0});
    await owner.sql.unsafe(`DROP DATABASE "${owner.target.database}"`);
    const inspection=await MaintenanceLease.acquire(fixture.url,false,{stateRoot:root},true);
    try { expect(inspection.busy).toBe(true); expect((await inspection.marker())?.stage).toBe("preparing"); }
    finally { await inspection.close(); }
  } finally {await owner.close();await fixture.cleanup();await rm(root,{recursive:true,force:true});}
},180_000);

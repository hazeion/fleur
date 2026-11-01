import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedPostgres } from "./owned-postgres";
import { MaintenanceLease } from "../../src/runtime/database/maintenance";
import { SQL } from "bun";
import { ReadBroker } from "../../src/runtime/database/broker";
import { column, defineTable } from "../../src/database";

test("maintenance session verification rejects an unrelated advisory lock", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-review-lock-"));
  let lease: MaintenanceLease | undefined;
  try {
    lease = await MaintenanceLease.acquire(fixture.url, true, { stateRoot: root });
    await lease.sql.unsafe("SELECT pg_advisory_unlock($1::bigint)", [lease.key]);
    const unrelated = (BigInt(lease.key) === 1n ? 2n : 1n).toString();
    await lease.sql.unsafe("SELECT pg_advisory_lock($1::bigint)", [unrelated]);
    await expect(lease.assertSession()).rejects.toThrow("RECOVERY_REQUIRED");
  } finally { await lease?.close(); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 180_000);

const fenceRows = defineTable("review_fence_rows", { columns: { id: column.safeInteger().primaryKey() } });
for (const loss of ["primary", "all"] as const) for (let repeat = 1; repeat <= 2; repeat++) test(`control ${loss} backend death preserves an independent control fence and rolls back admitted writes, repeat ${repeat}`, async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-review-fence-"));
  const broker = new ReadBroker({ url: fixture.url, tables: [fenceRows], maintenance: { stateRoot: root } });
  const controlUrl = new URL(fixture.url); controlUrl.pathname = "/postgres";
  const control = new SQL(controlUrl.toString(), { max: 1, connectionTimeout: 2 });
  let release: () => void = () => {};
  let maintenance: MaintenanceLease | undefined;
  let outcome: Promise<unknown> | undefined;
  try {
    await fixture.sql.unsafe("CREATE TABLE review_fence_rows(id bigint PRIMARY KEY, version bigint NOT NULL DEFAULT 1)");
    await fixture.reviewSchema([fenceRows]);
    await control.unsafe("SELECT 1");
    const observed = await MaintenanceLease.acquire(fixture.url, false, { stateRoot: root });
    const key = observed.key;
    await observed.close();
    let entered: () => void = () => {};
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    outcome = broker.mutate(async db => {
      await db.insert(fenceRows, { values: { id: 1 }, returning: ["id"] });
      entered();
      await paused;
      return [];
    }).then(() => "committed", error => error instanceof Error ? error.message : "unexpected failure");
    await Promise.race([inside, outcome.then(value => { throw new Error(`Mutation finished before pause: ${String(value)}`); })]);
    const unsigned = BigInt.asUintN(64, BigInt(key));
    const holders = await control.unsafe("SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname='postgres') AND classid=$1::oid AND objid=$2::oid AND objsubid=1 AND mode='ShareLock' AND granted", [(unsigned >> 32n).toString(), (unsigned & 0xffffffffn).toString()]);
    expect(holders).toHaveLength(1);
    expect((await control.unsafe("SELECT pg_terminate_backend($1::int) AS stopped", [holders[0].pid]))[0]?.stopped).toBe(true);
    if (loss === "all") {
      const fences = await control.unsafe("SELECT DISTINCT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname='postgres') AND mode='ShareLock' AND granted");
      expect(fences).toHaveLength(1);
      expect((await control.unsafe("SELECT pg_terminate_backend($1::int) AS stopped", [fences[0].pid]))[0]?.stopped).toBe(true);
    }
    maintenance = await MaintenanceLease.acquire(fixture.url, true, { stateRoot: root });
    expect((await fixture.sql.unsafe("SELECT count(*)::text AS count FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())"))[0].count).toBe("0");
    await expect(maintenance.fence("exclusive", fixture.sql)).rejects.toThrow("MAINTENANCE_BUSY");
    release();
    expect(await outcome).toBe("RECOVERY_REQUIRED");
    expect(await fixture.sql.unsafe("SELECT * FROM review_fence_rows")).toEqual([]);
    await maintenance.fence("exclusive", fixture.sql);
  } finally {
    release(); await outcome; await maintenance?.close(); await broker.close(); await control.close();
    await fixture.cleanup(); await rm(root, { recursive: true, force: true });
  }
}, 180_000);

test("revision fence contention consumes the operation's remaining budget and rolls back", async () => {
  const { digest } = await import("../../src/runtime/database/maintenance");
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), "fleur-control-fence-deadline-"));
  const broker = new ReadBroker({ url: fixture.url, tables: [fenceRows], maintenance: { stateRoot: root } });
  const url = new URL(fixture.url); url.pathname = "/postgres";
  const control = new SQL(url.toString());
  let key: string | undefined;
  try {
    await fixture.sql.unsafe("CREATE TABLE review_fence_rows(id bigint PRIMARY KEY,version bigint NOT NULL DEFAULT 1)");
    await fixture.reviewSchema([fenceRows]);
    const observed = await MaintenanceLease.acquire(fixture.url, false, { stateRoot: root });
    key = BigInt.asIntN(64, BigInt(`0x${digest(`fleur:revision:v1:${observed.target.cluster}:${observed.target.database}`).slice(0,16)}`)).toString();
    await observed.close();
    await control.unsafe("SELECT pg_advisory_lock($1::bigint)", [key]);
    const started = performance.now();
    await expect(broker.mutate(async db => { await db.insert(fenceRows, { values: { id: 1 }, returning: ["id"] }); return []; }, { operation: "deadline", input: {} }, started - 4200)).rejects.toThrow("QUERY_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(await fixture.sql.unsafe("SELECT * FROM review_fence_rows")).toEqual([]);
  } finally {
    if (key) await control.unsafe("SELECT pg_advisory_unlock($1::bigint)", [key]);
    await control.close(); await broker.close(); await fixture.cleanup(); await rm(root, { recursive: true, force: true });
  }
}, 15000);

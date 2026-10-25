import { expect, test } from "bun:test";
import { column, defineTable } from "../../src/database";
import { ReadBroker } from "../../src/runtime/database/broker";
import { ownedPostgres } from "./owned-postgres";

for (let repeat = 1; repeat <= 2; repeat++) test(`managed commits advance a durable revision, rollback does not, and reopened brokers observe it, repeat ${repeat}`, async () => {
  const fixture = await ownedPostgres();
  const table = defineTable("revision_items", { columns: { id: column.safeInteger().primaryKey() } });
  let broker: ReadBroker | undefined;
  try {
    await fixture.sql.unsafe("CREATE TABLE revision_items(id bigint PRIMARY KEY, version bigint NOT NULL DEFAULT 1)");
    await fixture.reviewSchema([table]);
    broker = new ReadBroker({ url: fixture.url, tables: [table] });
    const initial = await broker.revision();
    expect(initial.revision).toBe("0");
    expect(initial.epoch).toMatch(/^[a-f0-9-]{36}$/);
    let wakeups = 0;
    const unwatch = await broker.watch(() => { wakeups++; });
    await broker.mutate(db => db.insert(table, { values: { id: 1 }, returning: ["id"] }));
    expect(await broker.revision()).toEqual({ ...initial, revision: "1" });
    const deadline = Date.now() + 1000;
    while (!wakeups && Date.now() < deadline) await Bun.sleep(10);
    expect(wakeups).toBe(1);
    await expect(broker.mutate(async db => {
      await db.insert(table, { values: { id: 2 }, returning: ["id"] });
      throw new Error("invalid output");
    })).rejects.toThrow("INTERNAL_FAILURE");
    expect(await broker.revision()).toEqual({ ...initial, revision: "1" });
    await Bun.sleep(50);
    expect(wakeups).toBe(1);
    await unwatch();
    await broker.close();
    broker = new ReadBroker({ url: fixture.url, tables: [table] });
    expect(await broker.revision()).toEqual({ ...initial, revision: "1" });
  } finally { await broker?.close(); await fixture.cleanup(); }
}, 180_000);

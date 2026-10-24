import { expect, test } from "bun:test";
import { column, defineTable, eq, alias, type ReadDb } from "../../src/database";
import { workerReadDb, dispatchRead } from "../../src/runtime/read-wire";

test("read IPC resolves only admitted table references and denies raw or write actions", async () => {
  const table = defineTable("wire_reads", { columns: { id: column.safeInteger().primaryKey() } });
  let calls = 0;
  const host = { select: async (received: unknown, options: unknown) => { expect(received).toBe(table); expect(options).toMatchObject({ fields: ["id"] }); calls++; return [{ id: 1 }]; } } as unknown as ReadDb;
  const requests: unknown[] = [];
  const db = workerReadDb(request => { requests.push(request); return [{ id: 1 }]; });
  expect(await db.select(table, { fields: ["id"], where: eq(table.id, 1) })).toEqual([{ id: 1 }]);
  expect(await dispatchRead(requests[0], host, [table])).toEqual([{ id: 1 }]);
  for (const request of [{ action: "unsafe", args: ["select 1"] }, { action: "insert", args: [] }, { action: "select", args: [{ $table: { name: "secrets" } }, { fields: ["id"] }] }]) {
    await expect(dispatchRead(request, host, [table])).rejects.toThrow("REQUEST_DENIED");
  }
  expect(calls).toBe(1);
  const named = alias(table, "items");
  await db.selectJoined({ from: named, joins: [], fields: { id: named.id } });
  expect(JSON.stringify(requests[1])).toContain('"alias":"items"');
});

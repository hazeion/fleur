import { expect, test } from "bun:test";
import { createServer, connect, type Socket } from "node:net";
import { column, defineTable } from "../../src/database";
import { ReadBroker } from "../../src/runtime/database/broker";
import { ownedPostgres } from "./owned-postgres";

for (let repeat = 1; repeat <= 2; repeat++) test(`lost PostgreSQL COMMIT acknowledgement remains unknown without retry, repeat ${repeat}`, async () => {
  const fixture = await ownedPostgres();
  const sockets = new Set<Socket>();
  let broker: ReadBroker | undefined;
  let commits = 0;
  const target = new URL(fixture.url);
  const databasePort = Number(target.port);
  const proxy = createServer(client => {
    const upstream = connect({ host: target.hostname, port: databasePort });
    sockets.add(client); sockets.add(upstream);
    let commit = false;
    client.on("data", data => { if (String(data).includes("COMMIT\0")) commit = true; upstream.write(data); });
    upstream.on("data", data => {
      if (commit && String(data).includes("COMMIT\0")) {
        commits++;
        client.destroy(); upstream.destroy();
      } else client.write(data);
    });
    for (const [socket, peer] of [[client, upstream], [upstream, client]] as const) {
      socket.on("error", () => peer.destroy());
      socket.on("close", () => { sockets.delete(socket); peer.destroy(); });
    }
  });
  try {
    await fixture.sql.unsafe("CREATE TABLE commit_loss(id bigint PRIMARY KEY, name text NOT NULL, version bigint NOT NULL DEFAULT 1)");
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy address");
    target.port = String(address.port);
    const table = defineTable("commit_loss", { columns: { id: column.safeInteger().primaryKey(), name: column.string() } });
    broker = new ReadBroker({ url: target.href, tables: [table] });
    await expect(broker.mutate(db => db.insert(table, { values: { id: repeat, name: "Committed once" }, returning: ["id"] }))).rejects.toThrow("OUTCOME_UNKNOWN");
    expect(commits).toBe(1);
    const observer = new ReadBroker({ url: fixture.url, tables: [table] });
    try { expect(await observer.read(db => db.select(table, { fields: ["id", "name", "version"] }))).toEqual([{ id: repeat, name: "Committed once", version: 1 }]); }
    finally { await observer.close(); }
  } finally {
    await broker?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await fixture.cleanup();
  }
}, 30_000);

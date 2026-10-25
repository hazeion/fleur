import { expect, test } from "bun:test";
import { column, defineTable } from "../../src/database";
import { ReadBroker } from "../../src/runtime/database/broker";
import { ownedPostgres } from "./owned-postgres";

test("a caught oversized write result still rolls back the mutation", async () => {
  const table = defineTable("review_mutation_payload", { columns: { id: column.safeInteger().primaryKey(), payload: column.string() } });
  const fixture = await ownedPostgres();
  const broker = new ReadBroker({ url: fixture.url, tables: [table] });
  try {
    await fixture.sql.unsafe("CREATE TABLE review_mutation_payload (id bigint PRIMARY KEY, payload text NOT NULL, version bigint NOT NULL DEFAULT 1)");
    await fixture.reviewSchema([table]);
    await expect(broker.mutate(async db => {
      try {
        await db.insert(table, { values: { id: 1, payload: "a".repeat(1048576) }, returning: ["payload"] });
      } catch { /* Catching a failed helper cannot authorize partial commit. */ }
      return true;
    })).rejects.toThrow("RESULT_TOO_LARGE");
    expect(await broker.read(db => db.select(table, { fields: ["id"] }))).toEqual([]);
  } finally { await broker.close(); await fixture.cleanup(); }
}, 180_000);

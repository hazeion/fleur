import { expect, test } from "bun:test";
import { column, defineTable } from "../../src/database";
import { caseFold } from "../../src/schema";
import * as declarations from "../../src/runtime/database/table-ddl";
import { ReadBroker } from "../../src/runtime/database/broker";
import { ownedPostgres } from "./owned-postgres";

test("PostgreSQL enforces the same full Unicode fold independently of application checks", async () => {
  expect(typeof column.string().unique).toBe("function");
  const table = defineTable("unicode_ingredients", { columns: { id: column.uuid().primaryKey().generated(), name: column.string().max(100).unique({ caseFold: true }) } });
  const fixture = await ownedPostgres();
  const broker = new ReadBroker({ url: fixture.url, tables: [table] });
  try {
    for (const statement of declarations.tableDDL([table])) await fixture.sql.unsafe(statement);
    await fixture.reviewSchema([table]);
    for (const [display, conflict] of [["Straße", "STRASSE"], ["Σ", "ς"], ["İ", "i\u0307"], ["𐐀", "𐐨"]]) {
      expect(caseFold(display!)).toBe(caseFold(conflict!));
      await broker.mutate(db => db.insert(table, { values: { name: display! }, returning: ["id"] }));
      await expect(broker.mutate(db => db.insert(table, { values: { name: conflict! }, returning: ["id"] }))).rejects.toMatchObject({ code: "CONSTRAINT_CONFLICT" });
      await expect(Promise.resolve(fixture.sql.unsafe('INSERT INTO unicode_ingredients(name) VALUES ($1)', [conflict!]))).rejects.toThrow();
    }
    const values = ["Straße Σςσ İIı ﬃ 𐐀", "🧂", "é", "e\u0301"];
    for (const value of values) expect((await fixture.sql.unsafe('SELECT public.fleur_casefold_17($1) AS folded', [value]))[0].folded).toBe(caseFold(value));
  } finally { await broker.close(); await fixture.cleanup(); }
}, 180_000);

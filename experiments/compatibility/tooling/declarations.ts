import type { PgRelationalQuery } from "drizzle-orm/pg-core/query-builders/query";
import { pgTable, integer, text, numeric, QueryBuilder } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
const records = pgTable("records", {
  id: integer().primaryKey(),
  name: text().notNull(),
  notes: text(),
  amount: numeric({ precision: 8, scale: 2 }),
});
const query = new QueryBuilder().select().from(records);
const querySQL: SQL = query.getSQL();
type Selected = typeof records.$inferSelect;
type Inserted = typeof records.$inferInsert;
const selected: Selected = { id: 1, name: "Squat", notes: null, amount: "12.50" };
const inserted: Inserted = { id: 1, name: "Squat" };
export const declarationContract = { querySQL, selected, inserted };

export type RelationalSQL = ReturnType<PgRelationalQuery<typeof selected>["getSQL"]>;

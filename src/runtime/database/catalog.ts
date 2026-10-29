import type { SQL } from "bun";
import { z } from "zod";

type Connection = Pick<SQL, "unsafe">;
/** Structure of one application table in `public`, read from PostgreSQL catalogs only. */
export interface CatalogTable {
  readonly name: string;
  readonly columns: readonly { readonly name: string; readonly type: string; readonly collation: string | null; readonly nullable: boolean; readonly default: string | null; readonly identity: "" | "a" | "d" }[];
  readonly constraints: readonly { readonly name: string; readonly type: "p" | "f" | "u" | "c" | "x"; readonly columns: readonly string[]; readonly references: { readonly table: string; readonly columns: readonly string[] } | null; readonly onDelete: string | null; readonly definition: string }[];
  /** Indexes that do not back a primary-key, unique or exclusion constraint. */
  readonly indexes: readonly { readonly name: string; readonly unique: boolean; readonly keys: readonly string[]; readonly descending: readonly boolean[]; readonly nullsFirst: readonly boolean[]; readonly definition: string }[];
}
const names = z.array(z.string()).max(1600);
const columnRow = z.strictObject({ table: z.string(), name: z.string(), type: z.string(), collation: z.string().nullable(), nullable: z.boolean(), default: z.string().nullable(), identity: z.enum(["", "a", "d"]) });
const constraintRow = z.strictObject({ table: z.string(), name: z.string(), type: z.enum(["p", "f", "u", "c", "x"]), columns: z.string().nullable(), ref_table: z.string().nullable(), ref_columns: z.string().nullable(), on_delete: z.string().nullable(), definition: z.string() });
const indexRow = z.strictObject({ table: z.string(), name: z.string(), unique: z.boolean(), keys: z.string(), options: z.string(), definition: z.string() });
const keyOptions = z.array(z.number().int().min(0).max(3)).max(32);
const deleteActions: Record<string, string> = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };
const selected = (alias: string) => `n.nspname='public' AND ${alias}.relkind IN ('r','p') AND ${alias}.relname::text IN (SELECT jsonb_array_elements_text($1::text::jsonb))`;
const list = (value: string | null) => value === null ? [] : names.parse(JSON.parse(value));

/** Base tables in `public`, ordered by name. Fleur-owned metadata lives in `fleur_internal` and is never listed. */
export async function tableNames(sql: Connection, after: string | null, limit: number): Promise<string[]> {
  const rows = await sql.unsafe(`SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND ($1::text IS NULL OR c.relname::text > $1::text COLLATE "C") ORDER BY c.relname::text COLLATE "C" LIMIT $2`, [after, limit]);
  return z.array(z.strictObject({ name: z.string() })).parse(rows).map(row => row.name);
}
/** Describes the named application tables, which the caller listed in the same snapshot, or every one when `only` is null. Statements are Fleur-generated and bind every value. */
export async function catalogTables(sql: Connection, only: readonly string[] | null): Promise<CatalogTable[]> {
  const requested = only ?? await tableNames(sql, null, 2147483647);
  const filter = JSON.stringify(requested);
  const columns = z.array(columnRow).parse(await sql.unsafe(`SELECT c.relname::text AS table, a.attname::text AS name, format_type(a.atttypid,a.atttypmod) AS type, CASE WHEN a.attcollation<>t.typcollation THEN co.collname::text END AS collation, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin,d.adrelid) AS default, a.attidentity::text AS identity FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE ${selected("c")} AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname::text COLLATE "C", a.attnum`, [filter]));
  const constraints = z.array(constraintRow).parse(await sql.unsafe(`SELECT c.relname::text AS table, k.conname::text AS name, k.contype::text AS type, (SELECT json_agg(a.attname::text ORDER BY u.o) FROM unnest(k.conkey) WITH ORDINALITY u(n,o) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.n)::text AS columns, CASE WHEN k.contype='f' THEN (SELECT CASE WHEN rn.nspname='public' THEN rc.relname::text ELSE rn.nspname::text||'.'||rc.relname::text END FROM pg_class rc JOIN pg_namespace rn ON rn.oid=rc.relnamespace WHERE rc.oid=k.confrelid) END AS ref_table, CASE WHEN k.contype='f' THEN (SELECT json_agg(a.attname::text ORDER BY u.o) FROM unnest(k.confkey) WITH ORDINALITY u(n,o) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=u.n)::text END AS ref_columns, CASE WHEN k.contype='f' THEN k.confdeltype::text END AS on_delete, pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${selected("c")} AND k.contype IN ('p','f','u','c','x') ORDER BY c.relname::text COLLATE "C", k.conname::text COLLATE "C"`, [filter]));
  const indexes = z.array(indexRow).parse(await sql.unsafe(`SELECT c.relname::text AS table, ic.relname::text AS name, i.indisunique AS unique, (SELECT json_agg(CASE WHEN i.indkey[k-1]<>0 THEN (SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=i.indrelid AND a.attnum=i.indkey[k-1]) ELSE pg_get_indexdef(i.indexrelid,k,true) END ORDER BY k) FROM generate_series(1,i.indnkeyatts::int) k)::text AS keys, (SELECT json_agg(i.indoption[k-1]::int ORDER BY k) FROM generate_series(1,i.indnkeyatts::int) k)::text AS options, pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${selected("c")} AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid=i.indexrelid AND k.conrelid=i.indrelid AND k.contype IN ('p','u','x')) ORDER BY c.relname::text COLLATE "C", ic.relname::text COLLATE "C"`, [filter]));
  const tables = new Map<string, { name: string; columns: CatalogTable["columns"][number][]; constraints: CatalogTable["constraints"][number][]; indexes: CatalogTable["indexes"][number][] }>();
  for (const name of requested) tables.set(name, { name, columns: [], constraints: [], indexes: [] });
  const table = (name: string) => tables.get(name)!;
  for (const { table: name, ...column } of columns) table(name).columns.push(column);
  for (const row of constraints) table(row.table).constraints.push({ name: row.name, type: row.type, columns: list(row.columns), references: row.type === "f" ? { table: row.ref_table ?? "", columns: list(row.ref_columns) } : null, onDelete: row.on_delete === null ? null : deleteActions[row.on_delete] ?? row.on_delete, definition: row.definition });
  // pg_index.indoption: bit 0 is DESC, bit 1 is NULLS FIRST.
  for (const row of indexes) {
    const options = keyOptions.parse(JSON.parse(row.options));
    table(row.table).indexes.push({ name: row.name, unique: row.unique, keys: list(row.keys), descending: options.map(option => (option & 1) !== 0), nullsFirst: options.map(option => (option & 2) !== 0), definition: row.definition });
  }
  return [...tables.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
/** Fleur's case-folded uniqueness indexes key on `fleur_casefold_17(column)`. */
export function caseFoldedKey(key: string): string | null {
  const match = /^(?:public\.)?fleur_casefold_17\(("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)\)(?: COLLATE "C")?$/.exec(key);
  if (!match) return null;
  const name = match[1]!;
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;
}

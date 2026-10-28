import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, link, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { z } from "zod";
import type { Json } from "../../cli/result";
import { MaintenanceLease, digest, syncDirectory, type MaintenanceConfiguration } from "./maintenance";
import { caseFoldedKey, catalogTables, tableNames, type CatalogTable } from "./catalog";
import { readMigrationStatus } from "./migration-status";
import { withInspection, type TargetKind } from "./target";

export interface InspectionOptions { readonly table?: string; readonly limit?: number; readonly cursor?: string; readonly export?: string; }
export function quote(name: string): string { return '"'+name.replaceAll('"', '""')+'"'; }
async function cursorKey(lease: MaintenanceLease): Promise<Buffer> {
  return lease.sql.begin(async sql => {
    // Shared inspection leases can initialize concurrently, including across
    // processes. Keep readers outside the temporary two-link publication state.
    await sql.unsafe("SET LOCAL statement_timeout='5s'");
    const key = BigInt.asIntN(64, BigInt(`0x${digest(`fleur:cursor-key:v1:${lease.key}`).slice(0, 16)}`)).toString();
    await sql.unsafe("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
    return readCursorKey(lease);
  });
}
async function readCursorKey(lease: MaintenanceLease): Promise<Buffer> {
  const path = `${lease.directory}/cursor.key`;
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const candidate = await open(temporary, "wx", 0o600);
  try { await candidate.writeFile(randomBytes(32)); await candidate.sync(); }
  finally { await candidate.close(); }
  try { await link(temporary, path); await syncDirectory(lease.directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { await unlink(temporary); }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 32 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("RECOVERY_REQUIRED");
    return await file.readFile();
  } finally { await file.close(); }
}
export async function publishFile(pathValue: string, data: string | Uint8Array): Promise<{ destination: string; bytes: number; sha256: string; complete: true }> {
  const path = resolve(pathValue), temp = `${path}.${crypto.randomUUID()}.partial`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(data); await file.sync();
    await link(temp, path); await syncDirectory(dirname(path));
    return { destination: path, bytes: Buffer.byteLength(data), sha256: digest(data), complete: true };
  } finally { await file.close(); await unlink(temp); }
}
const pageBytes = 1044480;
/** Overview of one catalog table, with Fleur column kinds, versioning and managed columns from the applied snapshot. */
export function describeTable(table: CatalogTable, snapshot: unknown): Json {
  const declared = Array.isArray(snapshot) ? (snapshot as { name?: unknown; versioned?: unknown; columns?: Record<string, { kind?: unknown; managed?: unknown }> }[]).find(entry => entry?.name === table.name) : undefined;
  const versioned = typeof declared?.versioned === "boolean" ? declared.versioned : null;
  const field = (name: string) => versioned && name === "version" ? { kind: "safeInteger", managed: true } : declared?.columns && Object.hasOwn(declared.columns, name) ? declared.columns[name] : undefined;
  const primary = table.constraints.find(constraint => constraint.type === "p");
  return {
    name: table.name,
    versioned,
    columns: table.columns.map(column => ({ name: column.name, type: column.type, kind: typeof field(column.name)?.kind === "string" ? field(column.name)!.kind as string : null, nullable: column.nullable, default: column.default, identity: column.identity !== "", managed: field(column.name)?.managed === true })),
    primaryKey: primary ? { name: primary.name, columns: [...primary.columns] } : null,
    foreignKeys: table.constraints.filter(constraint => constraint.type === "f").map(constraint => ({ name: constraint.name, columns: [...constraint.columns], references: { table: constraint.references!.table, columns: [...constraint.references!.columns] }, onDelete: constraint.onDelete })),
    uniqueConstraints: table.constraints.filter(constraint => constraint.type === "u").map(constraint => ({ name: constraint.name, columns: [...constraint.columns] })),
    indexes: table.indexes.map(index => {
      const folded = index.keys.length === 1 ? caseFoldedKey(index.keys[0]!) : null;
      return { name: index.name, unique: index.unique, columns: folded ? [folded] : [...index.keys], caseFolded: folded !== null, definition: index.definition };
    }),
  };
}
/**
 * `db inspect`: without a table, a paginated schema overview with no rows; with a table, its structure and a bounded
 * page of rows. Both embed the migration summary and never block on drift or maintenance.
 */
export async function inspectDatabase(url: string, options: InspectionOptions & { readonly project: string }, config: MaintenanceConfiguration & { readonly kind?: TargetKind } = {}): Promise<{ readonly data: Json; readonly truncated: boolean }> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("ARGUMENT_INVALID");
  return withInspection(url, config.kind ?? "development", config, async ({ sql, lease, target, ...session }) => {
    const report = await readMigrationStatus({ sql, lease, target, ...session }, options.project);
    const key = await cursorKey(lease);
    let after: string[] | undefined;
    const table = options.table;
    const columnRows = table ? await sql.unsafe("SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS required, coalesce(a.attnum=ANY(i.indkey),false) AS primary FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary WHERE n.nspname='public' AND c.relname=$1 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", [table]) : [];
    if (table && (!columnRows.length || columnRows.length > 100)) throw new Error("ARGUMENT_INVALID");
    const columns = z.array(z.strictObject({ name: z.string(), type: z.string(), required: z.boolean(), primary: z.boolean() })).parse(columnRows);
    const primary = table ? columns.filter(column => column.primary).map(column => column.name) : ["name"];
    if (table && !primary.length) throw new Error("UNSUPPORTED_CAPABILITY");
    const binding = digest(JSON.stringify({ target: lease.target, table: table ?? null, columns }));
    if (options.cursor) {
      try {
        if (options.cursor.length > 16384) throw new Error();
        const raw = Buffer.from(options.cursor, "base64url");
        if (raw.toString("base64url") !== options.cursor) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        const value = z.strictObject({ binding: z.literal(binding), after: z.array(z.string()).max(100) }).parse(JSON.parse(inflateSync(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]), { maxOutputLength: 1048576 }).toString()));
        if (value.after.length !== primary.length) throw new Error();
        after = value.after;
      } catch { throw new Error("ARGUMENT_INVALID"); }
    }
    const continuation = (last: readonly string[]) => {
      const iv = randomBytes(12);
      // The command grammar reads a value starting with "-" as a missing option value. The first base64url character
      // comes from the top six IV bits; avoid index 62 ("-"). The IV stays random and unique.
      if (iv[0]! >> 2 === 62) iv[0] = iv[0]! ^ 0x80;
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(deflateSync(JSON.stringify({ binding, after: last }))), cipher.final()]);
      const next = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
      if (next.length > 16384) throw new Error("RESULT_TOO_LARGE");
      return next;
    };
    let result: { readonly [key: string]: Json }, truncated: boolean;
    if (!table) {
      const names = await tableNames(sql, after?.[0] ?? null, limit+1);
      const tables: Json[] = [];
      // Reserve room for the continuation cursor; the page is bounded by count and by encoded bytes.
      let size = Buffer.byteLength(JSON.stringify({ view: "overview", target, migrations: report.summary, tables: [], cursor: null, truncated: true })) + 16384 + 64;
      let full = false;
      for (let index = 0; index < Math.min(names.length, limit) && !full; index += 25) {
        for (const described of await catalogTables(sql, names.slice(index, Math.min(index+25, limit)))) {
          const entry = describeTable(described, report.snapshot), bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
          if (size + bytes > pageBytes) { if (!tables.length) throw new Error("RESULT_TOO_LARGE"); full = true; break; }
          tables.push(entry); size += bytes;
        }
      }
      truncated = full || names.length > tables.length;
      const cursor = truncated ? continuation([(tables.at(-1) as { name: string }).name]) : null;
      result = { view: "overview", target, migrations: report.summary, tables, cursor, truncated };
    } else {
      const pieces: string[] = [];
      for (let index = 0; index < columns.length; index += 40) pieces.push(`jsonb_build_object(${columns.slice(index,index+40).map(column => `'${column.name.replaceAll("'", "''")}',source.${quote(column.name)}::text`).join(",")})`);
      const selection = pieces.join(" || ");
      const where = after ? `WHERE (${primary.map(name => `source.${quote(name)}`).join(",")}) > (${primary.map((_, index) => `$${index+1}`).join(",")})` : "";
      const values = after ?? [];
      const query = `WITH encoded AS (SELECT row_number() OVER (ORDER BY ${primary.map(name => `source.${quote(name)}`).join(",")}) AS position, (${selection})::text AS payload FROM public.${quote(table)} AS source ${where} ORDER BY ${primary.map(name => `source.${quote(name)}`).join(",")} LIMIT $${values.length+1}), sized AS (SELECT *, sum(octet_length(payload)) OVER (ORDER BY position) AS total FROM encoded) SELECT CASE WHEN total<=983040 THEN payload ELSE NULL END AS payload FROM sized ORDER BY position`;
      const page = await sql.unsafe(query, [...values, limit+1]);
      const rows: Json[] = [];
      for (const row of page.slice(0, limit)) {
        if (row.payload === null) { if (!rows.length) throw new Error("RESULT_TOO_LARGE"); break; }
        rows.push(JSON.parse(String(row.payload)) as Json);
      }
      truncated = page.length > rows.length;
      const last = rows.at(-1) as Record<string, string> | undefined;
      const cursor = truncated && last ? continuation(primary.map(name => last[name]!)) : null;
      const structure = describeTable((await catalogTables(sql, [table]))[0]!, report.snapshot);
      result = { view: "table", target, migrations: report.summary, table, structure, columns, rows, cursor, truncated };
    }
    if (Buffer.byteLength(JSON.stringify(result)) > pageBytes) throw new Error("RESULT_TOO_LARGE");
    if (options.export) {
      const metadata = await publishFile(options.export, JSON.stringify(result)+"\n");
      return { data: { ...result, ...(table ? { rows: [] } : { tables: [] }), export: metadata }, truncated };
    }
    return { data: result, truncated };
  });
}

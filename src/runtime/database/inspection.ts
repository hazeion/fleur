import { SQL } from "bun";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, link, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { Json } from "../../cli/result";
import { MaintenanceLease, digest, syncDirectory, type MaintenanceConfiguration } from "./maintenance";

export interface InspectionOptions { readonly table?: string; readonly limit?: number; readonly cursor?: string; readonly export?: string; }
export function quote(name: string): string { return '"'+name.replaceAll('"', '""')+'"'; }
async function cursorKey(lease: MaintenanceLease): Promise<Buffer> {
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
export async function inspectDatabase(url: string, options: InspectionOptions, config: MaintenanceConfiguration = {}): Promise<{ readonly data: Json; readonly truncated: boolean }> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("ARGUMENT_INVALID");
  const lease = await MaintenanceLease.acquire(url, false, config);
  const sql = new SQL(url, { max: 1, connectionTimeout: 2 });
  const timer = setTimeout(() => { void sql.close({ timeout: 0 }).catch(() => {}); void lease.close().catch(() => {}); }, config.timeoutMs ?? 60000);
  try {
    await sql.unsafe("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
    await sql.unsafe("SET LOCAL statement_timeout='5s'");
    await sql.unsafe("SET LOCAL search_path=pg_catalog");
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
        const value = z.strictObject({ binding: z.literal(binding), after: z.array(z.string()).max(100) }).parse(JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString()));
        if (value.after.length !== primary.length) throw new Error();
        after = value.after;
      } catch { throw new Error("ARGUMENT_INVALID"); }
    }
    let rows: Json[], next: string | null = null, truncated: boolean;
    if (!table) {
      const list = await sql.unsafe("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND ($1::text IS NULL OR c.relname > $1) ORDER BY c.relname LIMIT $2", [after?.[0] ?? null, limit+1]);
      truncated = list.length > limit;
      rows = list.slice(0, limit).map((row: { name: unknown }) => ({ name: String(row.name) }));
    } else {
      const pieces: string[] = [];
      for (let index = 0; index < columns.length; index += 40) pieces.push(`jsonb_build_object(${columns.slice(index,index+40).map(column => `'${column.name.replaceAll("'", "''")}',source.${quote(column.name)}::text`).join(",")})`);
      const selection = pieces.join(" || ");
      const where = after ? `WHERE (${primary.map(name => `source.${quote(name)}`).join(",")}) > (${primary.map((_, index) => `$${index+1}`).join(",")})` : "";
      const values = after ?? [];
      const query = `WITH encoded AS (SELECT row_number() OVER (ORDER BY ${primary.map(name => `source.${quote(name)}`).join(",")}) AS position, (${selection})::text AS payload FROM public.${quote(table)} AS source ${where} ORDER BY ${primary.map(name => `source.${quote(name)}`).join(",")} LIMIT $${values.length+1}), sized AS (SELECT *, sum(octet_length(payload)) OVER (ORDER BY position) AS total FROM encoded) SELECT CASE WHEN total<=983040 THEN payload ELSE NULL END AS payload FROM sized ORDER BY position`;
      const result = await sql.unsafe(query, [...values, limit+1]);
      rows = [];
      for (const row of result.slice(0, limit)) {
        if (row.payload === null) { if (!rows.length) throw new Error("RESULT_TOO_LARGE"); break; }
        rows.push(JSON.parse(String(row.payload)) as Json);
      }
      truncated = result.length > rows.length;
    }
    if (truncated && rows.length) {
      const last = rows[rows.length-1] as Record<string, string>;
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ binding, after: primary.map(name => last[name]) })), cipher.final()]);
      next = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
    }
    const result = { table: table ?? null, columns, rows, cursor: next, truncated };
    if (Buffer.byteLength(JSON.stringify(result)) > 1044480) throw new Error("RESULT_TOO_LARGE");
    if (options.export) {
      const metadata = await publishFile(options.export, JSON.stringify(result)+"\n");
      return { data: { ...result, rows: [], export: metadata }, truncated };
    }
    return { data: result, truncated };
  } finally { clearTimeout(timer); await sql.close({ timeout: 0 }); await lease.close(); }
}

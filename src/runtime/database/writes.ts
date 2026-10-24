import type { Table, WriteDb } from "../../database";
import { PublicOperationError } from "../../server";
import { validatePublicValue } from "../../schema";
import { definition, tableDefinitions } from "../declarations";
import { identifier, projection, readValue } from "./selection";

type Execute = (text: string, values?: unknown[]) => Promise<unknown>;
const deny = (): never => { throw new Error("REQUEST_DENIED"); };
function record(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  validatePublicValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value) || (allowed && Object.keys(value).some(key => !allowed.includes(key)))) return deny();
  return value as Record<string, unknown>;
}
type Writes = Pick<WriteDb, "insert" | "updateVersioned" | "deleteVersioned" | "update" | "delete">;
export function writeHelpers(execute: Execute, tables: ReadonlySet<Table>): Writes {
  function declaration(table: Table) {
    const spec = tableDefinitions.get(table);
    if (!spec || spec.alias || !tables.has(table)) return deny();
    return spec;
  }
  function returning(table: Table, raw: unknown) {
    const spec = declaration(table);
    if (!Array.isArray(raw) || !raw.length || new Set(raw).size !== raw.length || raw.some(key => typeof key !== "string" || !Object.hasOwn(spec.columns, key))) return deny();
    const fields = raw as string[];
    return {
      sql: fields.map(key => `${projection(identifier(key), spec.columns[key]!)} AS ${identifier(key)}`).join(","),
      decode(rows: unknown) {
        if (!Array.isArray(rows) || rows.length !== 1) return deny();
        return Object.fromEntries(fields.map(key => [key, readValue(spec.columns[key]!, rows[0][key], false)]));
      },
    };
  }
  function assignments(table: Table, raw: unknown, insert: boolean) {
    const spec = declaration(table), values = record(raw);
    if (Object.keys(values).some(key => !Object.hasOwn(spec.columns, key))) return deny();
    for (const [key, reference] of Object.entries(spec.columns)) {
      const field = definition(reference);
      if (Object.hasOwn(values, key)) {
        if ((insert ? field.managed : field.managed || field.primary)) return deny();
        field.check.parse(values[key]);
      } else if (insert && !field.generated) return deny();
    }
    if (!insert && !Object.keys(values).length) return deny();
    return values;
  }
  async function change(table: Table, options: unknown, versioned: boolean, remove: boolean) {
    const spec = declaration(table);
    if (spec.versioned !== versioned) return deny();
    const raw = record(options, ["id", ...(versioned ? ["expectedVersion"] : []), ...(remove ? [] : ["set", "returning"])]);
    const [primary, primaryColumn] = Object.entries(spec.columns).find(([, ref]) => definition(ref).primary)!;
    const id = definition(primaryColumn).check.parse(raw.id);
    if (versioned && (!Number.isSafeInteger(raw.expectedVersion) || Number(raw.expectedVersion) < 1)) return deny();
    const values = remove ? {} : assignments(table, raw.set, false);
    const output = remove ? undefined : returning(table, raw.returning);
    const name = `"public".${identifier(spec.name)}`, key = identifier(primary);
    // The row lock spans the comparison and write in the one owned transaction.
    // A waiter sees the winning committed version under Read Committed.
    const locked = await execute(`SELECT ${versioned ? '"version"::text AS version' : key} FROM ${name} WHERE ${key}=$1 FOR UPDATE`, [id]);
    if (!Array.isArray(locked) || locked.length === 0) throw new PublicOperationError("NOT_FOUND");
    if (locked.length !== 1) return deny();
    if (versioned && Number(locked[0].version) !== raw.expectedVersion) throw new PublicOperationError("VERSION_CONFLICT");
    if (versioned && !remove && Number(locked[0].version) >= Number.MAX_SAFE_INTEGER) throw new PublicOperationError("CONSTRAINT_CONFLICT");
    const parameters: unknown[] = [id];
    const predicate = `${key}=$1${versioned ? ' AND "version"=$2' : ""}`;
    if (versioned) parameters.push(raw.expectedVersion);
    if (remove) {
      const rows = await execute(`DELETE FROM ${name} WHERE ${predicate} RETURNING ${key}`, parameters);
      if (!Array.isArray(rows) || rows.length !== 1) return deny();
      return { deleted: true };
    }
    const set = Object.entries(values).map(([field, value]) => { parameters.push(value); return `${identifier(field)}=$${parameters.length}`; });
    if (versioned) set.push('"version"="version"+1');
    return output!.decode(await execute(`UPDATE ${name} SET ${set.join(",")} WHERE ${predicate} RETURNING ${output!.sql}`, parameters));
  }
  return {
    async insert(table, options) {
      const spec = declaration(table), raw = record(options, ["values", "returning"]);
      const values = assignments(table, raw.values, true), output = returning(table, raw.returning);
      const names = Object.keys(values);
      const sql = `INSERT INTO "public".${identifier(spec.name)} ${names.length ? `(${names.map(identifier).join(",")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(",")})` : "DEFAULT VALUES"} RETURNING ${output.sql}`;
      return output.decode(await execute(sql, Object.values(values))) as never;
    },
    updateVersioned: async (table, options) => await change(table, options, true, false) as never,
    deleteVersioned: async (table, options) => await change(table, options, true, true) as { deleted: true },
    update: async (table, options) => await change(table, options, false, false) as never,
    delete: async (table, options) => await change(table, options, false, true) as { deleted: true },
  };
}

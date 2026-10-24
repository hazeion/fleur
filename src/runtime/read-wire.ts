import { alias, type Table, type ReadDb, type WriteDb } from "../database";
import { validatePublicValue } from "../schema";
import { references, tableDefinitions } from "./declarations";

function deny(): never { throw new Error("REQUEST_DENIED"); }
export function serialize(value: unknown, depth = 0): unknown {
  if (depth > 64) return deny();
  if (!value || typeof value !== "object") return value;
  const table = tableDefinitions.get(value);
  if (table) return { $table: { name: table.name, ...(table.alias ? { alias: table.alias } : {}) } };
  const column = references.get(value);
  if (column) return { $column: { table: serialize(column.table, depth + 1), field: column.field } };
  if (Array.isArray(value)) return value.map(item => serialize(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item, depth + 1)]));
}
export function workerReadDb(exchange: (request: unknown) => unknown): ReadDb {
  const call = (action: string, args: unknown[]) => {
    const request = { action, args: serialize(args) };
    validatePublicValue(request);
    return exchange(request);
  };
  return Object.freeze({
    select: async (table: Table, options: unknown) => call("select", [table, options]),
    selectJoined: async (options: unknown) => call("selectJoined", [options]),
    cursor: (table: Table, options: unknown) => call("cursor", [table, options]),
    cursorJoined: (options: unknown) => call("cursorJoined", [options]),
  }) as ReadDb;
}
export async function dispatchRead(request: unknown, db: ReadDb, tables: readonly Table[]): Promise<unknown> {
  validatePublicValue(request);
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 1048576) return deny();
  const aliases = new Map<string, Table>();
  const restore = (value: unknown, depth = 0): unknown => {
    if (depth > 64) return deny();
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(item => restore(item, depth + 1));
    if ("$table" in value) {
      if (Object.keys(value).length !== 1 || !value.$table || typeof value.$table !== "object" || Array.isArray(value.$table)) return deny();
      const spec = value.$table as Record<string, unknown>;
      if (Object.keys(spec).some(key => !["name", "alias"].includes(key)) || typeof spec.name !== "string" || (spec.alias !== undefined && typeof spec.alias !== "string")) return deny();
      const table = tables.find(item => tableDefinitions.get(item)?.name === spec.name);
      if (!table) return deny();
      if (typeof spec.alias === "string") {
        const key = `${spec.name}:${spec.alias}`;
        if (!aliases.has(key)) aliases.set(key, alias(table, spec.alias));
        return aliases.get(key)!;
      }
      return table;
    }
    if ("$column" in value) {
      if (Object.keys(value).length !== 1 || !value.$column || typeof value.$column !== "object" || Array.isArray(value.$column)) return deny();
      const spec = value.$column as Record<string, unknown>;
      if (Object.keys(spec).some(key => !["table", "field"].includes(key)) || typeof spec.field !== "string") return deny();
      const table = restore(spec.table, depth + 1);
      if (!table || typeof table !== "object" || !tableDefinitions.has(table) || !Object.hasOwn(table, spec.field)) return deny();
      return (table as Table)[spec.field];
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item, depth + 1)]));
  };
  if (!request || typeof request !== "object" || Array.isArray(request)) return deny();
  const spec = request as Record<string, unknown>;
  if (Object.keys(spec).some(key => key !== "action" && key !== "args") || !Array.isArray(spec.args)) return deny();
  const args = restore(spec.args) as unknown[];
  if (spec.action === "select" && args.length === 2) return db.select(args[0] as Table, args[1] as Parameters<ReadDb["select"]>[1]);
  if (spec.action === "selectJoined" && args.length === 1) return db.selectJoined(args[0] as Parameters<ReadDb["selectJoined"]>[0]);
  if (spec.action === "cursor" && args.length === 2) return db.cursor(args[0] as Table, args[1] as Parameters<ReadDb["cursor"]>[1]);
  if (spec.action === "cursorJoined" && args.length === 1) return db.cursorJoined(args[0] as Parameters<ReadDb["cursorJoined"]>[0]);
  return deny();
}

export function workerWriteDb(exchange: (request: unknown) => unknown): WriteDb {
  const writes = Object.fromEntries(["insert", "updateVersioned", "deleteVersioned", "update", "delete"].map(action => [action, async (table: Table, options: unknown) => {
    const request = { action, args: serialize([table, options]) };
    validatePublicValue(request);
    return exchange(request);
  }]));
  return Object.freeze({ ...workerReadDb(exchange), ...writes }) as WriteDb;
}
export async function dispatchWrite(request: unknown, db: WriteDb, tables: readonly Table[]): Promise<unknown> {
  validatePublicValue(request);
  if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).length !== 2) return deny();
  const spec = request as { action: string; args: unknown[] };
  if (!["insert", "updateVersioned", "deleteVersioned", "update", "delete"].includes(spec.action)) return dispatchRead(request, db, tables);
  if (!Array.isArray(spec.args) || spec.args.length !== 2) return deny();
  const raw = spec.args[0];
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1 || !("$table" in raw)) return deny();
  const ref = raw.$table;
  if (!ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).length !== 1 || !("name" in ref)) return deny();
  const table = tables.find(table => tableDefinitions.get(table)?.name === ref.name);
  if (!table) return deny();
  return Reflect.apply(db[spec.action as keyof WriteDb], db, [table, spec.args[1]]);
}

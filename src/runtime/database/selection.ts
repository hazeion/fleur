import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ColumnReference, Filter, Join, Table } from "../../database";
import { definition, references, tableDefinitions } from "../declarations";
import { validatePublicValue } from "../../schema";

interface Selection {
  readonly from: Table;
  readonly joins: readonly Join[];
  readonly fields: Readonly<Record<string, ColumnReference>>;
  readonly where?: Filter;
  readonly orderBy?: readonly { column: ColumnReference; direction: "asc" | "desc" }[];
  readonly limit?: number;
  readonly cursor?: string;
}
function deny(): never { throw new Error("REQUEST_DENIED"); }
function identifier(name: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(name)) deny();
  return `"${name}"`;
}
function projection(name: string, column: ColumnReference): string {
  const kind = definition(column).kind;
  if (kind === "timestamp") return `to_char(${name} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  if (kind === "localDate" || kind === "decimal" || kind === "safeInteger") return `${name}::text`;
  return name;
}
function readValue(column: ColumnReference, value: unknown, nullable: boolean): unknown {
  const spec = definition(column);
  if (nullable && value === null) return null;
  if (spec.kind === "safeInteger" && typeof value === "string" && /^-?[0-9]+$/.test(value)) value = Number(value);
  return spec.check.parse(value);
}
export interface QueryIdentity { readonly operation: string; readonly input: unknown; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function compileRead(options: Selection, admitted: ReadonlySet<Table>, cursorKey: Uint8Array, identity: QueryIdentity = { operation: "internal", input: {} }) {
  validatePublicValue(identity);
  if (!options || Object.keys(options).some(key => !["from", "joins", "fields", "where", "orderBy", "limit", "cursor"].includes(key))) deny();
  if (options.where !== undefined && (!options.where || typeof options.where !== "object" || Array.isArray(options.where))) deny();
  if (options.orderBy !== undefined && !Array.isArray(options.orderBy)) deny();
  const limit = options.limit === undefined ? 100 : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("QUERY_LIMIT");
  if (!Array.isArray(options.joins) || options.joins.length > 16 || !options.fields || !Object.keys(options.fields).length || Object.keys(options.fields).length > 100) deny();
  const tables = [options.from, ...options.joins.map(join => join.table)];
  const nullable = new Set(options.joins.filter(join => join.type === "left").map(join => join.table));
  const names = new Set<string>();
  const allowed = new Set<Table>();
  const tableSql = (table: Table): string => {
    const spec = tableDefinitions.get(table);
    if (!spec || !admitted.has(spec.source ?? table)) deny();
    const name = spec.alias ?? spec.name;
    if (names.has(name) || allowed.has(table)) deny();
    names.add(name);
    allowed.add(table);
    return `"public".${identifier(spec.name)} AS ${identifier(name)}`;
  };
  const column = (reference: ColumnReference): string => {
    const ref = references.get(reference);
    if (!ref || !allowed.has(ref.table)) deny();
    const spec = tableDefinitions.get(ref.table)!;
    return `${identifier(spec.alias ?? spec.name)}.${identifier(ref.field)}`;
  };
  const values: unknown[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  let count = 0;
  const filterSql = (filter: Filter, depth = 0): string => {
    if (depth > 20 || ++count > 100 || !filter || typeof filter !== "object") deny();
    if (filter.operator === "and" || filter.operator === "or") {
      if (!Array.isArray(filter.filters) || !filter.filters.length || Object.keys(filter).some(key => key !== "operator" && key !== "filters")) deny();
      return `(${filter.filters.map(item => filterSql(item, depth + 1)).join(filter.operator === "and" ? " AND " : " OR ")})`;
    }
    if (!("column" in filter)) deny();
    const name = column(filter.column);
    const check = definition(filter.column).check;
    if (filter.operator === "isNull") {
      if (Object.keys(filter).some(key => key !== "operator" && key !== "column")) deny();
      return `${name} IS NULL`;
    }
    if (filter.operator === "in") {
      if (!Array.isArray(filter.values) || !filter.values.length || filter.values.length > 500 || Object.keys(filter).some(key => !["operator", "column", "values"].includes(key))) deny();
      return `${name} IN (${filter.values.map(value => bind(check.parse(value))).join(",")})`;
    }
    const operators = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };
    const operator = operators[filter.operator];
    if (!operator || Object.keys(filter).some(key => !["operator", "column", "value"].includes(key))) deny();
    if (filter.value === null) {
      check.parse(null);
      if (filter.operator !== "eq" && filter.operator !== "ne") deny();
      return `${name} IS ${filter.operator === "ne" ? "NOT " : ""}NULL`;
    }
    let right: string;
    if (filter.value && typeof filter.value === "object" && references.has(filter.value)) {
      if (definition(filter.column).kind !== definition(filter.value as ColumnReference).kind) deny();
      right = column(filter.value as ColumnReference);
    } else right = bind(check.parse(filter.value));
    return `${name} ${operator} ${right}`;
  };
  let from = tableSql(options.from);
  for (const join of options.joins) {
    if ((join.type !== "left" && join.type !== "inner") || Object.keys(join).some(key => !["type", "table", "on"].includes(key))) deny();
    from += ` ${join.type === "left" ? "LEFT" : "INNER"} JOIN ${tableSql(join.table)} ON ${filterSql(join.on)}`;
  }
  const predicate = options.where ? filterSql(options.where) : "TRUE";
  const order = [...(options.orderBy ?? [])];
  if (order.length > 100 || order.some(item => item.direction !== "asc" && item.direction !== "desc") || new Set(order.map(item => item.column)).size !== order.length) deny();
  for (const table of tables) {
    const primary = Object.values(tableDefinitions.get(table)!.columns).find(value => definition(value).primary);
    if (!primary) deny();
    if (!order.some(item => item.column === primary)) order.push({ column: primary, direction: "asc" });
  }
  const binding = JSON.stringify({ identity: canonical(identity), from, order: order.map(item => [column(item.column), item.direction]), predicate, values });
  const encode = (resolve: (column: ColumnReference) => unknown) => {
    const last = order.map(item => {
      const value = resolve(item.column);
      return value === null && nullable.has(references.get(item.column)!.table) ? null : definition(item.column).check.parse(value);
    });
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", cursorKey, nonce);
    cipher.setAAD(Buffer.from(binding));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ last }), "utf8"), cipher.final()]);
    return ["1", nonce.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  };
  let continuation = "";
  if (options.cursor !== undefined) {
    try {
      if (typeof options.cursor !== "string" || options.cursor.length > 16384) deny();
      const [version, nonce, payload, tag, extra] = options.cursor.split(".");
      if (version !== "1" || !nonce || !payload || !tag || extra !== undefined || [nonce, payload, tag].some(part => !/^[A-Za-z0-9_-]+$/.test(part))) deny();
      const iv = Buffer.from(nonce, "base64url"), auth = Buffer.from(tag, "base64url");
      if (iv.length !== 12 || auth.length !== 16) deny();
      const decipher = createDecipheriv("aes-256-gcm", cursorKey, iv);
      decipher.setAAD(Buffer.from(binding));
      decipher.setAuthTag(auth);
      const decoded: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload, "base64url")), decipher.final()]).toString("utf8"));
      if (!decoded || typeof decoded !== "object" || !("last" in decoded) || !Array.isArray(decoded.last) || decoded.last.length !== order.length) deny();
      const last = decoded.last;
      const equals: string[] = [], alternatives: string[] = [];
      order.forEach((item, index) => {
        const value = last[index] === null && nullable.has(references.get(item.column)!.table) ? null : definition(item.column).check.parse(last[index]);
        const name = column(item.column);
        if (value !== null) alternatives.push(`(${[...equals, `(${name} ${item.direction === "asc" ? ">" : "<"} ${bind(value)} OR ${name} IS NULL)`].join(" AND ")})`);
        if (index < order.length - 1) equals.push(value === null ? `${name} IS NULL` : `${name} = ${bind(value)}`);
      });
      continuation = " AND (" + (alternatives.join(" OR ") || "FALSE") + ")";
    } catch { deny(); }
  }
  const fields = Object.entries(options.fields);
  const sql = `SELECT ${fields.map(([key, ref]) => `${projection(column(ref), ref)} AS ${identifier(key)}`).join(",")} FROM ${from} WHERE ${predicate}${continuation} ORDER BY ${order.map(item => `${column(item.column)} ${item.direction === "asc" ? "ASC" : "DESC"} NULLS LAST`).join(",")} LIMIT ${bind(limit)}`;
  return { sql, values, encode, decode(rows: unknown): Record<string, unknown>[] {
    if (!Array.isArray(rows)) throw new Error("INTERNAL_FAILURE");
    return rows.map(row => {
      if (!row || typeof row !== "object") throw new Error("INTERNAL_FAILURE");
      return Object.fromEntries(fields.map(([key, reference]) => [key, readValue(reference, row[key], nullable.has(references.get(reference)!.table))]));
    });
  } };
}

import type { Table } from "../../database";
import { definition, references, tableDefinitions } from "../declarations";
import { identifier } from "./selection";
import { caseFoldMappings } from "../unicode/case-fold-data";

function literal(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && !value.includes("\0")) return "'" + value.replaceAll("'", "''") + "'";
  throw new Error("Invalid database default");
}
/** Trusted schema compiler. Execution/maintenance authorization belongs to migrations. */
export function tableDDL(tables: readonly Table[]): readonly string[] {
  const statements: string[] = [];
  if (tables.some(table => Object.values(tableDefinitions.get(table)?.columns ?? {}).some(ref => definition(ref).caseFold))) {
    const mappings = caseFoldMappings.map(([point, mapped]) => `WHEN ${point} THEN ${literal(mapped)}`).join("\n");
    statements.push(`CREATE FUNCTION public.fleur_casefold_17(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS $fleur$ DECLARE result text := ''; point text; BEGIN FOR position IN 1..char_length(value) LOOP point := substr(value, position, 1); result := result || CASE ascii(point) ${mappings} ELSE point END; END LOOP; RETURN result; END $fleur$`);
  }
  const constraints: string[] = [];
  for (const table of tables) {
    const spec = tableDefinitions.get(table);
    if (!spec || spec.alias) throw new Error("Invalid table declaration");
    const name = `"public".${identifier(spec.name)}`;
    const columns = Object.entries(spec.columns).map(([field, reference]) => {
      const column = definition(reference), key = identifier(field);
      const type = { uuid: "uuid", string: 'text COLLATE "C"', boolean: "boolean", safeInteger: "bigint", decimal: `numeric(${column.precision},${column.scale})`, localDate: "date", timestamp: "timestamptz" }[column.kind];
      let sql = `${key} ${type}${column.nullable ? "" : " NOT NULL"}${column.primary ? " PRIMARY KEY" : ""}`;
      if (spec.versioned && field === "version") sql += ` DEFAULT 1 CHECK (${key} BETWEEN 1 AND 9007199254740991)`;
      else if (column.defaultNow) sql += " DEFAULT CURRENT_TIMESTAMP";
      else if (Object.hasOwn(column, "defaultValue")) sql += ` DEFAULT ${literal(column.defaultValue)}`;
      else if (column.generated) {
        if (column.kind === "uuid") sql += " DEFAULT gen_random_uuid()";
        else if (column.kind === "safeInteger") sql += " GENERATED ALWAYS AS IDENTITY";
        else throw new Error("Unsupported generated column");
      }
      if (column.kind === "safeInteger" && field !== "version") sql += ` CHECK (${key} BETWEEN -9007199254740991 AND 9007199254740991)`;
      if (column.max !== undefined) sql += ` CHECK (char_length(${key}) <= ${column.max})`;
      if (column.unique) constraints.push(`CREATE UNIQUE INDEX ON ${name} (${column.caseFold ? `public.fleur_casefold_17(${key}) COLLATE "C"` : key})`);
      if (column.reference) {
        const ref = references.get(column.reference.target), target = ref && tableDefinitions.get(ref.table);
        if (!ref || !target || !tables.includes(ref.table)) throw new Error("Unregistered foreign key");
        constraints.push(`ALTER TABLE ${name} ADD FOREIGN KEY (${key}) REFERENCES "public".${identifier(target.name)} (${identifier(ref.field)}) ON DELETE ${column.reference.onDelete.toUpperCase()}`);
      }
      return sql;
    });
    statements.push(`CREATE TABLE ${name} (${columns.join(",")})`);
  }
  return [...statements, ...constraints];
}

import type { Table, ColumnReference } from "../../database";
import { definition, references, tableDefinitions, type IndexKeyDefinition } from "../declarations";
import { identifier } from "./selection";
import { caseFoldMappings } from "../unicode/case-fold-data";
import { createHash } from "node:crypto";

export function databaseLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && !value.includes("\0")) return "'" + value.replaceAll("'", "''") + "'";
  throw new Error("Invalid database default");
}
export function columnType(reference: ColumnReference): string {
  const column=definition(reference);
  return {uuid:"uuid",string:'text COLLATE "C"',boolean:"boolean",safeInteger:"bigint",decimal:`numeric(${column.precision},${column.scale})`,localDate:"date",timestamp:"timestamptz"}[column.kind];
}
export function columnDefault(reference: ColumnReference, managedVersion=false): string | null {
  const column=definition(reference);
  if(managedVersion)return "1";
  if(column.defaultNow)return "CURRENT_TIMESTAMP";
  if(Object.hasOwn(column,"defaultValue"))return databaseLiteral(column.defaultValue);
  if(column.generated&&column.kind==="uuid")return "gen_random_uuid()";
  return null;
}
export function columnDDL(field: string, reference: ColumnReference, managedVersion=false): string {
  const column=definition(reference), fallback=columnDefault(reference,managedVersion);
  let sql=`${identifier(field)} ${columnType(reference)}${column.nullable?"":" NOT NULL"}`;
  if(fallback!==null)sql+=` DEFAULT ${fallback}`;
  else if(column.generated&&column.kind==="safeInteger")sql+=" GENERATED ALWAYS AS IDENTITY";
  else if(column.generated)throw new Error("Unsupported generated column");
  return sql;
}
/** Deterministic name of a Fleur-generated constraint or index; drift detection uses the same names. */
export function constraintName(table: string, field: string, tag: string): string {
  return `fleur_${tag}_${createHash("sha256").update(`${table}\0${field}\0${tag}`).digest("hex").slice(0,20)}`;
}
/** Name key and drift description of a declared index's ordered keys, such as `performedOn desc,id`. */
export function indexKeys(fields: readonly IndexKeyDefinition[], separator = ","): string {
  return fields.map(key => key.direction === "desc" ? `${key.field} desc` : key.field).join(separator);
}
export function tableConstraints(tables: readonly Table[]) {
  const constraints: {table:string;name:string;kind:"foreign"|"constraint"|"index";sql:string}[]=[];
  for(const table of tables) {
    const spec=tableDefinitions.get(table);
    if(!spec||spec.alias)throw new Error("Invalid table declaration");
    const relation=`"public".${identifier(spec.name)}`;
    for(const [field,reference] of Object.entries(spec.columns)) {
      const column=definition(reference),key=identifier(field);
      const add=(kind:"foreign"|"constraint"|"index",tag:string,clause:string)=>{
        const name=constraintName(spec.name,field,tag);
        constraints.push({table:spec.name,name,kind,sql:kind==="index"?`CREATE UNIQUE INDEX ${identifier(name)} ON ${relation} (${clause})`:`ALTER TABLE ${relation} ADD CONSTRAINT ${identifier(name)} ${clause}`});
      };
      if(column.primary)add("constraint","pk",`PRIMARY KEY (${key})`);
      if(spec.versioned&&field==="version")add("constraint","version",`CHECK (${key} BETWEEN 1 AND 9007199254740991)`);
      else if(column.kind==="safeInteger")add("constraint","safe",`CHECK (${key} BETWEEN -9007199254740991 AND 9007199254740991)`);
      if(column.max!==undefined)add("constraint","max",`CHECK (char_length(${key}) <= ${column.max})`);
      if(column.unique)add("index","unique",column.caseFold?`public.fleur_casefold_17(${key}) COLLATE "C"`:key);
      if(column.reference) {
        const ref=references.get(column.reference.target),target=ref&&tableDefinitions.get(ref.table);
        if(!ref||!target||!tables.includes(ref.table))throw new Error("Unregistered foreign key");
        add("foreign","fk",`FOREIGN KEY (${key}) REFERENCES "public".${identifier(target.name)} (${identifier(ref.field)}) ON DELETE ${column.reference.onDelete.toUpperCase()}`);
      }
    }
    // Fleur orders nulls last in both directions; a descending key does too, so the index matches Fleur's ORDER BY.
    for(const fields of spec.indexes) {
      const name=constraintName(spec.name,indexKeys(fields),"index");
      constraints.push({table:spec.name,name,kind:"index",sql:`CREATE INDEX ${identifier(name)} ON ${relation} (${fields.map(key=>identifier(key.field)+(key.direction==="desc"?" DESC NULLS LAST":"")).join(", ")})`});
    }
  }
  return [...constraints.filter(item=>item.kind!=="foreign"),...constraints.filter(item=>item.kind==="foreign")];
}
/** Trusted schema compiler. Execution/maintenance authorization belongs to migrations. */
export function tableDDL(tables: readonly Table[]): readonly string[] {
  const statements:string[]=[];
  if(tables.some(table=>Object.values(tableDefinitions.get(table)?.columns??{}).some(ref=>definition(ref).caseFold))) {
    const mappings=caseFoldMappings.map(([point,mapped])=>`WHEN ${point} THEN ${databaseLiteral(mapped)}`).join("\n");
    statements.push(`CREATE FUNCTION public.fleur_casefold_17(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS $fleur$ DECLARE result text := ''; point text; BEGIN FOR position IN 1..char_length(value) LOOP point := substr(value, position, 1); result := result || CASE ascii(point) ${mappings} ELSE point END; END LOOP; RETURN result; END $fleur$`);
  }
  for(const table of tables) {
    const spec=tableDefinitions.get(table);
    if(!spec||spec.alias)throw new Error("Invalid table declaration");
    statements.push(`CREATE TABLE "public".${identifier(spec.name)} (${Object.entries(spec.columns).map(([field,reference])=>columnDDL(field,reference,spec.versioned&&field==="version")).join(",")})`);
  }
  return [...statements,...tableConstraints(tables).map(item=>item.sql)];
}

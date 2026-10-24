import { column, defineTable, type ColumnReference, type Table, type DeleteAction } from "../database";
import { validatePublicValue } from "../schema";
import { definition, definitions, references, tableDefinitions } from "./declarations";

interface ColumnBuilder extends ColumnReference {
  nullable(): ColumnBuilder;
  primaryKey(): ColumnBuilder;
  generated(): ColumnBuilder;
  default(value: never): ColumnBuilder;
}
interface WireColumn {
  readonly kind: string;
  readonly primary: boolean;
  readonly nullable: boolean;
  readonly generated: boolean;
  readonly max?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly defaultValue?: unknown;
  readonly defaultNow?: true;
  readonly reference?: { readonly table: string; readonly field: string; readonly onDelete: DeleteAction };
}
interface WireTable { readonly name: string; readonly versioned: boolean; readonly columns: Readonly<Record<string, WireColumn>>; }
const fail = (): never => { throw new Error("SOURCE_REJECTED"); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail();
}
export function describeTables(tables: readonly Table[]): readonly WireTable[] {
  return tables.map(table => {
    const declared = tableDefinitions.get(table);
    if (!declared || declared.alias) return fail();
    return { name: declared.name, versioned: declared.versioned, columns: Object.fromEntries(Object.entries(declared.columns)
      .filter(([name]) => !(declared.versioned && name === "version"))
      .map(([name, value]) => {
        const { check, reference, ...fields } = definition(value);
        void check;
        if (!reference) return [name, fields];
        const target = references.get(reference.target);
        const targetTable = target && tableDefinitions.get(target.table);
        if (!target || !targetTable || !tables.includes(target.table)) return fail();
        return [name, { ...fields, reference: { table: targetTable.name, field: target.field, onDelete: reference.onDelete } }];
      })) };
  });
}
/** The host rebuilds declaration objects without evaluating application modules. */
export function restoreTables(input: unknown): readonly Table[] {
  validatePublicValue(input);
  if (!Array.isArray(input) || input.length > 256 || new TextEncoder().encode(JSON.stringify(input)).length > 1048576) return fail();
  const pending: { column: ColumnReference; reference: Record<string, unknown> }[] = [];
  const byName = new Map<string, Table>();
  for (const raw of input) {
    const spec = record(raw);
    keys(spec, ["name", "versioned", "columns"]);
    if (typeof spec.name !== "string" || typeof spec.versioned !== "boolean" || byName.has(spec.name)) return fail();
    const fields = record(spec.columns);
    if (Object.keys(fields).length > 256) return fail();
    const columns: Record<string, ColumnReference> = {};
    const links: [string, Record<string, unknown>][] = [];
    for (const [name, rawColumn] of Object.entries(fields)) {
      const field = record(rawColumn);
      keys(field, ["kind", "nullable", "primary", "generated", "max", "precision", "scale", "defaultValue", "defaultNow", "reference"]);
      if ([field.nullable, field.primary, field.generated].some(flag => typeof flag !== "boolean")) return fail();
      let value: ColumnBuilder;
      switch (field.kind) {
        case "uuid": value = column.uuid(); break;
        case "string": value = field.max === undefined ? column.string() : column.string().max(field.max as number); break;
        case "boolean": value = column.boolean(); break;
        case "safeInteger": value = column.safeInteger(); break;
        case "decimal": value = column.decimal({ precision: field.precision as number, scale: field.scale as number }); break;
        case "localDate": value = column.localDate(); break;
        case "timestamp": value = field.defaultNow === true ? column.timestamp().defaultNow() : column.timestamp(); break;
        default: return fail();
      }
      if ((field.max !== undefined && field.kind !== "string") || ((field.precision !== undefined || field.scale !== undefined) && field.kind !== "decimal") || (field.defaultNow !== undefined && (field.defaultNow !== true || field.kind !== "timestamp" || !field.generated))) return fail();
      if (field.nullable) value = value.nullable();
      if (field.primary) value = value.primaryKey();
      if (field.generated) value = value.generated();
      if (Object.hasOwn(field, "defaultValue")) {
        if (!field.generated || field.defaultNow) return fail();
        value = value.default(field.defaultValue as never);
      }
      columns[name] = value;
      if (field.reference !== undefined) links.push([name, record(field.reference)]);
    }
    const table = defineTable(spec.name, { columns, versioned: spec.versioned });
    byName.set(spec.name, table);
    for (const [name, reference] of links) pending.push({ column: table[name]!, reference });
  }
  for (const { column: source, reference } of pending) {
    keys(reference, ["table", "field", "onDelete"]);
    if (typeof reference.table !== "string" || typeof reference.field !== "string" || !["restrict", "cascade", "set null"].includes(reference.onDelete as string)) return fail();
    const target = byName.get(reference.table)?.[reference.field];
    const own = definition(source);
    if (!target || !definition(target).primary || definition(target).kind !== own.kind || (reference.onDelete === "set null" && !own.nullable)) return fail();
    definitions.set(source, Object.freeze({ ...own, reference: Object.freeze({ target, onDelete: reference.onDelete as DeleteAction }) }));
  }
  return Object.freeze([...byName.values()]);
}

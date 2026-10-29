import { column, defineTable, type ColumnReference, type ColumnShape, type Table, type TableIndex, type DeleteAction } from "../database";
import { validatePublicValue } from "../schema";
import { rehydratingTable, definition, definitions, references, tableDefinitions } from "./declarations";

interface ColumnBuilder extends ColumnReference {
  nullable(): ColumnBuilder;
  unique(options?: { caseFold?: boolean }): ColumnBuilder;
  primaryKey(): ColumnBuilder;
  generated(): ColumnBuilder;
  default(value: never): ColumnBuilder;
}
interface WireColumn {
  readonly kind: string;
  readonly primary: boolean;
  readonly nullable: boolean;
  readonly generated: boolean;
  readonly managed?: true;
  readonly unique?: true;
  readonly caseFold?: true;
  readonly max?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly defaultValue?: unknown;
  readonly defaultNow?: true;
  readonly reference?: { readonly table: string; readonly field: string; readonly onDelete: DeleteAction };
}
interface WireIndex { readonly fields: readonly { readonly field: string; readonly direction: "asc" | "desc" }[] }
/** `indexes` is present only when the table declares one, so snapshots of earlier releases stay byte-identical. */
interface WireTable { readonly name: string; readonly versioned: boolean; readonly columns: Readonly<Record<string, WireColumn>>; readonly indexes?: readonly WireIndex[] }
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
    const indexes = declared.indexes.length ? { indexes: declared.indexes.map(fields => ({ fields: fields.map(({ field, direction }) => ({ field, direction })) })) } : {};
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
      })), ...indexes };
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
    keys(spec, ["name", "versioned", "columns", "indexes"]);
    // Only the canonical form crosses the wire: a non-empty list of { fields: [{ field, direction }] }.
    if (spec.indexes !== undefined && (!Array.isArray(spec.indexes) || !spec.indexes.length)) return fail();
    // defineTable validates directions, field names, repetition and redundancy exactly as for source declarations.
    const indexes = spec.indexes === undefined ? undefined : (spec.indexes as unknown[]).map((raw): TableIndex<ColumnShape> => {
      const index = record(raw);
      keys(index, ["fields"]);
      if (!Array.isArray(index.fields)) return fail();
      return { fields: index.fields.map((rawKey: unknown) => {
        const key = record(rawKey);
        keys(key, ["field", "direction"]);
        if (typeof key.field !== "string" || typeof key.direction !== "string") return fail();
        return { field: key.field, direction: key.direction as "asc" };
      }) as unknown as TableIndex<ColumnShape>["fields"] };
    });
    if (typeof spec.name !== "string" || typeof spec.versioned !== "boolean" || byName.has(spec.name)) return fail();
    const fields = record(spec.columns);
    if (Object.keys(fields).length > 256) return fail();
    const columns: Record<string, ColumnReference> = {};
    const links: [string, Record<string, unknown>][] = [];
    for (const [name, rawColumn] of Object.entries(fields)) {
      const field = record(rawColumn);
      keys(field, ["kind", "nullable", "primary", "generated", "max", "precision", "scale", "defaultValue", "defaultNow", "reference", "unique", "caseFold", "managed"]);
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
      if ((field.unique !== undefined && field.unique !== true) || (field.caseFold !== undefined && (field.caseFold !== true || !field.unique || field.kind !== "string"))) return fail();
      if (field.unique) value = value.unique(field.caseFold ? { caseFold: true } : {});
      if (field.nullable) value = value.nullable();
      if (field.primary) value = value.primaryKey();
      if (field.managed !== undefined && (field.managed !== true || !field.generated || Object.hasOwn(field, "defaultValue") || field.defaultNow)) return fail();
      if (field.managed) value = value.generated();
      else if (field.generated && !Object.hasOwn(field, "defaultValue") && !field.defaultNow) return fail();
      if (Object.hasOwn(field, "defaultValue")) {
        if (!field.generated || field.defaultNow) return fail();
        value = value.default(field.defaultValue as never);
      }
      columns[name] = value;
      if (field.reference !== undefined) links.push([name, record(field.reference)]);
    }
    const options={columns,versioned:spec.versioned,...(indexes?{indexes}:{}),[rehydratingTable]:true};
    const table = defineTable(spec.name,options);
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

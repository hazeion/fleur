const columnAuthority = Symbol();
import { schema, type Schema, type UUID, type LocalDate, type Timestamp, type DecimalString } from "./schema";

export interface ColumnReference<T = unknown, G extends boolean = boolean, P extends boolean = boolean, K extends ColumnKind = ColumnKind> { readonly kindType: K; readonly valueType: T; readonly generatedValue: G; readonly primaryValue: P; }
export type ColumnKind = "uuid" | "string" | "boolean" | "safeInteger" | "decimal" | "localDate" | "timestamp";
type KindFor<T> = unknown extends T ? ColumnKind : NonNullable<T> extends UUID ? "uuid" : NonNullable<T> extends LocalDate ? "localDate" : NonNullable<T> extends Timestamp ? "timestamp" : NonNullable<T> extends DecimalString ? "decimal" : NonNullable<T> extends string ? "string" : NonNullable<T> extends number ? "safeInteger" : "boolean";
export type DeleteAction = "restrict" | "cascade" | "set null";
import { definitions, tableDefinitions, references, definition, type ColumnDefinition } from "./runtime/declarations";

class Column<T = unknown, Generated extends boolean = boolean, Primary extends boolean = boolean, Managed extends boolean = false> {
  declare readonly managedValue: Managed;
  declare readonly valueType: T;
  declare readonly kindType: KindFor<T>;
  declare readonly generatedValue: Generated;
  declare readonly primaryValue: Primary;
  constructor(value: ColumnDefinition, authority: symbol) { if (authority !== columnAuthority) throw new Error("Invalid column construction"); definitions.set(this, Object.freeze(value)); Object.freeze(this); }
  unique(options: { caseFold?: boolean } = {}): Column<T, Generated, Primary, Managed> {
    const current = definition(this);
    if (Object.keys(options).some(key => key !== "caseFold") || (options.caseFold !== undefined && typeof options.caseFold !== "boolean") || (options.caseFold && current.kind !== "string")) throw new Error("Invalid uniqueness declaration");
    return new Column({ ...current, unique: true, ...(options.caseFold ? { caseFold: true } : {}) }, columnAuthority);
  }
  nullable(): Column<T | null, Generated, Primary, Managed> {
    const value = definition(this);
    if (value.primary) throw new Error("Primary keys cannot be nullable");
    return new Column({ ...value, nullable: true, check: value.check.nullable() }, columnAuthority);
  }
  primaryKey(): Column<T, Generated, true, Managed> {
    const value = definition(this);
    if (value.nullable) throw new Error("Primary keys cannot be nullable");
    return new Column({ ...value, primary: true }, columnAuthority);
  }
  generated(): Column<T, true, Primary, true> { return new Column({ ...definition(this), generated: true, managed: true }, columnAuthority); }
  default(value: T): Column<T, true, Primary> {
    const { managed, ...current } = definition(this);
    void managed;
    return new Column({ ...current, generated: true, defaultValue: current.check.parse(value) }, columnAuthority);
  }
  references(target: ColumnReference<NonNullable<T>, boolean, boolean, KindFor<T>>, options: { onDelete: null extends T ? DeleteAction : Exclude<DeleteAction, "set null"> }): Column<T, Generated, Primary, Managed> {
    const current = definition(this), foreign = definition(target);
    if (!["restrict", "cascade", "set null"].includes(options.onDelete) || !references.has(target) || current.kind !== foreign.kind || !foreign.primary || (options.onDelete === "set null" && !current.nullable)) throw new Error("Invalid foreign key");
    return new Column({ ...current, reference: Object.freeze({ target, onDelete: options.onDelete }) }, columnAuthority);
  }
}
class StringColumn extends Column<string, false, false> {
  max(length: number): StringColumn { return new StringColumn({ ...definition(this), check: schema.string().max(length), max: length }, columnAuthority); }
}
class TimestampColumn extends Column<Timestamp, false, false> {
  defaultNow(): Column<Timestamp, true, false> { return new Column({ ...definition(this), generated: true, defaultNow: true }, columnAuthority); }
}
function value<T>(kind: ColumnKind, check: Schema<T>): Column<T, false, false> {
  return new Column({ kind, check, nullable: false, generated: false, primary: false }, columnAuthority);
}
export const column = {
  uuid: () => value<UUID>("uuid", schema.uuid()),
  string: () => new StringColumn({ kind: "string", check: schema.string(), nullable: false, generated: false, primary: false }, columnAuthority),
  boolean: () => value("boolean", schema.boolean()),
  safeInteger: () => value("safeInteger", schema.safeInteger()),
  localDate: () => value<LocalDate>("localDate", schema.localDate()),
  timestamp: () => new TimestampColumn({ kind: "timestamp", check: schema.timestamp(), nullable: false, generated: false, primary: false }, columnAuthority),
  decimal: (options: { precision: number; scale: number }): Column<DecimalString, false, false> => {
    if (!Number.isSafeInteger(options.precision) || !Number.isSafeInteger(options.scale) || options.precision < 1 || options.precision > 1000 || options.scale < 0 || options.scale > options.precision) throw new Error("Invalid decimal column");
    return new Column({ kind: "decimal", check: schema.decimal({ maxScale: options.scale }), nullable: false, generated: false, primary: false, ...options }, columnAuthority);
  },
};
export type ColumnShape = Readonly<Record<string, ColumnReference>>;
declare const tableType: unique symbol;
export type Table<C extends ColumnShape = ColumnShape, V extends boolean = boolean, Name extends string = string> = { readonly [K in keyof C]: C[K] & { readonly relationName: Name; readonly fieldName: K } } & (V extends true ? { readonly version: Column<number, true, false> & { readonly relationName: Name; readonly fieldName: "version" } } : object) & { readonly [tableType]: { columns: C; versioned: V; name: Name } };
export type Row<T extends Table> = { [K in keyof T[typeof tableType]["columns"]]: T[typeof tableType]["columns"][K] extends ColumnReference<infer Value> ? Value : never } & (T[typeof tableType]["versioned"] extends true ? { version: number } : object);
type DefaultKeys<C extends ColumnShape> = { [K in keyof C]: C[K] extends ColumnReference<unknown, true> ? K : never }[keyof C];
type ManagedKeys<C extends ColumnShape> = { [K in keyof C]: C[K] extends { readonly managedValue: true } ? K : never }[keyof C];
export type Insert<T extends Table, C extends ColumnShape = T[typeof tableType]["columns"]> = { [K in Exclude<keyof C, DefaultKeys<C>>]: C[K] extends ColumnReference<infer Value> ? Value : never } & { [K in DefaultKeys<C>]?: K extends ManagedKeys<C> ? never : C[K] extends ColumnReference<infer Value> ? Value : never };
export type Selected<R, F extends readonly (keyof R)[]> = Pick<R, F[number]>;
export function defineTable<const C extends ColumnShape, V extends boolean = true, const Name extends string = string>(name: Name, options: { columns: C; versioned?: V }): Table<C, V, Name> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name) || Object.hasOwn(options.columns, "version")) throw new Error("Invalid table declaration");
  const columns: Record<string, ColumnReference> = {};
  let primaryKeys = 0;
  for (const [field, source] of Object.entries(options.columns)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(field)) throw new Error("Invalid column name");
    const current = definition(source);
    if (current.primary) primaryKeys++;
    columns[field] = new Column(current, columnAuthority);
  }
  if (primaryKeys !== 1) throw new Error("Exactly one primary key is required");
  const versioned = options.versioned !== false;
  if (!versioned) console.warn(`Table "${name}" is unversioned. Updates and deletes have no lost-update guarantee.`);
  if (versioned) columns.version = value("safeInteger", schema.safeInteger()).generated();
  const table = Object.freeze(columns) as Table<C, V, Name>;
  tableDefinitions.set(table, Object.freeze({ name, columns: table, versioned }));
  for (const [field, reference] of Object.entries(columns)) references.set(reference, { table, field });
  return table;
}

export type Filter = Readonly<
  | { operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; column: ColumnReference; value: unknown }
  | { operator: "in"; column: ColumnReference; values: readonly unknown[] }
  | { operator: "isNull"; column: ColumnReference }
  | { operator: "and" | "or"; filters: readonly Filter[] }
>;
function comparison<T>(operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte", column: ColumnReference<T>, value: NoInfer<T> | ColumnReference<NoInfer<T>>): Filter {
  if (!references.has(column)) throw new Error("Filter requires a table column");
  if (value && typeof value === "object" && references.has(value)) {
    if (definition(column).kind !== definition(value as ColumnReference).kind) throw new Error("Incompatible filter columns");
  } else definition(column).check.parse(value);
  return Object.freeze({ operator, column, value });
}
export const eq = <T>(column: ColumnReference<T>, value: NoInfer<T> | ColumnReference<NoInfer<T>>) => comparison("eq", column, value);
export const ne = <T>(column: ColumnReference<T>, value: NoInfer<T> | ColumnReference<NoInfer<T>>) => comparison("ne", column, value);
export const lt = <T>(column: ColumnReference<T>, value: NoInfer<T> | ColumnReference<NoInfer<T>>) => comparison("lt", column, value);
export const lte = <T>(column: ColumnReference<T>, value: NoInfer<T> | ColumnReference<NoInfer<T>>) => comparison("lte", column, value);
export const gt = <T>(column: ColumnReference<T>, value: NoInfer<T> | ColumnReference<NoInfer<T>>) => comparison("gt", column, value);
export const gte = <T>(column: ColumnReference<T>, value: NoInfer<T> | ColumnReference<NoInfer<T>>) => comparison("gte", column, value);
export function inArray<T>(column: ColumnReference<T>, values: readonly NoInfer<T>[]): Filter {
  if (!references.has(column) || values.length < 1 || values.length > 500) throw new Error("Invalid filter values");
  return Object.freeze({ operator: "in", column, values: Object.freeze(values.map(item => definition(column).check.parse(item))) });
}
export function isNull(column: ColumnReference): Filter {
  if (!references.has(column)) throw new Error("Null filter requires a table column");
  return Object.freeze({ operator: "isNull", column });
}
function combine(operator: "and" | "or", filters: readonly Filter[]): Filter {
  if (!filters.length || filters.length > 100) throw new Error("Invalid filter arity");
  return Object.freeze({ operator, filters: Object.freeze([...filters]) });
}
export const and = (...filters: Filter[]) => combine("and", filters);
export const or = (...filters: Filter[]) => combine("or", filters);

export interface Relation<T extends Table = Table> { readonly target: T; readonly fields: readonly ColumnReference[]; readonly references: readonly ColumnReference[]; readonly kind: "one" | "many"; }
type TableColumn<T extends Table> = T[keyof T[typeof tableType]["columns"]] & ColumnReference;
type MatchingColumns<F extends readonly ColumnReference[], Target extends Table> = { [K in keyof F]: ColumnReference<NonNullable<F[K]["valueType"]>, boolean, boolean, F[K]["kindType"]> & TableColumn<Target> };
export function defineRelations<T extends Table, R extends Record<string, Relation>>(table: T, build: (helpers: {
  one<Target extends Table, const F extends readonly TableColumn<T>[]>(target: Target, options: { fields: F; references: MatchingColumns<F, NoInfer<Target>> }): Relation<Target>;
  many<Target extends Table>(target: Target): Relation<Target>;
}) => R): Readonly<R> {
  if (!tableDefinitions.has(table)) throw new Error("Invalid relation source");
  const result = build({
    one(target, options) {
      if (!tableDefinitions.has(target) || !options.fields.length || options.fields.length !== options.references.length) throw new Error("Invalid relation");
      options.fields.forEach((field, index) => {
        const reference = options.references[index];
        if (!reference || references.get(field)?.table !== table || references.get(reference)?.table !== target || definition(field).reference?.target !== reference) throw new Error("Relation must use a declared foreign key");
      });
      return Object.freeze({ target, fields: Object.freeze([...options.fields]), references: Object.freeze([...options.references]), kind: "one" });
    },
    many(target) {
      const columns = tableDefinitions.get(target)?.columns;
      const pairs = Object.values(columns ?? {}).filter(field => {
        const reference = definition(field).reference?.target;
        return reference && references.get(reference)?.table === table;
      });
      if (pairs.length !== 1) throw new Error("Many relation requires one unambiguous foreign key");
      return Object.freeze({ target, fields: Object.freeze([definition(pairs[0]!).reference!.target]), references: Object.freeze(pairs), kind: "many" });
    },
  });
  return Object.freeze(result);
}

export type { Column, StringColumn, TimestampColumn };
for (const constructor of [Column, StringColumn, TimestampColumn]) { Object.freeze(constructor.prototype); Object.freeze(constructor); }
Object.freeze(column);

export interface Order<R> { readonly field: keyof R & string; readonly direction: "asc" | "desc"; }
export type Cursor<T extends Table> = string & { readonly table?: T };
export interface SelectOptions<R, F extends readonly (keyof R)[], T extends Table = Table> {
  readonly fields: F;
  readonly where?: Filter;
  readonly orderBy?: readonly Order<R>[];
  readonly limit?: number;
  readonly cursor?: Cursor<T>;
}
export interface Join { readonly type: "inner" | "left"; readonly table: Table; readonly on: Filter; }
export type JoinedProjection<P extends Readonly<Record<string, ColumnReference>>, J extends readonly Join[]> = { [K in keyof P]: P[K]["valueType"] | (P[K] extends { readonly relationName: LeftNames<J[number]> } ? null : never) };
type LeftNames<J> = J extends { type: infer Kind; table: infer T extends Table } ? "left" extends Kind ? T[typeof tableType]["name"] : never : never;
export interface JoinedOptions<P extends Readonly<Record<string, ColumnReference>>, J extends readonly Join[]> {
  readonly from: Table;
  readonly joins: J;
  readonly fields: P;
  readonly where?: Filter;
  readonly orderBy?: readonly { readonly column: ColumnReference; readonly direction: "asc" | "desc" }[];
  readonly limit?: number;
  readonly cursor?: string;
}
export function alias<T extends Table, const Name extends string>(table: T, name: Name): Table<T[typeof tableType]["columns"], T[typeof tableType]["versioned"], Name> {
  const source = tableDefinitions.get(table);
  if (!source || !/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(name)) throw new Error("Invalid table alias");
  const columns = Object.fromEntries(Object.entries(source.columns).map(([key, value]) => [key, new Column(definition(value), columnAuthority)]));
  const result = Object.freeze(columns) as Table<T[typeof tableType]["columns"], T[typeof tableType]["versioned"], Name>;
  tableDefinitions.set(result, { ...source, columns: result, alias: name, source: source.source ?? table });
  for (const [field, reference] of Object.entries(columns)) references.set(reference, { table: result, field });
  return result;
}
export interface ReadDb {
  selectJoined<const P extends Readonly<Record<string, ColumnReference>>, const J extends readonly Join[]>(options: JoinedOptions<P, J>): Promise<JoinedProjection<P, J>[]>;
  cursorJoined<const P extends Readonly<Record<string, ColumnReference>>, const J extends readonly Join[]>(options: Omit<JoinedOptions<P, J>, "cursor" | "limit"> & { readonly after: JoinedProjection<P, J> }): string;
  cursor<T extends Table>(table: T, options: { readonly where?: Filter; readonly orderBy?: readonly Order<Row<T>>[]; readonly after: Partial<Row<T>> }): Cursor<T>;
  select<T extends Table, const F extends readonly (keyof Row<T>)[]>(table: T, options: SelectOptions<Row<T>, F, NoInfer<T>>): Promise<Selected<Row<T>, F>[]>;
}

export type PrimaryKey<T extends Table> = { [K in keyof T[typeof tableType]["columns"]]: T[typeof tableType]["columns"][K] extends ColumnReference<infer Value, boolean, true> ? Value : never }[keyof T[typeof tableType]["columns"]];
type PrimaryKeys<C extends ColumnShape> = { [K in keyof C]: C[K] extends ColumnReference<unknown, boolean, true> ? K : never }[keyof C];
export type WriteValues<T extends Table> = { [K in keyof Row<T>]?: K extends ManagedKeys<T[typeof tableType]["columns"]> | PrimaryKeys<T[typeof tableType]["columns"]> | "version" ? never : Row<T>[K] };
export interface WriteDb extends ReadDb {
  insert<T extends Table, const F extends readonly (keyof Row<T>)[]>(table: T, options: { values: Insert<NoInfer<T>>; returning: F }): Promise<Selected<Row<T>, F>>;
  updateVersioned<T extends Table<ColumnShape, true>, const F extends readonly (keyof Row<T>)[]>(table: T, options: { id: PrimaryKey<NoInfer<T>>; expectedVersion: number; set: WriteValues<NoInfer<T>>; returning: F }): Promise<Selected<Row<T>, F>>;
  deleteVersioned<T extends Table<ColumnShape, true>>(table: T, options: { id: PrimaryKey<NoInfer<T>>; expectedVersion: number }): Promise<{ deleted: true }>;
  /** Unversioned writes have no lost-update guarantee. */
  update<T extends Table<ColumnShape, false>, const F extends readonly (keyof Row<T>)[]>(table: T, options: { id: PrimaryKey<NoInfer<T>>; set: WriteValues<NoInfer<T>>; returning: F }): Promise<Selected<Row<T>, F>>;
  /** Unversioned writes have no lost-update guarantee. */
  delete<T extends Table<ColumnShape, false>>(table: T, options: { id: PrimaryKey<NoInfer<T>> }): Promise<{ deleted: true }>;
}

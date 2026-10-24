import { validateContinuation } from "./runtime/query-identity";
const schemaAuthority = Symbol();
import { z } from "zod";
import { described, description } from "./runtime/schema-descriptions";

import { validators, objectFields, routeSchemas } from "./runtime/schema-metadata";
export type Infer<S extends Schema> = S extends Schema<infer T, boolean> ? T : never;
export type SchemaShape = Readonly<Record<string, Schema>>;
type OptionalKeys<S extends SchemaShape> = { [K in keyof S]: S[K] extends Schema<unknown, true> ? K : never }[keyof S];
export type ObjectInfer<S extends SchemaShape> = { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> };

function validator(value: Schema): z.ZodType {
  const result = validators.get(value);
  if (!result) throw new Error("Invalid schema");
  return result;
}
export function validatePublicValue(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 100) throw new Error("Public value nesting limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return;
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("Unsupported public value");
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Unsupported public object");
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) throw new Error("Sparse or extended public array");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) throw new Error("Unsupported public key");
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !property.enumerable || !("value" in property)) throw new Error("Unsupported public property");
      validatePublicValue(property.value, ancestors, depth + 1);
    }
  } finally { ancestors.delete(value); }
}
class Schema<T = unknown, Optional extends boolean = boolean> {
  declare readonly valueType: T;
  declare readonly omitted: Optional;
  constructor(check: z.ZodType, authority: symbol) { if (authority !== schemaAuthority) throw new Error("Invalid schema construction"); validators.set(this, check); Object.freeze(this); }
  parse(value: unknown): T {
    validatePublicValue(value);
    return validator(this).parse(value) as T;
  }
  optional(): Schema<T, true> { return described(new Schema(validator(this).optional(), schemaAuthority), { ...description(this), optional: true }); }
  nullable(): Schema<T | null, Optional> { return described(new Schema(validator(this).nullable(), schemaAuthority), { ...description(this), nullable: true }); }
}
declare const scalarBrand: unique symbol;
export type UUID = string & { readonly [scalarBrand]: "UUID" };
export type LocalDate = string & { readonly [scalarBrand]: "LocalDate" };
export type Timestamp = string & { readonly [scalarBrand]: "Timestamp" };
export type DecimalString = string & { readonly [scalarBrand]: "DecimalString" };

function bound(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid schema bound");
  return value;
}
class StringSchema extends Schema<string, false> {
  min(length: number): StringSchema { bound(length); return described(new StringSchema(validator(this).refine(value => typeof value === "string" && Array.from(value).length >= length), schemaAuthority), { ...description(this), min: Math.max(description(this).min ?? 0, length) }); }
  max(length: number): StringSchema { bound(length); return described(new StringSchema(validator(this).refine(value => typeof value === "string" && Array.from(value).length <= length), schemaAuthority), { ...description(this), max: Math.min(description(this).max ?? Infinity, length) }); }
}
class NumberSchema extends Schema<number, false> {
  min(minimum: number): NumberSchema { validatePublicValue(minimum); return described(new NumberSchema(validator(this).refine(value => typeof value === "number" && value >= minimum), schemaAuthority), { ...description(this), min: Math.max(description(this).min ?? -Number.MAX_SAFE_INTEGER, minimum) }); }
  max(maximum: number): NumberSchema { validatePublicValue(maximum); return described(new NumberSchema(validator(this).refine(value => typeof value === "number" && value <= maximum), schemaAuthority), { ...description(this), max: Math.min(description(this).max ?? Number.MAX_SAFE_INTEGER, maximum) }); }
}
class ArraySchema<T> extends Schema<T[], false> {
  min(length: number): ArraySchema<T> { bound(length); return described(new ArraySchema<T>(validator(this).refine(value => Array.isArray(value) && value.length >= length), schemaAuthority), { ...description(this), min: Math.max(description(this).min ?? 0, length) }); }
  max(length: number): ArraySchema<T> { bound(length); return described(new ArraySchema<T>(validator(this).refine(value => Array.isArray(value) && value.length <= length), schemaAuthority), { ...description(this), max: Math.min(description(this).max ?? Infinity, length) }); }
}
function calendar(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}
export const schema = {
  object<const S extends SchemaShape>(shape: S): Schema<ObjectInfer<S>, false> {
    if (Object.hasOwn(shape, "__proto__")) throw new Error("Unsupported schema property");
    const result = new Schema<ObjectInfer<S>, false>(z.strictObject(Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, validator(value)]))), schemaAuthority);
    objectFields.set(result, Object.freeze(Object.keys(shape)));
    if (Object.values(shape).every(value => ["string", "enum"].includes(validator(value).def.type))) routeSchemas.add(result);
    return described(result, { type: "object", properties: Object.freeze(Object.fromEntries(Object.entries(shape).map(([key, item]) => [key, description(item)]))) });
  },
  string: (): StringSchema => described(new StringSchema(z.string(), schemaAuthority), { type: "string" }),
  number: (): NumberSchema => described(new NumberSchema(z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), schemaAuthority), { type: "number" }),
  safeInteger: (): NumberSchema => described(new NumberSchema(z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), schemaAuthority), { type: "integer" }),
  uuid: (): Schema<UUID, false> => described(new Schema<UUID, false>(z.uuid(), schemaAuthority), { type: "uuid" }),
  localDate: (): Schema<LocalDate, false> => described(new Schema<LocalDate, false>(z.string().refine(calendar), schemaAuthority), { type: "localDate" }),
  timestamp: (): Schema<Timestamp, false> => described(new Schema<Timestamp, false>(z.string().refine(value => {
    const match = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?Z$/.exec(value);
    return !!match && calendar(match[1]!) && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60;
  }), schemaAuthority), { type: "timestamp" }),
  decimal: (options: { maxScale: number; nonnegative?: boolean }): Schema<DecimalString, false> => {
    const { maxScale, nonnegative } = options;
    bound(maxScale);
    return described(new Schema<DecimalString, false>(z.string().refine(value => /^-?[0-9]+(?:\.[0-9]+)?$/.test(value) && (!nonnegative || !value.startsWith("-")) && (value.split(".")[1]?.length ?? 0) <= maxScale), schemaAuthority), { type: "decimal", maxScale, nonnegative: nonnegative === true });
  },
  enum: <const V extends readonly [string, ...string[]]>(values: V): Schema<V[number], false> => described(new Schema<V[number], false>(z.enum([...values]), schemaAuthority), { type: "enum", values: Object.freeze([...values]) }),
  array: <S extends Schema>(item: S): ArraySchema<Infer<S>> => described(new ArraySchema<Infer<S>>(z.array(validator(item)), schemaAuthority), { type: "array", item: description(item) }),
  boolean: (): Schema<boolean, false> => described(new Schema<boolean, false>(z.boolean(), schemaAuthority), { type: "boolean" }),
};

export interface Query<I = unknown, O = unknown> {
  readonly kind: "query";
  readonly name?: string;
  readonly input: Schema<I>;
  readonly output: Schema<O>;
}
export type Input<Q extends Query> = Q extends Query<infer I, unknown> ? I : never;
export type Output<Q extends Query> = Q extends Query<unknown, infer O> ? O : never;
export function defineQuery<I, O>(options: { name?: string; input: Schema<I>; output: Schema<O> }): Query<I, O> {
  if (options.name !== undefined && !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(options.name)) throw new Error("Invalid query name");
  validator(options.input);
  validator(options.output);
  validateContinuation(options.input);
  if (Object.keys(options).some(key => !["name", "input", "output"].includes(key))) throw new Error("Invalid query fields");
  return Object.freeze({ kind: "query", input: options.input, output: options.output, ...(options.name === undefined ? {} : { name: options.name }) });
}

export type { Schema, StringSchema, NumberSchema, ArraySchema };
for (const constructor of [Schema, StringSchema, NumberSchema, ArraySchema]) { Object.freeze(constructor.prototype); Object.freeze(constructor); }
Object.freeze(schema);

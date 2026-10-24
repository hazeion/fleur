export type SchemaDescription = Readonly<{
  type: "string" | "number" | "integer" | "boolean" | "uuid" | "localDate" | "timestamp" | "decimal" | "enum" | "object" | "array";
  optional?: boolean;
  nullable?: boolean;
  min?: number;
  max?: number;
  maxScale?: number;
  nonnegative?: boolean;
  values?: readonly string[];
  properties?: Readonly<Record<string, SchemaDescription>>;
  item?: SchemaDescription;
}>;
export const descriptions = new WeakMap<object, SchemaDescription>();
export function description(value: object): SchemaDescription {
  const result = descriptions.get(value);
  if (!result) throw new Error("Invalid schema description");
  return result;
}
export function described<T extends object>(value: T, specification: SchemaDescription): T {
  descriptions.set(value, Object.freeze(specification));
  return value;
}

import { schema, validatePublicValue, type Schema, type StringSchema, type NumberSchema, type ArraySchema } from "../schema";
import { description, type SchemaDescription } from "./schema-descriptions";

export function describeSchema(value: Schema): SchemaDescription { return description(value); }
export function restoreSchema(input: unknown): Schema {
  validatePublicValue(input);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 1024 * 1024) throw new Error("Invalid schema description");
  let nodes = 0;
  const restore = (value: unknown, depth: number): Schema => {
    if (++nodes > 10000 || depth > 64 || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid schema description");
    const spec = value as Record<string, unknown>;
    const allowed = ["type", "optional", "nullable"];
    for (const flag of ["optional", "nullable"]) if (spec[flag] !== undefined && typeof spec[flag] !== "boolean") throw new Error("Invalid schema flag");
    let result: Schema;
    switch (spec.type) {
      case "string": result = schema.string(); allowed.push("min", "max"); break;
      case "number": result = schema.number(); allowed.push("min", "max"); break;
      case "integer": result = schema.safeInteger(); allowed.push("min", "max"); break;
      case "boolean": result = schema.boolean(); break;
      case "uuid": result = schema.uuid(); break;
      case "localDate": result = schema.localDate(); break;
      case "timestamp": result = schema.timestamp(); break;
      case "decimal":
        allowed.push("maxScale", "nonnegative");
        if (typeof spec.maxScale !== "number" || typeof spec.nonnegative !== "boolean") throw new Error("Invalid decimal schema");
        result = schema.decimal({ maxScale: spec.maxScale, nonnegative: spec.nonnegative });
        break;
      case "enum":
        allowed.push("values");
        if (!Array.isArray(spec.values) || !spec.values.length || spec.values.some(item => typeof item !== "string")) throw new Error("Invalid enum schema");
        result = schema.enum(spec.values as [string, ...string[]]);
        break;
      case "array": result = schema.array(restore(spec.item, depth + 1)); allowed.push("item", "min", "max"); break;
      case "object":
        allowed.push("properties");
        if (!spec.properties || typeof spec.properties !== "object" || Array.isArray(spec.properties)) throw new Error("Invalid object schema");
        result = schema.object(Object.fromEntries(Object.entries(spec.properties).map(([key, child]) => [key, restore(child, depth + 1)])));
        break;
      default: throw new Error("Invalid schema type");
    }
    if (Object.keys(spec).some(key => !allowed.includes(key))) throw new Error("Invalid schema fields");
    for (const constraint of ["min", "max"] as const) {
      if (spec[constraint] !== undefined) {
        if (typeof spec[constraint] !== "number") throw new Error("Invalid schema bound");
        result = (result as StringSchema | NumberSchema | ArraySchema<unknown>)[constraint](spec[constraint]);
      }
    }
    if (spec.nullable) result = result.nullable();
    if (spec.optional) result = result.optional();
    return result;
  };
  return restore(input, 0);
}

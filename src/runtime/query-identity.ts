import type { Schema } from "../schema";
import { description } from "./schema-descriptions";
import type { QueryIdentity } from "./database/selection";

/** The root optional string `cursor` is reserved for continuation; all other inputs remain bound. */
export function validateContinuation(input: Schema): boolean {
  const cursor = description(input).properties?.cursor;
  if (!cursor) return false;
  if (cursor.type !== "string" || cursor.optional !== true || cursor.nullable) throw new Error("Invalid continuation cursor");
  return true;
}
export function queryIdentity(operation: string, schema: Schema, input: unknown): QueryIdentity {
  if (!validateContinuation(schema)) return { operation, input };
  const bound = Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key]) => key !== "cursor"));
  return { operation, input: bound };
}

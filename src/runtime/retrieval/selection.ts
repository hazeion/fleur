import type { SchemaDescription } from "../schema-descriptions";

/**
 * Copies only the fields a declared response schema names. Undeclared provider
 * fields never reach application code; the schema then validates the result.
 */
export function selectDeclared(spec: SchemaDescription, value: unknown): unknown {
  if (spec.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const selected: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(spec.properties ?? {})) {
      if (Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] !== undefined) selected[key] = selectDeclared(child, (value as Record<string, unknown>)[key]);
    }
    return selected;
  }
  if (spec.type === "array" && Array.isArray(value) && spec.item) return value.map(item => selectDeclared(spec.item!, item));
  return value;
}

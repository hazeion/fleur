import { validatePublicValue } from "../schema";

/** Logical identities compare validated JSON, independent of object key order. */
export function canonical(value: unknown): string {
  validatePublicValue(value);
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sorted(child)])) : item;
  return JSON.stringify(sorted(value));
}

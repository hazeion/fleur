import { defineSeed, type Seed, type Table } from "../database";
import { orderSeeds } from "./seed-declarations";
import { tableDefinitions } from "./declarations";

export function describeSeeds(seeds: readonly Seed[]) {
  return orderSeeds(seeds).map(seed => ({ key: seed.key, table: tableDefinitions.get(seed.table)!.name, rows: seed.rows, dependsOn: (seed.dependsOn ?? []).map(parent => parent.key) }));
}
export function restoreSeeds(value: unknown, tables: readonly Table[]): readonly Seed[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("SOURCE_REJECTED");
  const restored = new Map<string, Seed>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Object.keys(raw).length !== 4 || Object.keys(raw).some(key => !["key", "table", "rows", "dependsOn"].includes(key)) || !Array.isArray(raw.dependsOn) || restored.has(raw.key)) throw new Error("SOURCE_REJECTED");
    const table = tables.find(table => tableDefinitions.get(table)?.name === raw.table);
    if (!table || raw.dependsOn.some((key: unknown) => typeof key !== "string" || !restored.has(key))) throw new Error("SOURCE_REJECTED");
    const seed = defineSeed({ key: raw.key, table, rows: raw.rows, dependsOn: raw.dependsOn.map((key: string) => restored.get(key)!) });
    restored.set(seed.key, seed);
  }
  return Object.freeze([...restored.values()]);
}

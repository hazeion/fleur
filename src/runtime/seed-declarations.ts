import type { Insert, Table } from "../database";
import { validatePublicValue } from "../schema";
import { definition, references, tableDefinitions } from "./declarations";

export interface Seed<T extends Table = Table> {
  readonly key: string;
  readonly table: T;
  readonly rows: readonly { readonly ownerKey: string; readonly values: Insert<T> }[];
  readonly dependsOn?: readonly Seed[];
}
export const seedDefinitions = new WeakSet<object>();
export function seedKey(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value); }
export function defineSeed<T extends Table>(input: Seed<T>): Seed<T> {
  try {
    const spec = tableDefinitions.get(input.table);
    if (!spec || spec.alias || !seedKey(input.key) || Object.keys(input).some(key => !["key", "table", "rows", "dependsOn"].includes(key)) || !Array.isArray(input.rows) || input.rows.length > 10000) throw new Error();
    const owners = new Set<string>();
    const rows = input.rows.map(row => {
      if (!seedKey(row.ownerKey) || owners.has(row.ownerKey) || Object.keys(row).some(key => !["ownerKey", "values"].includes(key))) throw new Error();
      owners.add(row.ownerKey);
      validatePublicValue(row.values);
      if (!row.values || Array.isArray(row.values) || typeof row.values !== "object" || Object.keys(row.values).some(key => !Object.hasOwn(spec.columns, key))) throw new Error();
      for (const [name, reference] of Object.entries(spec.columns)) {
        const field = definition(reference);
        if (Object.hasOwn(row.values, name)) {
          if (field.managed || name === "version" && spec.versioned) throw new Error();
          field.check.parse((row.values as Record<string, unknown>)[name]);
        } else if (!field.generated) throw new Error();
      }
      return Object.freeze({ ownerKey: row.ownerKey, values: Object.freeze(JSON.parse(JSON.stringify(row.values))) as Insert<T> });
    });
    if (input.dependsOn !== undefined && (!Array.isArray(input.dependsOn) || input.dependsOn.some(seed => !seedDefinitions.has(seed)) || new Set(input.dependsOn).size !== input.dependsOn.length)) throw new Error();
    const result = Object.freeze({ key: input.key, table: input.table, rows: Object.freeze(rows), ...(input.dependsOn ? { dependsOn: Object.freeze([...input.dependsOn]) } : {}) });
    seedDefinitions.add(result);
    return result;
  } catch { throw new Error("SEED_INVALID"); }
}
export function orderSeeds(seeds: readonly Seed[]): readonly Seed[] {
  const byKey = new Map(seeds.map(seed => [seed.key, seed]));
  if (byKey.size !== seeds.length || seeds.some(seed => !seedDefinitions.has(seed))) throw new Error("SEED_INVALID");
  const visiting = new Set<Seed>(), visited = new Set<Seed>(), ordered: Seed[] = [];
  const visit = (seed: Seed) => {
    if (visiting.has(seed)) throw new Error("SEED_INVALID");
    if (visited.has(seed)) return;
    visiting.add(seed);
    for (const parent of seed.dependsOn ?? []) { if (byKey.get(parent.key) !== parent) throw new Error("SEED_INVALID"); visit(parent); }
    visiting.delete(seed); visited.add(seed); ordered.push(seed);
  };
  seeds.forEach(visit);
  for (const seed of seeds) {
    const ancestors = new Set<Seed>();
    const collect = (item: Seed) => { for (const parent of item.dependsOn ?? []) if (!ancestors.has(parent)) { ancestors.add(parent); collect(parent); } };
    collect(seed);
    for (const column of Object.values(tableDefinitions.get(seed.table)!.columns)) {
      const target = definition(column).reference?.target;
      const parentTable = target && references.get(target)?.table;
      if (parentTable && parentTable !== seed.table && seeds.some(parent => parent.table === parentTable && !ancestors.has(parent))) throw new Error("SEED_INVALID");
    }
  }
  return ordered;
}

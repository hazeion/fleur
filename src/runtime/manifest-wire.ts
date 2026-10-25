import { restoreSeeds } from "./seed-wire";
import { validateContinuation } from "./query-identity";
import { validatePublicValue, type Schema } from "../schema";
import { definePage, type Page } from "../routing";
import { restoreSchema } from "./schema-wire";
import { restoreTables } from "./table-wire";

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error("SOURCE_REJECTED");
  return value as Record<string, unknown>;
}
function entries<T>(value: unknown, keys: readonly string[], restore: (value: Record<string, unknown>) => T): ReadonlyMap<string, T> {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("SOURCE_REJECTED");
  const result = new Map<string, T>();
  for (const raw of value) {
    const spec = record(raw, keys);
    if (typeof spec.id !== "string" || !spec.id.length || spec.id.length > 256 || result.has(spec.id)) throw new Error("SOURCE_REJECTED");
    result.set(spec.id, restore(spec));
  }
  return result;
}
export interface OperationDefinition { readonly input: Schema; readonly output: Schema; }
export function restoreManifest(input: unknown) {
  validatePublicValue(input);
  const encoded = JSON.stringify(input);
  if (new TextEncoder().encode(encoded).byteLength > 1048576) throw new Error("SOURCE_REJECTED");
  const spec = record(input, ["version", "tables", "queries", "mutations", "pages", "islands", ...(input && typeof input === "object" && "seeds" in input ? ["seeds"] : [])]);
  if (spec.version !== 1) throw new Error("SOURCE_REJECTED");
  const tables = restoreTables(spec.tables);
  const queries = entries<OperationDefinition>(spec.queries, ["id", "input", "output"], query => { const input = restoreSchema(query.input); validateContinuation(input); return Object.freeze({ input, output: restoreSchema(query.output) }); });
  const mutations = entries<OperationDefinition>(spec.mutations, ["id", "input", "output"], mutation => Object.freeze({ input: restoreSchema(mutation.input), output: restoreSchema(mutation.output) }));
  if ([...mutations.keys()].some(name => queries.has(name))) throw new Error("SOURCE_REJECTED");
  const paths = new Set<string>();
  const pages = entries<Page>(spec.pages, ["id", "path", "params"], page => {
    if (typeof page.path !== "string") throw new Error("SOURCE_REJECTED");
    const normalized = page.path.replace(/:[^/]+/g, ":parameter");
    if (paths.has(normalized)) throw new Error("SOURCE_REJECTED");
    paths.add(normalized);
    return definePage({ path: page.path, params: restoreSchema(page.params) } as never);
  });
  const islands = entries<Schema>(spec.islands, ["id", "props"], island => restoreSchema(island.props));
  return Object.freeze({ encoded, tables, queries, mutations, pages, islands, seeds: restoreSeeds(spec.seeds ?? [], tables) });
}
export type Registry = ReturnType<typeof restoreManifest>;

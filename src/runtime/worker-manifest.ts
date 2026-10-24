import type { Table } from "../database";
import { tableDefinitions } from "./declarations";
import { describeTables } from "./table-wire";
import { describeSchema } from "./schema-wire";
import { queries, pages, queryNames, pageNames } from "./registrations";
import { islands, islandNames } from "./islands";
import { nameExports } from "./worker-execution";

/** Called inside the restricted registration worker, never by the trusted host. */
export function workerManifest(exports: Readonly<Record<string, unknown>>) {
  nameExports(exports);
  const tables = [...new Set(Object.values(exports).filter((value): value is Table => !!value && typeof value === "object" && tableDefinitions.has(value) && !tableDefinitions.get(value)?.alias))];
  return {
    version: 1,
    tables: describeTables(tables),
    queries: [...queries.keys()].map(query => ({ id: queryNames.get(query)!, input: describeSchema(query.input), output: describeSchema(query.output) })),
    pages: [...pages.keys()].map(page => ({ id: pageNames.get(page)!, path: page.path, params: describeSchema(page.params) })),
    islands: [...islandNames].map(([island, id]) => ({ id, props: describeSchema(islands.get(island)!.schema) })),
  };
}

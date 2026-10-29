import { seedDefinitions } from "./seed-declarations";
import { describeSeeds } from "./seed-wire";
import type { Seed } from "../database";
import type { Table } from "../database";
import { tableDefinitions } from "./declarations";
import { describeTables } from "./table-wire";
import { describeSchema } from "./schema-wire";
import { queries, mutations, mutationNames, pages, queryNames, pageNames, retrievals, retrievalNames, destinations, destinationNames } from "./registrations";
import { islands, islandNames } from "./islands";
import { nameExports } from "./worker-execution";

/** Called inside the restricted registration worker, never by the trusted host. */
export function workerManifest(exports: Readonly<Record<string, unknown>>) {
  nameExports(exports);
  const tables = [...new Set(Object.values(exports).filter((value): value is Table => !!value && typeof value === "object" && tableDefinitions.has(value) && !tableDefinitions.get(value)?.alias))];
  return {
    version: 1,
    seeds: describeSeeds(Object.values(exports).filter((value): value is Seed => !!value && typeof value === "object" && seedDefinitions.has(value))),
    tables: describeTables(tables),
    queries: [...queries.keys()].map(query => ({ id: queryNames.get(query)!, input: describeSchema(query.input), output: describeSchema(query.output) })),
    mutations: [...mutations.keys()].map(mutation => ({ id: mutationNames.get(mutation)!, input: describeSchema(mutation.input), output: describeSchema(mutation.output) })),
    pages: [...pages.keys()].map(page => ({ id: pageNames.get(page)!, path: page.path, params: describeSchema(page.params) })),
    islands: [...islandNames].map(([island, id]) => ({ id, props: describeSchema(islands.get(island)!.schema) })),
    retrievals: [...retrievals.keys()].map(retrieval => ({ id: retrievalNames.get(retrieval)!, input: describeSchema(retrieval.input), output: describeSchema(retrieval.output) })),
    destinations: [...destinations].map(([key, destination]) => ({ id: destinationNames.get(key)!, origin: destination.origin, path: destination.path, response: describeSchema(destination.response), headers: [...destination.headers], credential: destination.credential ?? null })),
  };
}

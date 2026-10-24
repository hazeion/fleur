import { h } from "preact";
import { renderToStringAsync } from "preact-render-to-string";
import { selectPage } from "./routes";
import type { ReadDb } from "../database";
import { validatePublicValue } from "../schema";
import { pages, queries, queryNames, pageNames, withExecution, type SafeLog } from "./registrations";
import { islandNames, islands, withIslandRenderer } from "./islands";

export interface IslandDescriptor { readonly key: string; readonly id: string; readonly props: unknown; }
export interface PageResult { readonly html: string; readonly islands: readonly IslandDescriptor[]; }
function freezeValue(value: unknown): unknown {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeValue(child); Object.freeze(value); }
  return value;
}
/** Runs only after the native bootstrap has restricted the entire worker. */
export async function executeQuery(name: string, input: unknown, db: ReadDb, log: SafeLog): Promise<unknown> {
  const contract = [...queryNames].find(([, registered]) => name === registered)?.[0];
  const registration = contract && queries.get(contract);
  if (!registration) throw new Error("REQUEST_DENIED");
  return withExecution({ kind: "query", db, log }, async () => registration.handler({ input, db, log }));
}
/** No host filesystem, database connection, or arbitrary dispatcher is supplied. */
export async function executePage(pathname: string, read: (name: string, input: unknown) => Promise<unknown>): Promise<PageResult> {
  const selected = selectPage([...pages.keys()], pathname);
  if (!selected) throw new Error("ROUTE_NOT_FOUND");
  const page = pages.get(selected.page)!;
  const params = selected.params;
  const descriptors: IslandDescriptor[] = [];
  return withExecution({ kind: "render", read }, async () => withIslandRenderer((island, value) => {
    const registered = islands.get(island), id = islandNames.get(island);
    if (!registered || !id) throw new Error("Unregistered island");
    const props = freezeValue(registered.validate(value));
    const key = `island-${descriptors.length}`;
    descriptors.push(Object.freeze({ key, id, props }));
    return h("div", { "data-fleur-island": key }, registered.render(props));
  }, async () => {
    const node = await page.component(params);
    const html = await renderToStringAsync(node as Parameters<typeof renderToStringAsync>[0]);
    validatePublicValue(descriptors);
    return { html, islands: Object.freeze(descriptors) };
  }));
}
export function nameExports(exports: Readonly<Record<string, unknown>>): void {
  const used = new Set<string>();
  for (const [name, value] of Object.entries(exports).sort(([a], [b]) => a.localeCompare(b))) {
    if ((!value || typeof value !== "object") && typeof value !== "function") continue;
    const object = value as object;
    if (islands.has(object)) { if (!islandNames.has(object)) islandNames.set(object, name); }
    for (const contract of queries.keys()) if (contract === value && !queryNames.has(contract)) queryNames.set(contract, name);
    for (const contract of pages.keys()) if (contract === value && !pageNames.has(contract)) pageNames.set(contract, name);
  }
  for (const contract of queries.keys()) {
    const name = queryNames.get(contract);
    if (!name || used.has(name)) throw new Error("Duplicate or unexported query");
    used.add(name);
  }
  for (const contract of pages.keys()) if (!pageNames.has(contract)) throw new Error("Unexported page");
}

import { h, Fragment, isValidElement, Component, type ComponentChild, type VNode } from "preact";
import { renderToStringAsync } from "preact-render-to-string";
import { selectPage } from "./routes";
import type { ReadDb, WriteDb } from "../database";
import { validatePublicValue } from "../schema";
import { pages, queries, queryNames, mutations, mutationNames, pageNames, withExecution, type SafeLog } from "./registrations";
import { islandNames, islands } from "./islands";
import { nameQueryExports } from "./query-client";
import { canonical } from "./canonical";

export interface IslandDescriptor { readonly key: string; readonly id: string; readonly props: unknown; }
export interface QueryDependency { readonly name: string; readonly input: unknown; }
export interface ServerRegion { readonly id: string; readonly dependencies: QueryDependency[]; readonly error?: string; }
export interface PageResult { readonly html: string; readonly islands: readonly IslandDescriptor[]; readonly regions: readonly ServerRegion[]; }
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
  const regions: ServerRegion[] = [];
  let current: ServerRegion;
  const binding = () => new Bun.CryptoHasher("sha256").update(canonical([...new Set(current.dependencies.map(dependency => canonical([dependency.name, dependency.input])))].sort())).digest("hex");
  const region = async (id: string, render: () => Promise<ComponentChild>): Promise<ComponentChild> => {
    if (regions.length >= 500 || id.length > 8192) throw new Error("RESULT_TOO_LARGE");
    const entry: ServerRegion = { id, dependencies: [] };
    regions.push(entry);
    const descriptorStart = descriptors.length, regionStart = regions.length;
    const previous = current;
    current = entry;
    try {
      const content = await render();
      return h(Fragment, null, h("template", { "data-fleur-region": id }), content, h("template", { "data-fleur-end": id }));
    }
    catch (error) {
      // The page operation retains its declared error contract. Nested regions
      // isolate failures so refresh can retain their previous complete subtree.
      if (id === "page" && !(error instanceof Error && error.message === "QUERY_PENDING")) throw error;
      descriptors.splice(descriptorStart); regions.splice(regionStart);
      const code = error instanceof Error && ["QUERY_PENDING", "QUERY_TIMEOUT", "QUERY_LIMIT", "RESULT_TOO_LARGE", "INPUT_INVALID", "NOT_FOUND"].includes(error.message) ? error.message : "INTERNAL_FAILURE";
      Object.assign(entry, { error: code });
      return h(Fragment, null, h("template", { "data-fleur-region": id, "data-fleur-error": code, "data-fleur-stale": "true" }), h("template", { "data-fleur-end": id }));
    } finally { current = previous; }
  };
  type Provider = { type: VNode["type"]; props: Record<string, unknown> };
  const resolve = async (node: ComponentChild, path: string, depth = 0, providers: readonly Provider[] = []): Promise<ComponentChild> => {
    if (depth > 64) throw new Error("RESULT_TOO_LARGE");
    if (Array.isArray(node)) {
      const keys = new Set<string>();
      const output: ComponentChild[] = [];
      for (const [index, child] of node.entries()) {
        const key = isValidElement(child) && child.key != null ? `key:${String(child.key)}` : `index:${index}`;
        if (keys.has(key)) throw new Error("Duplicate component key");
        keys.add(key);
        output.push(await resolve(child, `${path}/${encodeURIComponent(key)}`, depth + 1, providers));
      }
      return output;
    }
    if (!isValidElement(node)) return node;
    const props = node.props as Record<string, unknown>;
    if (typeof node.type === "function" && islands.has(node.type)) {
      const registered = islands.get(node.type)!, id = islandNames.get(node.type);
      if (!id || descriptors.length >= 500) throw new Error("Unregistered island");
      const value = freezeValue(registered.validate(props));
      const key = `island-${descriptors.length}`;
      descriptors.push(Object.freeze({ key, id, props: value }));
      return h("div", { "data-fleur-island": key, "data-fleur-identity": `${path}/${id}` }, registered.render(value));
    }
    if (node.type === Fragment) return resolve(props.children as ComponentChild, path, depth + 1, providers);
    if (typeof node.type === "function" && "Provider" in node.type && node.type.Provider === node.type) {
      return h(node.type, { ...props, children: await resolve(props.children as ComponentChild, `${path}/provider`, depth + 1, [...providers, { type: node.type, props }]) } as never);
    }
    if (typeof node.type === "function") {
      const component = node.type as (props: Record<string, unknown>) => ComponentChild | Promise<ComponentChild>;
      const identity = `${path}/component:${component.name}`;
      return region(identity, async () => {
        let content: ComponentChild, failure: unknown, evaluated: Promise<void> | undefined;
        const collect = (result: ComponentChild | Promise<ComponentChild>) => {
          if (result instanceof Promise) evaluated = result.then(value => { content = value; }, error => { failure = error; });
          else content = result;
        };
        // Let Preact establish hook and provider context while evaluating the
        // server component. Effects remain suppressed by its SSR renderer.
        function Capture(this: unknown, _props: object, context: unknown) {
          try {
            const result = Reflect.apply(component, this, [props, context]) as ComponentChild | Promise<ComponentChild>;
            collect(result);
          } catch (error) { failure = error; }
          return null;
        }
        if ("contextType" in component) Object.assign(Capture, { contextType: component.contextType });
        let capture = h(Capture as never, {});
        if (typeof component.prototype?.render === "function") {
          const Original = component as unknown as typeof Component;
          class CaptureClass extends Original {
            override render(...args: Parameters<Component["render"]>) {
              try { collect(Reflect.apply(component.prototype.render, this, args) as ComponentChild); } catch (error) { failure = error; }
              return null;
            }
          }
          capture = h(CaptureClass as never, props as never);
        }
        for (const provider of [...providers].reverse()) capture = h(provider.type, { ...provider.props, children: capture } as never);
        await renderToStringAsync(capture);
        await evaluated;
        if (failure) throw failure;
        return resolve(content, `${identity}/queries:${binding()}`, depth + 1, providers);
      });
    }
    return h(node.type, { ...props, key: node.key, ...(node.key == null ? {} : { "data-fleur-key": path }), children: await resolve(props.children as ComponentChild, `${path}/${node.type}`, depth + 1, providers) } as never) as VNode;
  };
  return withExecution({ kind: "render", read: async (name, input) => {
    current.dependencies.push({ name, input });
    return read(name, input);
  } }, async () => {
    const node = await region("page", async () => {
      const content = await page.component(params);
      return resolve(content, `page/queries:${binding()}`);
    });
    const html = await renderToStringAsync(node as Parameters<typeof renderToStringAsync>[0]);
    validatePublicValue(descriptors);
    validatePublicValue(regions);
    return { html, islands: Object.freeze(descriptors), regions: Object.freeze(regions) };
  });
}
export function nameExports(exports: Readonly<Record<string, unknown>>): void {
  nameQueryExports(exports);
  const used = new Set<string>();
  for (const [name, value] of Object.entries(exports).sort(([a], [b]) => a.localeCompare(b))) {
    if ((!value || typeof value !== "object") && typeof value !== "function") continue;
    const object = value as object;
    if (islands.has(object)) { if (!islandNames.has(object)) islandNames.set(object, name); }
    for (const contract of queries.keys()) if (contract === value && !queryNames.has(contract)) queryNames.set(contract, name);
    for (const contract of mutations.keys()) if (contract === value && !mutationNames.has(contract)) mutationNames.set(contract, name);
    for (const contract of pages.keys()) if (contract === value && !pageNames.has(contract)) pageNames.set(contract, name);
  }
  for (const contract of queries.keys()) {
    const name = queryNames.get(contract);
    if (!name || used.has(name)) throw new Error("Duplicate or unexported query");
    used.add(name);
  }
  for (const contract of mutations.keys()) {
    const name = mutationNames.get(contract);
    if (!name || used.has(name)) throw new Error("Duplicate or unexported mutation");
    used.add(name);
  }
  for (const contract of pages.keys()) if (!pageNames.has(contract)) throw new Error("Unexported page");
}

export async function executeMutation(name: string, input: unknown, db: WriteDb, log: SafeLog): Promise<unknown> {
  const contract = [...mutationNames].find(([, registered]) => name === registered)?.[0];
  const registration = contract && mutations.get(contract);
  if (!registration) throw new Error("REQUEST_DENIED");
  return withExecution({ kind: "mutation", db, log }, async () => registration.handler({ input, db, log }));
}

import { createHash } from "node:crypto";
import { relative } from "node:path";
import { parseSync } from "rolldown/utils";
import type { AdmittedProject } from "./admission";

type Node = Record<string, unknown>;
const node = (value: unknown): Node | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Node : undefined;
const name = (value: unknown): string | undefined => { const item = node(value); return typeof item?.name === "string" ? item.name : typeof item?.value === "string" ? item.value : undefined; };
const isFunction = (value: Node) => ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(String(value.type));
function walk(value: unknown, visit: (value: Node, parent: Node | undefined, key: string, ancestors: Node[]) => void, ancestors: Node[] = [], key = ""): void {
  if (Array.isArray(value)) { for (const child of value) walk(child, visit, ancestors, key); return; }
  const item = node(value); if (!item) return;
  visit(item, ancestors.at(-1), key, ancestors);
  for (const [field, child] of Object.entries(item)) walk(child, visit, [...ancestors, item], field);
}
const omitted = new Set(["start", "end", "loc", "range", "span", "raw", "extra", "comments", "tokens"]);
function normalized(value: unknown, replacements = new Map<Node, unknown>()): unknown {
  if (Array.isArray(value)) return value.map(child => normalized(child, replacements));
  const item = node(value); if (!item) return value;
  if (replacements.has(item)) return replacements.get(item);
  return Object.fromEntries(Object.entries(item).filter(([key]) => !omitted.has(key)).map(([key, child]) => [key, normalized(child, replacements)]));
}
/** A conservative proof, not state migration or a general JavaScript effect analysis. */
export function clientCompatibility(project: AdmittedProject, runtime: string): string {
  const modules = [...project.shared, ...project.client].sort();
  const fingerprints: unknown[] = [], complete: unknown[] = [];
  let uncertain = false;
  for (const path of modules) {
    const source = project.sources.get(path)!;
    const parsed = parseSync(path, source); if (parsed.errors.length) throw new Error("SOURCE_REJECTED");
    const program = node(parsed.program)!;
    const imports = new Map<string, { source: string; imported: string }>();
    const localImports = new Set<string>();
    walk(program, item => {
      if (item.type !== "ImportDeclaration") return;
      const from = name(item.source)!;
      for (const raw of item.specifiers as unknown[] ?? []) {
        const specifier = node(raw)!; const local = name(specifier.local);
        if (!local) continue;
        imports.set(local, { source: from, imported: specifier.type === "ImportNamespaceSpecifier" ? "*" : name(specifier.imported) ?? "default" });
        if (project.resolutions.has(path+"\0"+from)) localImports.add(local);
      }
    });
    const kind = (callee: unknown): string | undefined => {
      const value = node(callee); if (!value) return;
      let imported = value.type === "Identifier" ? imports.get(name(value)!) : undefined;
      if (value.type === "MemberExpression") {
        const owner = imports.get(name(value.object)!);
        if (owner?.imported === "*" && (!value.computed || node(value.property)?.type === "Literal" || node(value.property)?.type === "StringLiteral")) imported = { source: owner.source, imported: name(value.property) ?? "" };
      }
      if (!imported) return;
      if (imported.source === "preact/hooks" && /^use[A-Z]/.test(imported.imported)) return "hook:"+imported.imported;
      if (imported.source === "fleur/client") {
        if (["useQuery", "useMutation"].includes(imported.imported)) return "hook:"+imported.imported;
        if (imported.imported === "defineIsland") return "island";
      }
      if (imported.source === "fleur/schema" && imported.imported === "defineQuery") return "query";
    };
    const components = new Map<Node, string>(), islandVariables = new Set<string>(), queries = new Map<Node, string>();
    walk(program, (item, parent, _key, ancestors) => {
      if (item.type !== "CallExpression") return;
      if (kind(item.callee) === "query" && parent?.type === "VariableDeclarator" && name(parent.id)) queries.set(item, name(parent.id)!);
      if (kind(item.callee) !== "island") return;
      const owner = parent?.type === "VariableDeclarator" ? name(parent.id) : parent?.type === "ExportDefaultDeclaration" ? "default" : undefined;
      const argument = node((item.arguments as unknown[] | undefined)?.[0]);
      const property = (argument?.properties as unknown[] | undefined)?.map(node).find(property => name(property?.key) === "component");
      const component = node(property?.value);
      if (!owner || !component || !isFunction(component) || ancestors.some(isFunction)) { uncertain = true; return; }
      components.set(component, owner); islandVariables.add(owner);
    });
    const locations = new Map<Node, Node[]>(), calls = new Map<Node, Node[]>();
    walk(program, (item, parent, key, ancestors) => {
      locations.set(item, ancestors);
      if (["ClassDeclaration", "ClassExpression"].includes(String(item.type))) uncertain = true;
      if (item.type === "CallExpression") {
        const operation = kind(item.callee);
        if (operation?.startsWith("hook:")) {
          const owner = [...ancestors].reverse().find(isFunction);
          if (!owner || !components.has(owner)) uncertain = true;
          else { const found = calls.get(owner) ?? []; found.push(item); calls.set(owner, found); }
        } else if (/^use[A-Z]/.test(name(item.callee) ?? "") || localImports.has(name(item.callee) ?? "")) uncertain = true;
      }
      if (item.type !== "Identifier" || ancestors.some(ancestor => ancestor.type === "ImportDeclaration")) return;
      if (key === "key" && !parent?.computed || key === "property" && parent?.type === "MemberExpression" && !parent.computed) return;
      const imported = imports.get(name(item)!);
      if (imported && (imported.source === "preact/hooks" || imported.source === "fleur/client" && ["useQuery", "useMutation", "defineIsland", "*"].includes(imported.imported))) {
        const direct = parent?.type === "CallExpression" && parent.callee === item && kind(item);
        const member = parent?.type === "MemberExpression" && parent.object === item && ancestors.at(-2)?.type === "CallExpression" && ancestors.at(-2)?.callee === parent && kind(parent);
        if (!direct && !member) uncertain = true;
      }
      if (islandVariables.has(name(item)!) && !(parent?.type === "VariableDeclarator" && parent.id === item) && parent?.type !== "ExportSpecifier") uncertain = true;
    });
    const replacements = new Map<Node, unknown>();
    for (const [component, id] of components) {
      const sites = calls.get(component) ?? [], body = node(component.body), statements = body?.type === "BlockStatement" ? body.body as Node[] : [];
      const last = Math.max(-1, ...sites.map(site => statements.findIndex(statement => locations.get(site)?.includes(statement))));
      const prefix: unknown[] = [];
      for (let index = 0; index <= last; index++) {
        const statement = statements[index]!;
        const ownSites = sites.filter(site => locations.get(site)?.includes(statement));
        const describe = (call: Node, binding: unknown) => ({ hook: kind(call.callee), binding: normalized(binding), ...(["hook:useQuery"].includes(kind(call.callee)!) ? {} : { arguments: normalized(call.arguments) }) });
        if (statement.type === "VariableDeclaration") {
          for (const declaration of statement.declarations as Node[]) {
            const init = node(declaration.init);
            const nested = ownSites.filter(site => locations.get(site)?.includes(declaration));
            if (init?.type === "CallExpression" && kind(init.callee)?.startsWith("hook:") && nested.length === 1) prefix.push(describe(init, declaration.id));
            else { if (nested.length) uncertain = true; prefix.push(normalized(declaration)); }
          }
        } else if (statement.type === "ExpressionStatement" && kind(node(statement.expression)?.callee)?.startsWith("hook:") && ownSites.length === 1) prefix.push(describe(node(statement.expression)!, null));
        else { uncertain = true; prefix.push(normalized(statement)); }
      }
      if (sites.length && (!statements.length || last < 0)) uncertain = true;
      replacements.set(component, { island: id, parameters: normalized(component.params), hooks: prefix });
    }
    const references = (value: unknown): Set<string> => {
      const result = new Set<string>();
      walk(value, (item, parent, key) => {
        if (item.type !== "Identifier" || key === "key" && !parent?.computed || key === "property" && parent?.type === "MemberExpression" && !parent.computed) return;
        result.add(name(item)!);
      });
      return result;
    };
    const dependent = new Set<string>(), dependents = new Map<string, Set<string>>();
    walk(program, item => {
      if (item.type !== "VariableDeclarator") return;
      const bindings = references(item.id), init = node(item.init);
      if (kind(init?.callee) === "hook:useQuery") for (const binding of bindings) dependent.add(binding);
      for (const reference of references(init)) {
        const found = dependents.get(reference) ?? new Set<string>();
        for (const binding of bindings) found.add(binding);
        dependents.set(reference, found);
      }
    });
    const queue = [...dependent];
    while (queue.length) for (const binding of dependents.get(queue.pop()!) ?? []) if (!dependent.has(binding)) { dependent.add(binding); queue.push(binding); }
    let queryState = false;
    walk(program, item => {
      if (item.type === "CallExpression" && kind(item.callee)?.startsWith("hook:") && kind(item.callee) !== "hook:useQuery" && [...references(item.arguments)].some(reference => dependent.has(reference))) queryState = true;
    });
    const byName = new Map<string, Node[]>(), refreshOnly = new Map<Node, boolean>();
    for (const [query, binding] of queries) { const found = byName.get(binding) ?? []; found.push(query); byName.set(binding, found); refreshOnly.set(query, !queryState); }
    // Only pure useQuery results may change validation without migrating state.
    // Query-derived state/ref/effect/memo inputs retain the previous browser.
    walk(program, (item, parent, key, ancestors) => {
      if (item.type !== "Identifier" || parent?.type === "VariableDeclarator" && parent.id === item || parent?.type === "ExportSpecifier" || key === "key" && !parent?.computed) return;
      for (const query of byName.get(name(item)!) ?? []) {
        if (ancestors.includes(query)) continue;
        if (!(parent?.type === "CallExpression" && kind(parent.callee) === "hook:useQuery" && (parent.arguments as unknown[])[0] === item)) refreshOnly.set(query, false);
      }
    });
    for (const [query, binding] of queries) if (refreshOnly.get(query)) replacements.set(query, { query: binding, values: "invalidated-before-replacement" });
    const id = relative(project.root, path).replaceAll("\\", "/");
    fingerprints.push([id, normalized(program, replacements)]);
    complete.push([id, source]);
  }
  // An uncertain graph requires explicit navigation for any application-byte or asset edit.
  // Unchanged server-only edits still reuse the existing browser module.
  return createHash("sha256").update(JSON.stringify([1, runtime, uncertain ? [complete, [...project.assets.values()].map(asset => asset.url).sort()] : fingerprints])).digest("hex");
}

import { createHash } from "node:crypto";
import { relative } from "node:path";
import { parseSync } from "rolldown/utils";
import type { AdmittedProject } from "./admission";

type Node = Record<string, unknown>;
type Value = { kind: "string" | "number" | "boolean" | "null" | "text" } | { kind: "object"; fields: Map<string, Value> };
type Import = { source: string; imported: string };
type Query = { binding: Node; output: Node; operation: string | undefined; value: Value | undefined };
type Module = { path: string; program: Node; imports: Map<string, Import>; queries: Map<string, Query>; exports: Map<string, string>; operations: Map<string, string>; constants: Map<string, Value> };
const node = (value: unknown): Node | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Node : undefined;
const name = (value: unknown): string | undefined => { const item = node(value); return typeof item?.name === "string" ? item.name : typeof item?.value === "string" ? item.value : undefined; };
const isFunction = (value: Node) => ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(String(value.type));
function walk(value: unknown, visit: (value: Node, parent: Node | undefined, key: string, ancestors: Node[]) => void, ancestors: Node[] = [], key = ""): void {
  if (Array.isArray(value)) { for (const child of value) walk(child, visit, ancestors, key); return; }
  const item = node(value); if (!item) return;
  visit(item, ancestors.at(-1), key, ancestors);
  for (const [field, child] of Object.entries(item)) walk(child, visit, [...ancestors, item], field);
}
function literal(value: unknown): unknown {
  const item = node(value);
  return item && ["Literal", "StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(String(item.type)) ? item.value : undefined;
}
function record(value: unknown): Node[] | undefined {
  const object = node(value); if (object?.type !== "ObjectExpression") return;
  const fields = object.properties as Node[], keys = new Set<string>();
  for (const field of fields) {
    const key = name(field.key);
    if (field.type !== "Property" || field.computed || field.method || field.kind !== "init" || key === undefined || ["__proto__", "constructor", "prototype"].includes(key) || keys.has(key)) return;
    keys.add(key);
  }
  return fields;
}
const property = (value: unknown, key: string): Node | undefined => record(value)?.find(item => name(item.key) === key);
const constructors = new Set(["object", "array", "enum", "string", "number", "safeInteger", "boolean", "uuid", "localDate", "timestamp", "decimal"]);
const modifiers = new Set(["min", "max", "nullable", "optional"]);
function schemaCall(call: Node, imports: Map<string, Import>): boolean {
  const callee = node(call.callee), owner = node(callee?.object), method = name(callee?.property);
  if (call.type !== "CallExpression" || callee?.type !== "MemberExpression" || callee.computed || !method) return false;
  const imported = imports.get(name(owner) ?? "");
  return owner?.type === "Identifier" && imported?.source === "fleur/schema" && imported.imported === "schema" && constructors.has(method)
    || owner?.type === "CallExpression" && modifiers.has(method) && schemaCall(owner, imports);
}
/** Only required plain schema fields and scalar outputs participate in the text proof. */
function schemaValue(input: unknown, imports: Map<string, Import>, depth = 0): Value | undefined {
  const call = node(input), callee = node(call?.callee), method = name(callee?.property), args = call?.arguments as unknown[] | undefined;
  if (!call || depth > 16 || !schemaCall(call, imports) || !method) return;
  if (["min", "max"].includes(method) && args?.length === 1 && typeof literal(args[0]) === "number") return schemaValue(callee?.object, imports, depth + 1);
  if (callee && node(callee.object)?.type !== "Identifier") return;
  if (["string", "uuid", "localDate", "timestamp"].includes(method) && !args?.length) return { kind: "string" };
  if (["number", "safeInteger"].includes(method) && !args?.length) return { kind: "number" };
  if (method === "boolean" && !args?.length) return { kind: "boolean" };
  if (method === "enum" && args?.length === 1) {
    const values = node(args[0]);
    if (values?.type === "ArrayExpression" && (values.elements as unknown[]).length && (values.elements as unknown[]).every(item => typeof literal(item) === "string")) return { kind: "string" };
  }
  if (method === "object" && args?.length === 1 && node(args[0])?.type === "ObjectExpression") {
    const properties = record(args[0]); if (!properties) return;
    const fields = new Map<string, Value>();
    for (const field of properties) {
      const key = name(field.key), value = schemaValue(field.value, imports, depth + 1);
      if (field.type !== "Property" || field.computed || field.method || field.kind !== "init" || !key || !value || fields.has(key)) return;
      fields.set(key, value);
    }
    return { kind: "object", fields };
  }
}
const omitted = new Set(["start", "end", "loc", "range", "span", "raw", "extra", "comments", "tokens"]);
function classIdentity(item: Node | undefined): string | undefined {
  if (item?.type !== "JSXAttribute" || !["class", "className"].includes(name(item.name) ?? "")) return;
  const value = literal(node(item.value)?.type === "JSXExpressionContainer" ? node(item.value)?.expression : item.value);
  if (typeof value === "string") return value.split(/\s+/).filter(token => token && !["italic", "not-italic"].includes(token)).join(" ");
}
/** The pinned owned compiler's two font-style rules cannot remove or disable an input. */
function styleIdentity(css: string): string {
  return css.replaceAll("  .italic {\n    font-style: italic;\n  }\n", "").replaceAll("  .not-italic {\n    font-style: normal;\n  }\n", "").replaceAll("@layer utilities {\n}\n", "@layer utilities;\n");
}
function normalized(value: unknown, replacements = new Map<Node, unknown>(), presentation = false): unknown {
  if (Array.isArray(value)) return value.filter(child => !presentation || classIdentity(node(child)) !== "").map(child => normalized(child, replacements, presentation));
  const item = node(value); if (!item) return value;
  if (replacements.has(item)) return replacements.get(item);
  const classes = presentation ? classIdentity(item) : undefined;
  if (classes !== undefined) return { attribute: name(item.name), classes };
  // Callback bodies and non-query expressions are immutable parts of the proof.
  if (presentation && (isFunction(item) || ["JSXAttribute", "JSXExpressionContainer"].includes(String(item.type)))) return normalized(item, replacements);
  return Object.fromEntries(Object.entries(item).filter(([key]) => !omitted.has(key)).map(([key, child]) => [key, presentation && item.type === "JSXText" && key === "value" ? "text" : normalized(child, replacements, presentation)]));
}
function importedKind(callee: unknown, imports: Map<string, Import>): string | undefined {
  const item = node(callee); if (!item) return;
  let imported = item.type === "Identifier" ? imports.get(name(item)!) : undefined;
  if (item.type === "MemberExpression" && !item.computed) {
    const owner = imports.get(name(item.object)!);
    if (owner?.imported === "*") imported = { source: owner.source, imported: name(item.property) ?? "" };
  }
  if (imported?.source === "preact/hooks" && /^use[A-Z]/.test(imported.imported)) return "hook:"+imported.imported;
  if (imported?.source === "fleur/client" && ["useQuery", "useMutation"].includes(imported.imported)) return "hook:"+imported.imported;
  if (imported?.source === "fleur/client" && imported.imported === "defineIsland") return "island";
  if (imported?.source === "fleur/schema" && ["defineQuery", "defineMutation"].includes(imported.imported)) return imported.imported;
}
const read = (item: Node, parent: Node | undefined, key: string) => item.type === "Identifier" && !(key === "key" && !parent?.computed || key === "property" && parent?.type === "MemberExpression" && !parent.computed);
const text = (value: Value | undefined): boolean => value !== undefined && value.kind !== "object";
const unwrap = (input: unknown): Node | undefined => { const value = node(input); return value && ["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "TSSatisfiesExpression"].includes(String(value.type)) ? unwrap(value.expression) : value; };
type EventInput = { name: string; tag: string };
/** Closed JSON expression grammar; no function values, implicit callbacks or arbitrary getters. */
function dataValue(input: unknown, values: ReadonlyMap<string, Value>, event?: EventInput): Value | undefined {
  const item = unwrap(input); if (!item) return;
  const scalar = literal(item);
  if (scalar === null) return { kind: "null" };
  if (["string", "number", "boolean"].includes(typeof scalar)) return { kind: typeof scalar as "string" | "number" | "boolean" };
  if (item.type === "Identifier") return event?.name === name(item) ? undefined : values.get(name(item)!);
  if (item.type === "MemberExpression" && !item.computed && !item.optional) {
    const owner = unwrap(item.object), target = node(owner?.object), field = name(item.property);
    if (event && owner?.type === "MemberExpression" && !owner.computed && name(owner.property) === "currentTarget" && target?.type === "Identifier" && name(target) === event.name) {
      if (field === "value" && ["input", "textarea", "select"].includes(event.tag)) return { kind: "string" };
      if (field === "checked" && event.tag === "input") return { kind: "boolean" };
    }
    const value = dataValue(owner, values, event);
    if (value?.kind === "object") return value.fields.get(field ?? "");
    if (value?.kind === "string" && field === "length") return { kind: "number" };
  }
  const fields = record(item);
  if (fields) {
    const result = new Map<string, Value>();
    for (const field of fields) { const value = dataValue(field.value, values, event); if (!value) return; result.set(name(field.key)!, value); }
    return { kind: "object", fields: result };
  }
  if (item.type === "BinaryExpression") {
    const left = dataValue(item.left, values, event), right = dataValue(item.right, values, event);
    if (!left || !right) return;
    if (["===", "!=="].includes(String(item.operator))) return { kind: "boolean" };
    if (item.operator === "+" && text(left) && text(right) && (left.kind === "string" || right.kind === "string")) return { kind: "string" };
    if (["+", "-", "*", "/", "%", "**"].includes(String(item.operator)) && left.kind === "number" && right.kind === "number") return { kind: "number" };
  }
  if (item.type === "UnaryExpression" && item.operator === "!" && dataValue(item.argument, values, event)) return { kind: "boolean" };
  if (item.type === "ConditionalExpression" && text(dataValue(item.test, values, event))) {
    const yes = dataValue(item.consequent, values, event), no = dataValue(item.alternate, values, event);
    if (yes && no && sameValue(yes, no)) return yes;
  }
}
function sameValue(left: Value, right: Value): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== "object" || right.kind !== "object") return true;
  return left.fields.size === right.fields.size && [...left.fields].every(([key, value]) => { const other = right.fields.get(key); return other !== undefined && sameValue(value, other); });
}
function actionCalls(callback: Node, effect = false): Node[] | undefined {
  if (callback.async || callback.generator || (callback.params as unknown[]).length > (effect ? 0 : 1) || (callback.params as Node[]).some(parameter => parameter.type !== "Identifier")) return;
  const body = node(callback.body);
  if (!effect && body?.type === "CallExpression") return [body];
  if (body?.type !== "BlockStatement") return;
  const calls: Node[] = [];
  for (const statement of body.body as Node[]) {
    const call = node(statement.expression);
    if (statement.type !== "ExpressionStatement" || call?.type !== "CallExpression") return;
    calls.push(call);
  }
  return calls;
}
function updateValue(input: unknown, previous: Value, values: ReadonlyMap<string, Value>, event?: EventInput): Value | undefined {
  const item = node(input); if (!item || !isFunction(item)) return dataValue(input, values, event);
  const parameters = item.params as Node[];
  if (item.async || item.generator || parameters.length !== 1 || parameters[0]?.type !== "Identifier") return;
  const body = node(item.body), statements = body?.type === "BlockStatement" ? body.body as Node[] : [];
  const expression = body?.type === "BlockStatement" ? statements.length === 1 && statements[0]?.type === "ReturnStatement" ? statements[0].argument : undefined : body;
  const parameter = name(parameters[0])!;
  return dataValue(expression, new Map([...values, [parameter, previous]]), event?.name === parameter ? undefined : event);
}
function success(input: unknown, queries: Map<string, Query>): string | undefined {
  const value = unwrap(input); if (value?.type !== "BinaryExpression" || value.operator !== "===") return;
  for (const [left, right] of [[value.left, value.right], [value.right, value.left]]) {
    const member = unwrap(left), root = unwrap(member?.object);
    if (literal(right) === "success" && member?.type === "MemberExpression" && !member.computed && name(member.property) === "status" && root?.type === "Identifier" && queries.has(name(root)!)) return name(root);
  }
}
/** A total, effect-free text projection of validated query data. Not JavaScript evaluation. */
function queryText(input: unknown, queries: Map<string, Query>, ready: ReadonlySet<string>, calls: Set<Node>): Value | undefined {
  const value = unwrap(input); if (!value) return;
  const scalar = literal(value);
  if (scalar === null) return { kind: "null" };
  if (["string", "number", "boolean"].includes(typeof scalar)) return { kind: typeof scalar as "string" | "number" | "boolean" };
  if (value.type === "MemberExpression" && !value.computed && !value.optional) {
    const owner = unwrap(value.object), field = name(value.property);
    if (owner?.type === "Identifier" && queries.has(name(owner)!)) {
      if (field === "status") return { kind: "string" };
      if (field === "data" && ready.has(name(owner)!)) return queries.get(name(owner)!)?.value;
      return;
    }
    const parent = queryText(owner, queries, ready, calls);
    if (parent?.kind === "object") return parent.fields.get(field ?? "");
    if (parent?.kind === "string" && field === "length") return { kind: "number" };
    return;
  }
  if (value.type === "CallExpression" && (value.arguments as unknown[]).length === 0 && !value.optional) {
    const callee = node(value.callee);
    if (callee?.type === "MemberExpression" && !callee.computed && ["toUpperCase", "toLowerCase", "trim"].includes(name(callee.property) ?? "") && queryText(callee.object, queries, ready, calls)?.kind === "string") { calls.add(value); return { kind: "string" }; }
    return;
  }
  if (value.type === "BinaryExpression") {
    const left = queryText(value.left, queries, ready, calls), right = queryText(value.right, queries, ready, calls);
    if (!left || !right) return;
    if (["===", "!=="].includes(String(value.operator))) return { kind: "boolean" };
    if (value.operator === "+" && text(left) && text(right) && (left.kind === "string" || right.kind === "string")) return { kind: "string" };
    if (["+", "-", "*", "/", "%", "**"].includes(String(value.operator)) && left.kind === "number" && right.kind === "number") return { kind: "number" };
  }
  if (value.type === "UnaryExpression" && value.operator === "!" && queryText(value.argument, queries, ready, calls)) return { kind: "boolean" };
  if (value.type === "ConditionalExpression" && text(queryText(value.test, queries, ready, calls))) {
    const known = success(value.test, queries), consequent = queryText(value.consequent, queries, known ? new Set([...ready, known]) : ready, calls), alternate = queryText(value.alternate, queries, ready, calls);
    if (text(consequent) && text(alternate)) return { kind: "text" };
  }
}

/** Prove a bounded presentation-only replacement; every unproved graph retains its old browser. */
export function clientCompatibility(project: AdmittedProject, runtime: string, stylesheet: string): string {
  const paths = [...project.shared, ...project.client].sort(), modules = new Map<string, Module>();
  let uncertain = false;
  for (const path of paths) {
    const parsed = parseSync(path, project.sources.get(path)!); if (parsed.errors.length) throw new Error("SOURCE_REJECTED");
    const module: Module = { path, program: node(parsed.program)!, imports: new Map(), queries: new Map(), exports: new Map(), operations: new Map(), constants: new Map() };
    walk(module.program, item => {
      if (item.type === "ImportDeclaration") for (const entry of item.specifiers as Node[]) module.imports.set(name(entry.local)!, { source: name(item.source)!, imported: entry.type === "ImportNamespaceSpecifier" ? "*" : name(entry.imported) ?? "default" });
    });
    walk(module.program, (item, parent, _key, ancestors) => {
      if (item.type === "VariableDeclarator" && parent?.kind === "const" && node(item.id)?.type === "Identifier" && !ancestors.some(isFunction)) {
        const init = node(item.init), operation = importedKind(init?.callee, module.imports), constant = dataValue(init, new Map());
        if (init?.type === "CallExpression" && ["island", "defineQuery", "defineMutation"].includes(operation ?? "")) module.operations.set(name(item.id)!, operation!);
        if (literal(init) !== undefined && constant) module.constants.set(name(item.id)!, constant);
      }
      if (item.type === "ExportAllDeclaration" || item.type === "ExportNamedDeclaration" && item.source) uncertain = true;
      if (item.type === "ExportNamedDeclaration" && !item.source) {
        const declaration = node(item.declaration);
        if (declaration?.type === "VariableDeclaration") for (const entry of declaration.declarations as Node[]) if (node(entry.id)?.type === "Identifier") module.exports.set(name(entry.id)!, name(entry.id)!);
        for (const entry of item.specifiers as Node[] ?? []) if (node(entry.local)?.type === "Identifier") module.exports.set(name(entry.exported)!, name(entry.local)!);
      }
      if (item.type === "ExportDefaultDeclaration" && node(item.declaration)?.type === "Identifier") module.exports.set("default", name(item.declaration)!);
      if (item.type === "CallExpression" && importedKind(item.callee, module.imports) === "defineQuery" && parent?.type === "VariableDeclarator" && node(parent.id)?.type === "Identifier" && !ancestors.some(isFunction)) {
        const output = node(property((item.arguments as unknown[])[0], "output")?.value);
        if (output) {
          const operation = literal(property((item.arguments as unknown[])[0], "name")?.value);
          module.queries.set(name(parent.id)!, { binding: node(parent.id)!, output, operation: typeof operation === "string" ? operation : undefined, value: schemaValue(output, module.imports) });
        }
      }
    });
    modules.set(path, module);
  }
  const resolveQuery = (module: Module, binding: string, depth = 0): Query | undefined => {
    if (depth > 16) return;
    const local = module.queries.get(binding); if (local) return local;
    const imported = module.imports.get(binding), path = imported && project.resolutions.get(module.path+"\0"+imported.source), owner = path && modules.get(path);
    const exported = owner && owner.exports.get(imported!.imported);
    return owner && exported ? resolveQuery(owner, exported, depth + 1) : undefined;
  };
  const resolveOperation = (module: Module, binding: string, operation: string, depth = 0): boolean => {
    if (depth > 16) return false;
    if (module.operations.get(binding) === operation) return true;
    const imported = module.imports.get(binding), path = imported && project.resolutions.get(module.path+"\0"+imported.source), owner = path && modules.get(path);
    const exported = owner && owner.exports.get(imported!.imported);
    return !!(owner && exported && resolveOperation(owner, exported, operation, depth + 1));
  };
  // Only query contracts published by the client bundle can be replaced before
  // activation. Imported private contracts keep their full schema fingerprint.
  const published = new Set<Query>();
  for (const path of project.client) {
    const module = modules.get(path)!;
    for (const binding of module.exports.values()) { const query = resolveQuery(module, binding); if (query) published.add(query); }
  }
  const names = new Set<string>();
  for (const module of modules.values()) {
    for (const query of module.queries.values()) {
      if (!query.operation || !query.value || names.has(query.operation)) uncertain = true;
      if (query.operation) names.add(query.operation);
    }
  }
  const replacements = new Map<Node, unknown>(), referenced = new Set<Query>();
  for (const module of modules.values()) {
    const kind = (callee: unknown) => importedKind(callee, module.imports);
    const components = new Map<Node, string>(), componentProps = new Map<Node, Value | undefined>(), islands = new Set<string>(), hookCalls = new Set<Node>(), pureCalls = new Set<Node>(), definitionUses = new Set<Node>();
    const proof = new Map<Node, { queries: Map<string, Query>; bindings: Set<Node>; writers: Map<string, Value>; mutations: Set<string>; callbacks: Map<Node, { event?: EventInput }>; actions: Set<Node>; queryUses: Set<Node>; data: Map<string, Value> }>();
    walk(module.program, (item, parent, _key, ancestors) => {
      if (item.type !== "CallExpression" || kind(item.callee) !== "island") return;
      const id = parent?.type === "VariableDeclarator" ? name(parent.id) : parent?.type === "ExportDefaultDeclaration" ? "default" : undefined;
      const component = node(property((item.arguments as unknown[])[0], "component")?.value);
      if (!id || !component || !isFunction(component) || ancestors.some(isFunction)) { uncertain = true; return; }
      components.set(component, id); componentProps.set(component, schemaValue(property((item.arguments as unknown[])[0], "props")?.value, module.imports)); islands.add(id);
    });
    for (const [component, id] of components) {
      const info = { queries: new Map<string, Query>(), bindings: new Set<Node>(), writers: new Map<string, Value>(), mutations: new Set<string>(), callbacks: new Map<Node, { event?: EventInput }>(), actions: new Set<Node>(), queryUses: new Set<Node>(), data: new Map(module.constants) };
      proof.set(component, info);
      const props = componentProps.get(component);
      const parameters = component.params as Node[];
      if (props?.kind !== "object" || parameters.length > 1) uncertain = true;
      else if (parameters.length) {
        const parameter = parameters[0]!;
        if (parameter.type === "Identifier") info.data.set(name(parameter)!, props);
        else if (parameter.type === "ObjectPattern") {
          for (const field of parameter.properties as Node[]) {
            const binding = node(field.value), value = props.fields.get(name(field.key) ?? "");
            if (field.type !== "Property" || field.computed || binding?.type !== "Identifier" || !value) uncertain = true;
            else info.data.set(name(binding)!, value);
          }
        } else uncertain = true;
      }
      const body = node(component.body), statements = body?.type === "BlockStatement" ? body.body as Node[] : [], last = statements.at(-1);
      const view = body?.type === "BlockStatement" ? node(last?.argument) : body;
      const prefix = body?.type === "BlockStatement" ? statements.slice(0, -1) : [];
      if (!view || !["JSXElement", "JSXFragment"].includes(String(view.type)) || body?.type === "BlockStatement" && last?.type !== "ReturnStatement") { uncertain = true; continue; }
      for (const statement of prefix) {
        const declarations = statement.type === "VariableDeclaration" && statement.kind === "const" ? statement.declarations as Node[] : statement.type === "ExpressionStatement" ? [{ init: statement.expression }] : [];
        if (!declarations.length) uncertain = true;
        for (const declaration of declarations) {
          const call = node(declaration.init), operation = kind(call?.callee), binding = node(declaration.id);
          if (call?.type !== "CallExpression" || !operation?.startsWith("hook:")) { uncertain = true; continue; }
          hookCalls.add(call);
          const arguments_ = call.arguments as unknown[];
          if (!["hook:useState", "hook:useEffect", "hook:useQuery", "hook:useMutation"].includes(operation)) uncertain = true;
          if (operation === "hook:useQuery") {
            const queryName = node((call.arguments as unknown[])[0]), query = queryName?.type === "Identifier" ? resolveQuery(module, name(queryName)!) : undefined;
            if (binding?.type !== "Identifier" || !query?.value || info.queries.has(name(binding)!)) { uncertain = true; continue; }
            if (arguments_.length !== 2 || !dataValue(arguments_[1], info.data)) uncertain = true;
            info.queries.set(name(binding)!, query); info.bindings.add(binding); definitionUses.add(queryName!); referenced.add(query);
          } else if (operation === "hook:useState") {
            const elements = binding?.elements as unknown[] | undefined, state = node(elements?.[0]), writer = node(elements?.[1]), value = dataValue(arguments_[0], info.data);
            if (binding?.type !== "ArrayPattern" || elements?.length !== 2 || state?.type !== "Identifier" || writer?.type !== "Identifier" || arguments_.length !== 1 || !value) uncertain = true;
            else { info.writers.set(name(writer)!, value); info.bindings.add(writer); info.data.set(name(state)!, value); }
          } else if (operation === "hook:useMutation") {
            const contract = node(arguments_[0]);
            if (binding?.type !== "Identifier" || arguments_.length !== 1 || contract?.type !== "Identifier" || !resolveOperation(module, name(contract)!, "defineMutation")) uncertain = true;
            else { info.mutations.add(name(binding)!); info.bindings.add(binding); }
          } else if (operation === "hook:useEffect") {
            const callback = node(arguments_[0]), dependencies = node(arguments_[1]), actions = callback && isFunction(callback) ? actionCalls(callback, true) : undefined;
            if (!callback || !actions || arguments_.length !== 2 || dependencies?.type !== "ArrayExpression" || (dependencies.elements as unknown[]).some(value => !dataValue(value, info.data))) uncertain = true;
            else { info.callbacks.set(callback, {}); for (const action of actions) info.actions.add(action); }
          }
        }
      }
      walk(view, (item, parent) => {
        if (item.type === "JSXAttribute" && ["ref", "dangerouslySetInnerHTML"].includes(name(item.name) ?? "")) uncertain = true;
        if (item.type === "JSXAttribute" && /^on[A-Z]/.test(name(item.name) ?? "")) {
          const callback = node(node(item.value)?.expression), tag = name(parent?.name);
          if (callback && isFunction(callback) && tag && /^[a-z]/.test(tag)) {
            const actions = actionCalls(callback), parameter = (callback.params as Node[])[0];
            if (!actions) uncertain = true;
            else { info.callbacks.set(callback, parameter ? { event: { name: name(parameter)!, tag } } : {}); for (const action of actions) info.actions.add(action); }
          } else uncertain = true;
        }
        if (item.type !== "JSXExpressionContainer" || parent?.type === "JSXAttribute") return;
        const uses: Node[] = [];
        walk(item.expression, (entry, owner, key) => { if (read(entry, owner, key) && info.queries.has(name(entry)!)) uses.push(entry); });
        if (!uses.length) return;
        const calls = new Set<Node>();
        if (!text(queryText(item.expression, info.queries, new Set(), calls))) { uncertain = true; return; }
        for (const use of uses) info.queryUses.add(use);
        for (const call of calls) pureCalls.add(call);
        replacements.set(item, { queryText: [...new Set(uses.map(use => name(use)))].sort() });
      });
      replacements.set(component, { island: id, parameters: normalized(component.params), hooks: normalized(prefix), view: normalized(view, replacements, true) });
    }
    const visibleQueries = new Map(module.queries);
    for (const binding of module.imports.keys()) { const query = resolveQuery(module, binding); if (query) visibleQueries.set(binding, query); }
    walk(module.program, (item, parent, key, ancestors) => {
      const component = [...ancestors].reverse().find(ancestor => components.has(ancestor)), info = component && proof.get(component);
      const callback = info && [...ancestors].reverse().find(ancestor => info.callbacks.has(ancestor)), context = callback && info?.callbacks.get(callback);
      const inCallback = !!context;
      // Invocation is a positive allowlist. Unknown callbacks, tags, constructors,
      // property effects or mutable code are never inferred safe by name/dataflow.
      if (["TaggedTemplateExpression", "NewExpression", "ImportExpression", "AssignmentExpression", "UpdateExpression", "ClassDeclaration", "ClassExpression"].includes(String(item.type)) || isFunction(item) && (item.async || item.generator) || item.type === "UnaryExpression" && item.operator === "delete" || item.type === "Property" && (item.method || item.kind !== "init")) uncertain = true;
      if (item.type === "JSXOpeningElement" && (node(item.name)?.type !== "JSXIdentifier" || !/^[a-z]/.test(name(item.name) ?? "") && !islands.has(name(item.name)!) && !resolveOperation(module, name(item.name)!, "island"))) uncertain = true;
      if (item.type === "VariableDeclarator" && !ancestors.some(isFunction)) {
        const init = node(item.init), operation = kind(init?.callee);
        const declaration = ancestors.at(-1);
        if (declaration?.kind !== "const" || node(item.id)?.type !== "Identifier" || !(literal(init) !== undefined || init && isFunction(init) || init?.type === "CallExpression" && (["island", "defineQuery", "defineMutation"].includes(operation ?? "") || schemaCall(init, module.imports)))) uncertain = true;
      }
      if (item.type === "CallExpression") {
        const operation = kind(item.callee), callee = node(item.callee);
        const args = item.arguments as unknown[], specification = args[0];
        if (["island", "defineQuery", "defineMutation"].includes(operation ?? "") && (args.length !== 1 || !record(specification) || ["defineQuery", "defineMutation"].includes(operation!) && !["input", "output"].every(key => { const schema = node(property(specification, key)?.value); return schema !== undefined && schemaCall(schema, module.imports); }))) uncertain = true;
        const previous = callee?.type === "Identifier" && info?.writers.get(name(callee)!);
        const updated = previous && info && updateValue(args[0], previous, info.data, context?.event);
        const write = previous && updated && sameValue(previous, updated) && args.length === 1 && info?.actions.has(item) && inCallback;
        const mutation = callee?.type === "MemberExpression" && !callee.computed && info?.mutations.has(name(callee.object)!) && name(callee.property) === "run" && args.length === 1 && dataValue(args[0], info.data, context?.event) && info.actions.has(item) && inCallback;
        const event = context?.event, prevent = event && callee?.type === "MemberExpression" && !callee.computed && name(callee.object) === event.name && name(callee.property) === "preventDefault" && args.length === 0 && info?.actions.has(item);
        if (!(operation?.startsWith("hook:") ? hookCalls.has(item) : ["island", "defineQuery", "defineMutation"].includes(operation ?? "") || schemaCall(item, module.imports) || pureCalls.has(item) || write || mutation || prevent)) uncertain = true;
      }
      if (!read(item, parent, key) || ancestors.some(ancestor => ancestor.type === "ImportDeclaration")) return;
      const binding = name(item)!;
      if (info?.queries.has(binding) && !info.bindings.has(item) && !info.queryUses.has(item)) uncertain = true;
      if (info?.writers.has(binding) && !info.bindings.has(item) && !(parent?.type === "CallExpression" && parent.callee === item && inCallback)) uncertain = true;
      if (info?.mutations.has(binding) && !info.bindings.has(item)) {
        const call = ancestors.at(-2), member = parent?.type === "MemberExpression" && parent.object === item && !parent.computed;
        if (!(member && (["status", "pending", "error", "data"].includes(name(parent.property) ?? "") || name(parent.property) === "run" && call?.type === "CallExpression" && call.callee === parent && inCallback))) uncertain = true;
      }
      const query = visibleQueries.get(binding);
      if (query && query.binding !== item && !definitionUses.has(item) && !["ExportSpecifier", "ExportDefaultDeclaration"].includes(String(parent?.type))) uncertain = true;
      const imported = module.imports.get(binding);
      if (imported && (["fleur/client", "preact/hooks"].includes(imported.source) || imported.source === "fleur/schema" && ["schema", "defineQuery", "defineMutation"].includes(imported.imported))) {
        const direct = parent?.type === "CallExpression" && parent.callee === item && kind(item);
        const member = parent?.type === "MemberExpression" && parent.object === item && ancestors.at(-2)?.type === "CallExpression" && ancestors.at(-2)?.callee === parent && (kind(parent) || schemaCall(ancestors.at(-2)!, module.imports));
        if (!direct && !member) uncertain = true;
      }
    });
  }
  for (const query of referenced) if (published.has(query)) replacements.set(query.output, { output: "validated-before-pure-query-text" });
  const complete = paths.map(path => [relative(project.root, path).replaceAll("\\", "/"), project.sources.get(path)]);
  const fingerprints = [...modules.values()].map(module => [relative(project.root, module.path).replaceAll("\\", "/"), normalized(module.program, replacements)]);
  return createHash("sha256").update(JSON.stringify([2, runtime, styleIdentity(stylesheet), uncertain ? complete : fingerprints])).digest("hex");
}

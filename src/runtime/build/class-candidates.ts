import { parseSync } from "rolldown/utils";
import type { AdmittedProject } from "./admission";

type Node = Record<string, unknown>;
interface Scope { readonly parent?: Scope; readonly bindings: Map<string, Binding>; }
interface Binding { readonly scope: Scope; readonly expression?: Node; readonly imported?: { module: string; name: string }; readonly factory?: "function" | "namespace"; }
interface Module { readonly scope: Scope; readonly exports: Map<string, Binding>; readonly reexports: string[]; }
const node = (value: unknown): Node | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Node : undefined;
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.map(node).filter((value): value is Node => value !== undefined) : [];
const name = (value: unknown): string | undefined => { const item = node(value); return typeof item?.name === "string" ? item.name : typeof item?.value === "string" ? item.value : undefined; };
const lookup = (scope: Scope, name: string): Binding | undefined => scope.bindings.get(name) ?? (scope.parent && lookup(scope.parent, name));

/** Trace presentation values, never arbitrary literals from server modules. */
export function presentationClassStrings(project: AdmittedProject): string[] {
  const modules = new Map<string, Module>(), contexts = new WeakMap<Node, Scope>();
  const sinks: { value: Node; scope: Scope; property?: string }[] = [];
  const calls: { callee: Node; value: Node; scope: Scope }[] = [];
  const declare = (pattern: Node | undefined, expression: Node | undefined, scope: Scope): void => {
    if (pattern?.type === "Identifier") scope.bindings.set(String(pattern.name), { scope, ...(expression ? { expression } : {}) });
    else if (pattern?.type === "ObjectPattern") for (const item of nodes(pattern.properties)) {
      const key = name(item.key);
      if (key && item.type === "Property" && expression) declare(node(item.value), { type: "MemberExpression", object: expression, property: { type: "Literal", value: key }, computed: true }, scope);
    }
  };
  for (const [path, source] of project.sources) {
    const parsed = parseSync(path, source);
    if (parsed.errors.length) throw new Error("SOURCE_REJECTED");
    const scope: Scope = { bindings: new Map() }, module: Module = { scope, exports: new Map(), reexports: [] };
    modules.set(path, module);
    const visit = (value: unknown, outer: Scope): void => {
      if (Array.isArray(value)) { value.forEach(item => visit(item, outer)); return; }
      const item = node(value);
      if (!item || typeof item.type !== "string") return;
      let current = outer;
      if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "BlockStatement"].includes(item.type)) {
        if (item.type === "FunctionDeclaration" && name(item.id)) declare(node(item.id), item, outer);
        current = { parent: outer, bindings: new Map() };
        for (const parameter of nodes(item.params)) declare(parameter, undefined, current);
      }
      contexts.set(item, current);
      if (item.type === "VariableDeclarator") declare(node(item.id), node(item.init), current);
      if (item.type === "ImportDeclaration") {
        const specifier = String(node(item.source)?.value), target = project.resolutions.get(path + "\0" + specifier);
        for (const imported of nodes(item.specifiers)) {
          const local = name(imported.local), exported = imported.type === "ImportDefaultSpecifier" ? "default" : imported.type === "ImportNamespaceSpecifier" ? "*" : name(imported.imported);
          if (!local || !exported) continue;
          if (target) current.bindings.set(local, { scope: current, imported: { module: target, name: exported } });
          else if (["preact", "preact/jsx-runtime", "preact/jsx-dev-runtime"].includes(specifier)) {
            if (["h", "createElement", "jsx", "jsxs", "jsxDEV"].includes(exported)) current.bindings.set(local, { scope: current, factory: "function" });
            else if (["*", "default"].includes(exported)) current.bindings.set(local, { scope: current, factory: "namespace" });
          }
        }
      }
      if (item.type === "JSXAttribute" && ["class", "className"].includes(name(item.name) ?? "")) {
        const value = node(item.value); if (value) sinks.push({ value, scope: current });
      }
      if (item.type === "JSXSpreadAttribute") {
        const value = node(item.argument); if (value) for (const property of ["class", "className"]) sinks.push({ value, scope: current, property });
      }
      if (item.type === "CallExpression") {
        const value = nodes(item.arguments)[1], callee = node(item.callee); if (value && callee) calls.push({ callee, value, scope: current });
      }
      Object.values(item).forEach(child => visit(child, current));
    };
    visit(parsed.program, scope);
    for (const statement of parsed.program.body) {
      const item = statement as unknown as Node;
      if (item.type === "ExportNamedDeclaration") {
        const declaration = node(item.declaration);
        if (declaration?.type === "VariableDeclaration") for (const variable of nodes(declaration.declarations)) {
          const key = name(variable.id), binding = key && scope.bindings.get(key);
          if (key && binding) module.exports.set(key, binding);
        }
        if (declaration?.type === "FunctionDeclaration") { const key = name(declaration.id), binding = key && scope.bindings.get(key); if (key && binding) module.exports.set(key, binding); }
        for (const exported of nodes(item.specifiers)) {
          const local = name(exported.local), key = name(exported.exported);
          const target = project.resolutions.get(path + "\0" + String(node(item.source)?.value));
          const binding = target && local ? { scope, imported: { module: target, name: local } } : local && scope.bindings.get(local);
          if (key && binding) module.exports.set(key, binding);
        }
      } else if (item.type === "ExportDefaultDeclaration") {
        const expression = node(item.declaration); if (expression) module.exports.set("default", { scope, expression });
      } else if (item.type === "ExportAllDeclaration") {
        const target = project.resolutions.get(path + "\0" + String(node(item.source)?.value)); if (target) module.reexports.push(target);
      }
    }
  }
  const exported = (path: string, key: string, seen = new Set<string>()): Binding | undefined => {
    if (seen.has(path)) return;
    seen.add(path);
    const module = modules.get(path);
    return module?.exports.get(key) ?? module?.reexports.map(path => exported(path, key, seen)).find(Boolean);
  };
  const result = new Set<string>();
  const resolveBinding = (binding: Binding | undefined, seen = new Set<Binding>()): Binding | undefined => {
    if (!binding?.imported || binding.imported.name === "*") return binding;
    if (seen.has(binding)) return;
    seen.add(binding);
    return resolveBinding(exported(binding.imported.module, binding.imported.name), seen);
  };
  for (const { callee, value, scope } of calls) {
    const direct = callee.type === "Identifier" && resolveBinding(lookup(scope, String(callee.name)))?.factory === "function";
    const namespace = callee.type === "MemberExpression" && node(callee.object)?.type === "Identifier" && resolveBinding(lookup(scope, String(node(callee.object)?.name)))?.factory === "namespace" && ["h", "createElement", "jsx", "jsxs", "jsxDEV"].includes(name(callee.property) ?? "");
    if (direct || namespace) for (const property of ["class", "className"]) sinks.push({ value, scope, property });
  }
  const trace = (value: Node | undefined, outer: Scope, property?: string, seen = new Set<Binding>(), arguments_: ReadonlyMap<Binding, Binding> = new Map()): void => {
    if (!value || seen.size > 100) return;
    const scope = contexts.get(value) ?? outer;
    const visit = (value: Node | undefined, scope: Scope, property?: string, nextSeen = seen) => trace(value, scope, property, nextSeen, arguments_);
    if (value.type === "Identifier") {
      let binding = resolveBinding(lookup(scope, String(value.name)));
      if (binding?.imported?.name === "*" && property) { binding = resolveBinding(exported(binding.imported.module, property)); property = undefined; }
      if (!binding || seen.has(binding)) return;
      const selected = arguments_.get(binding) ?? binding;
      visit(selected.expression, selected.scope, property, new Set([...seen, binding]));
    } else if (value.type === "ConditionalExpression") {
      visit(node(value.consequent), scope, property); visit(node(value.alternate), scope, property);
    } else if (value.type === "LogicalExpression") {
      if (value.operator !== "&&") visit(node(value.left), scope, property);
      visit(node(value.right), scope, property);
    } else if (value.type === "MemberExpression") {
      const selected = name(value.property);
      if (selected && property === undefined) visit(node(value.object), scope, selected);
    } else if (value.type === "ObjectExpression" && property) {
      for (const member of nodes(value.properties)) {
        if (member.type === "SpreadElement") visit(node(member.argument), scope, property);
        else if (name(member.key) === property) visit(node(member.value), scope);
      }
    } else if (value.type === "CallExpression") {
      const callee = node(value.callee);
      if (callee?.type === "MemberExpression" && ["join", "filter"].includes(name(callee.property) ?? "")) { visit(node(callee.object), scope, property); return; }
      const binding = callee?.type === "Identifier" ? resolveBinding(lookup(scope, String(callee.name))) : undefined;
      const fn = binding?.expression ?? callee;
      if (!fn || !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(String(fn.type)) || binding && seen.has(binding)) return;
      const local = contexts.get(fn) ?? binding?.scope ?? scope;
      const replacements = new Map(arguments_), values = nodes(value.arguments);
      nodes(fn.params).forEach((parameter, index) => {
        const declaration = lookup(local, String(parameter.name));
        const expression = values[index];
        if (declaration && expression) replacements.set(declaration, { scope, expression });
      });
      const nextSeen = binding ? new Set([...seen, binding]) : seen;
      const body = node(fn.body);
      if (body?.type !== "BlockStatement") trace(body, local, property, nextSeen, replacements);
      else {
        const returns = (value: unknown): void => {
          if (Array.isArray(value)) { value.forEach(returns); return; }
          const statement = node(value);
          if (!statement || ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(String(statement.type))) return;
          if (statement.type === "ReturnStatement") trace(node(statement.argument), contexts.get(statement) ?? local, property, nextSeen, replacements);
          else Object.values(statement).forEach(returns);
        };
        returns(body);
      }
    } else if (["JSXExpressionContainer", "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(value.type))) visit(node(value.expression), scope, property);
    else if (property === undefined) {
      if (typeof value.value === "string") result.add(value.value);
      else if (value.type === "TemplateLiteral") {
        for (const quasi of nodes(value.quasis)) { const cooked = node(quasi.value)?.cooked; if (typeof cooked === "string") result.add(cooked); }
        for (const expression of nodes(value.expressions)) visit(expression, scope);
      } else if (value.type === "BinaryExpression" && value.operator === "+") {
        visit(node(value.left), scope); visit(node(value.right), scope);
      } else if (value.type === "ArrayExpression") for (const element of nodes(value.elements)) visit(element, scope);
      else if (value.type === "SequenceExpression") visit(nodes(value.expressions).at(-1), scope);
    }
  };
  for (const sink of sinks) trace(sink.value, sink.scope, sink.property);
  return [...result];
}

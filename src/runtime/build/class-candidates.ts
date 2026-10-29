import { parseSync } from "rolldown/utils";
import type { AdmittedProject } from "./admission";

type Node = Record<string, unknown>;
interface Scope { readonly parent?: Scope; readonly bindings: Map<string, Binding>; readonly function?: boolean; }
interface Binding { readonly scope: Scope; readonly expression?: Node; readonly imported?: { module: string; name: string }; readonly factory?: "function" | "namespace"; }
interface Module { readonly scope: Scope; readonly exports: Map<string, Binding>; readonly reexports: string[]; }
interface Selection { readonly key: string; readonly excluded?: ReadonlySet<string>; }
const node = (value: unknown): Node | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Node : undefined;
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.map(node).filter((value): value is Node => value !== undefined) : [];
const name = (value: unknown): string | undefined => { const item = node(value); return typeof item?.name === "string" ? item.name : typeof item?.value === "string" ? item.value : undefined; };
const lookup = (scope: Scope, name: string): Binding | undefined => scope.bindings.get(name) ?? (scope.parent && lookup(scope.parent, name));
const propertyExpression = (member: Node): Node | undefined => member.computed ? node(member.key) : { type: "Literal", value: name(member.key) };
const restExpression = (pattern: Node, expression: Node): Node => ({ type: "ObjectRest", argument: expression, excluded: nodes(pattern.properties).filter(item => item.type === "Property").map(propertyExpression) });

/** Trace presentation values, never arbitrary literals from server modules. */
export function presentationClassStrings(project: AdmittedProject): string[] {
  const modules = new Map<string, Module>(), contexts = new WeakMap<Node, Scope>();
  const sinks: { value: Node; scope: Scope; property?: string }[] = [];
  const calls: { callee: Node; value: Node; scope: Scope }[] = [];
  const assignments: { target: Node; value: Node; scope: Scope }[] = [];
  const assigned = new Map<Binding, Node[]>();
  const mutations: { target: Node; scope: Scope }[] = [];
  const mutated = new Set<Binding>();
  const declare = (pattern: Node | undefined, expression: Node | undefined, scope: Scope): void => {
    if (pattern?.type === "Identifier") {
      const existing = scope.bindings.get(String(pattern.name));
      if (existing) { if (expression) assigned.set(existing, [...(assigned.get(existing) ?? []), expression]); }
      else scope.bindings.set(String(pattern.name), { scope, ...(expression ? { expression } : {}) });
    }
    else if (pattern?.type === "RestElement") declare(node(pattern.argument), expression, scope);
    else if (pattern?.type === "TSParameterProperty") declare(node(pattern.parameter), expression, scope);
    else if (pattern?.type === "AssignmentPattern") declare(node(pattern.left), expression ? { type: "LogicalExpression", operator: "??", left: expression, right: pattern.right } : node(pattern.right), scope);
    else if (pattern?.type === "ArrayPattern") {
      const elements = Array.isArray(pattern.elements) ? pattern.elements : [];
      elements.forEach((item, index) => declare(node(item), expression ? { type: "MemberExpression", object: expression, property: { type: "Literal", value: index }, computed: true } : undefined, scope));
    }
    else if (pattern?.type === "ObjectPattern") for (const item of nodes(pattern.properties)) {
      const key = name(item.key);
      if (item.type === "RestElement") declare(node(item.argument), expression ? restExpression(pattern, expression) : undefined, scope);
      else if (item.type === "Property") declare(node(item.value), key && expression ? { type: "MemberExpression", object: expression, property: propertyExpression(item), computed: true } : undefined, scope);
    }
  };
  for (const [path, source] of project.sources) {
    const parsed = parseSync(path, source);
    if (parsed.errors.length) throw new Error("SOURCE_REJECTED");
    const scope: Scope = { bindings: new Map(), function: true }, module: Module = { scope, exports: new Map(), reexports: [] };
    modules.set(path, module);
    const visit = (value: unknown, outer: Scope): void => {
      if (Array.isArray(value)) { value.forEach(item => visit(item, outer)); return; }
      const item = node(value);
      if (!item || typeof item.type !== "string") return;
      let current = outer;
      if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(item.type)) {
        if (item.type === "FunctionDeclaration" && name(item.id)) declare(node(item.id), item, outer);
        current = { parent: outer, bindings: new Map(), function: true };
        if (item.type === "FunctionExpression") declare(node(item.id), item, current);
        for (const parameter of nodes(item.params)) declare(parameter, undefined, current);
      } else if (["ClassDeclaration", "ClassExpression", "TSModuleDeclaration", "TSEnumDeclaration"].includes(item.type)) {
        if (item.type !== "ClassExpression") declare(node(item.id), undefined, outer);
        current = { parent: outer, bindings: new Map() };
        declare(node(item.id), undefined, current);
      } else if (item.type === "StaticBlock") {
        current = { parent: outer, bindings: new Map(), function: true };
      } else if (["BlockStatement", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement"].includes(item.type)) {
        current = { parent: outer, bindings: new Map() };
        if (item.type === "CatchClause") declare(node(item.param), undefined, current);
      }
      contexts.set(item, current);
      if (item.type === "VariableDeclaration") {
        let target = current;
        if (item.kind === "var") while (target.parent && !target.function) target = target.parent;
        for (const declaration of nodes(item.declarations)) declare(node(declaration.id), node(declaration.init), target);
      }
      if (item.type === "AssignmentExpression") {
        const target = node(item.left), value = node(item.right);
        if (target && value) assignments.push({ target, value, scope: current });
        if (target?.type === "MemberExpression" && node(target.object)) mutations.push({ target: node(target.object)!, scope: current });
      }
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
        if (callee?.type === "MemberExpression" && ["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"].includes(name(callee.property) ?? "") && node(callee.object)) mutations.push({ target: node(callee.object)!, scope: current });
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
  for (const { target, value, scope } of assignments) {
    const binding = target.type === "Identifier" && lookup(scope, String(target.name));
    if (binding) assigned.set(binding, [...(assigned.get(binding) ?? []), value]);
  }
  const resolveBinding = (binding: Binding | undefined, seen = new Set<Binding>()): Binding | undefined => {
    if (!binding?.imported || binding.imported.name === "*") return binding;
    if (seen.has(binding)) return;
    seen.add(binding);
    return resolveBinding(exported(binding.imported.module, binding.imported.name), seen);
  };
  const markMutation = (value: Node, scope: Scope): void => {
    if (value.type === "Identifier") {
      const binding = resolveBinding(lookup(scope, String(value.name)));
      if (!binding || mutated.has(binding)) return;
      mutated.add(binding);
      if (binding.expression) markMutation(binding.expression, binding.scope);
    } else if (["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(String(value.type)) && node(value.expression)) markMutation(node(value.expression)!, scope);
  };
  for (const mutation of mutations) markMutation(mutation.target, mutation.scope);
  for (const { callee, value, scope } of calls) {
    const direct = callee.type === "Identifier" && resolveBinding(lookup(scope, String(callee.name)))?.factory === "function";
    const namespace = callee.type === "MemberExpression" && node(callee.object)?.type === "Identifier" && resolveBinding(lookup(scope, String(node(callee.object)?.name)))?.factory === "namespace" && ["h", "createElement", "jsx", "jsxs", "jsxDEV"].includes(name(callee.property) ?? "");
    if (direct || namespace) for (const property of ["class", "className"]) sinks.push({ value, scope, property });
  }
  interface Call { readonly values: Node[]; readonly scope: Scope; }
  // An unknown computed key selects any possible value, never the key expression itself.
  const keys = (value: Node | undefined, scope: Scope, seen = new Set<Binding>(), arguments_: ReadonlyMap<Binding, Binding> = new Map()): string[] => {
    if (value) scope = contexts.get(value) ?? scope;
    if (typeof value?.value === "string" || typeof value?.value === "number") return [String(value.value)];
    if (value?.type === "Identifier") {
      const binding = resolveBinding(lookup(scope, String(value.name)));
      const selected = binding && (arguments_.get(binding) ?? binding);
      if (binding && selected && !seen.has(binding)) return keys(selected.expression, selected.scope, new Set([...seen, binding]), arguments_);
    }
    if (value?.type === "ConditionalExpression") return [...new Set([...keys(node(value.consequent), scope, seen, arguments_), ...keys(node(value.alternate), scope, seen, arguments_)])];
    if (value && ["TSAsExpression", "TSTypeAssertion", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(value.type))) return keys(node(value.expression), scope, seen, arguments_);
    return ["*"];
  };
  const arrayLength = (value: Node | undefined, scope: Scope, arguments_: ReadonlyMap<Binding, Binding>, seen = new Set<Binding>()): number | undefined => {
    if (!value) return;
    scope = contexts.get(value) ?? scope;
    if (["TSAsExpression", "TSTypeAssertion", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(value.type))) return arrayLength(node(value.expression), scope, arguments_, seen);
    if (value.type === "Identifier") {
      const binding = resolveBinding(lookup(scope, String(value.name)));
      const selected = binding && (arguments_.get(binding) ?? binding);
      if (binding && selected && !seen.has(binding) && !assigned.has(binding) && !mutated.has(binding)) return arrayLength(selected.expression, selected.scope, arguments_, new Set([...seen, binding]));
    } else if (value.type === "ArrayExpression" && Array.isArray(value.elements)) {
      let length = 0;
      for (const item of value.elements) {
        const element = node(item);
        const count = element?.type === "SpreadElement" ? arrayLength(node(element.argument), scope, arguments_, seen) : 1;
        if (count === undefined) return;
        length += count;
      }
      return length;
    }
  };
  const trace = (value: Node | undefined, outer: Scope, properties: readonly Selection[] = [], seen = new Set<Binding>(), arguments_: ReadonlyMap<Binding, Binding> = new Map(), call?: Call): void => {
    if (!value || seen.size > 100) return;
    const scope = contexts.get(value) ?? outer;
    const visit = (value: Node | undefined, scope: Scope, selected: readonly Selection[] = properties, nextSeen = seen, invocation = call) => trace(value, scope, selected, nextSeen, arguments_, invocation);
    if (value.type === "Identifier") {
      let binding = resolveBinding(lookup(scope, String(value.name)));
      if (binding?.imported?.name === "*" && properties[0]) { binding = resolveBinding(exported(binding.imported.module, properties[0].key)); properties = properties.slice(1); }
      if (!binding || seen.has(binding)) return;
      const selected = arguments_.get(binding) ?? binding;
      const nextSeen = new Set([...seen, binding]);
      visit(selected.expression, selected.scope, properties, nextSeen);
      if (!arguments_.has(binding)) for (const expression of assigned.get(binding) ?? []) visit(expression, binding.scope, properties, nextSeen);
    } else if (value.type === "ConditionalExpression") {
      visit(node(value.consequent), scope); visit(node(value.alternate), scope);
    } else if (value.type === "LogicalExpression") {
      if (value.operator !== "&&") visit(node(value.left), scope);
      visit(node(value.right), scope);
    } else if (value.type === "MemberExpression") {
      const selected = value.computed ? keys(node(value.property), scope, new Set(), arguments_) : [name(value.property)];
      for (const key of selected) if (key) visit(node(value.object), scope, [{ key }, ...properties]);
    } else if (value.type === "ObjectRest" && properties[0]) {
      const definite = nodes(value.excluded).flatMap(value => { const selected = keys(value, scope, new Set(), arguments_); return selected.length === 1 && selected[0] !== "*" ? selected : []; });
      const selected = properties[0], excluded = new Set([...(selected.excluded ?? []), ...definite]);
      if (!excluded.has(selected.key) && !excluded.has("*")) visit(node(value.argument), scope, [{ ...selected, excluded }, ...properties.slice(1)]);
    } else if (value.type === "ObjectExpression" && properties[0]) {
      for (const member of nodes(value.properties)) {
        if (member.type === "SpreadElement") visit(node(member.argument), scope);
        else if (!properties[0].excluded?.has(name(member.key) ?? "") && (properties[0].key === "*" || name(member.key) === properties[0].key)) visit(node(member.value), scope, properties.slice(1));
      }
    } else if (value.type === "ArrayExpression") {
      const elements = Array.isArray(value.elements) ? value.elements : [];
      const selected = properties[0];
      if (!selected || selected.key === "*") for (const element of elements) visit(node(element), scope, properties.slice(1));
      else if (/^(0|[1-9][0-9]*)$/.test(selected.key)) {
        const index = Number(selected.key);
        let offset = 0, uncertain = false;
        for (const item of elements) {
          const element = node(item);
          if (element?.type === "SpreadElement") {
            const argument = node(element.argument), count = arrayLength(argument, scope, arguments_);
            if (offset <= index) {
              const last = Math.min(index - offset, count === undefined ? index - offset : count - 1);
              // Bound uncertain projection work by the admitted source budget.
              if (uncertain && last > 2000) throw new Error("SOURCE_REJECTED");
              for (let position = uncertain ? 0 : index - offset; position <= last; position++) visit(argument, scope, [{ key: String(position) }, ...properties.slice(1)]);
            }
            if (count === undefined) uncertain = true; else offset += count;
          } else {
            if (offset === index || uncertain && offset < index) visit(element, scope, properties.slice(1));
            offset++;
          }
        }
      }
    } else if (value.type === "CallExpression") {
      const callee = node(value.callee);
      if (callee?.type === "MemberExpression" && ["join", "filter"].includes(name(callee.property) ?? "")) { visit(node(callee.object), scope); return; }
      visit(callee, scope, properties, seen, { values: nodes(value.arguments), scope });
    } else if (call && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(String(value.type))) {
      const local = contexts.get(value) ?? scope;
      const replacements = new Map(arguments_);
      const replace = (pattern: Node | undefined, expression: Node | undefined): void => {
        if (!pattern || !expression) return;
        if (pattern.type === "Identifier") {
          const declaration = lookup(local, String(pattern.name));
          if (declaration) replacements.set(declaration, { scope: call.scope, expression });
        } else if (pattern.type === "AssignmentPattern") replace(node(pattern.left), { type: "LogicalExpression", operator: "??", left: expression, right: pattern.right });
        else if (pattern.type === "RestElement") replace(node(pattern.argument), expression);
        else if (pattern.type === "ObjectPattern") for (const member of nodes(pattern.properties)) {
          const key = name(member.key);
          if (member.type === "RestElement") replace(node(member.argument), restExpression(pattern, expression));
          else if (member.type === "Property" && key) replace(node(member.value), { type: "MemberExpression", object: expression, property: propertyExpression(member), computed: true });
        }
        else if (pattern.type === "ArrayPattern" && Array.isArray(pattern.elements)) pattern.elements.forEach((element, index) => replace(node(element), { type: "MemberExpression", object: expression, property: { type: "Literal", value: index }, computed: true }));
      };
      nodes(value.params).forEach((parameter, index) => {
        const rest = parameter.type === "RestElement";
        const expression = rest ? { type: "ArrayExpression", elements: call.values.slice(index) } : call.values[index];
        replace(parameter, expression);
      });
      const body = node(value.body);
      if (body?.type !== "BlockStatement") trace(body, local, properties, seen, replacements);
      else {
        const returns = (value: unknown): void => {
          if (Array.isArray(value)) { value.forEach(returns); return; }
          const statement = node(value);
          if (!statement || ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(String(statement.type))) return;
          if (statement.type === "ReturnStatement") trace(node(statement.argument), contexts.get(statement) ?? local, properties, seen, replacements);
          else Object.values(statement).forEach(returns);
        };
        returns(body);
      }
    } else if (value.type === "SpreadElement") visit(node(value.argument), scope);
    else if (["JSXExpressionContainer", "TSAsExpression", "TSTypeAssertion", "TSInstantiationExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(value.type))) visit(node(value.expression), scope);
    else if (properties.length === 0 && !call) {
      if (typeof value.value === "string") result.add(value.value);
      else if (value.type === "TemplateLiteral") {
        for (const quasi of nodes(value.quasis)) { const cooked = node(quasi.value)?.cooked; if (typeof cooked === "string") result.add(cooked); }
        for (const expression of nodes(value.expressions)) visit(expression, scope);
      } else if (value.type === "BinaryExpression" && value.operator === "+") {
        visit(node(value.left), scope); visit(node(value.right), scope);
      } else if (value.type === "SequenceExpression") visit(nodes(value.expressions).at(-1), scope);
    }
  };
  for (const sink of sinks) trace(sink.value, sink.scope, sink.property ? [{ key: sink.property }] : []);
  return [...result];
}

import { parseSync } from "rolldown/utils";
import { relative } from "node:path";
import type { AdmittedProject } from "./admission";
import { SourceAdmissionError } from "./diagnostics";

type Node = Record<string, unknown>;
interface Scope { readonly parent?: Scope; readonly bindings: Map<string, Binding>; readonly function?: boolean; }
interface Binding { readonly scope: Scope; readonly expression?: Node; readonly point?: Point; readonly imported?: { module: string; name: string }; readonly factory?: "function" | "namespace"; }
interface Module { readonly scope: Scope; readonly exports: Map<string, Binding>; readonly reexports: string[]; }
interface Selection { readonly key: string; readonly excluded?: ReadonlySet<string>; }
interface Point { readonly value: Node; readonly scope: Scope; readonly offset?: number; readonly caller?: Point; readonly bindings?: ReadonlyMap<Binding, Binding>; }
interface ResolvedValue extends Point { readonly read: Point; readonly arguments: ReadonlyMap<Binding, Binding>; }
interface Effect extends Point { readonly conditional: boolean; }
interface Mutation extends Effect { readonly target: Node; readonly key?: Node; readonly replacement?: Node; readonly method?: string; readonly arguments?: Node[]; }
const node = (value: unknown): Node | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Node : undefined;
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.map(node).filter((value): value is Node => value !== undefined) : [];
const name = (value: unknown): string | undefined => { const item = node(value); return typeof item?.name === "string" ? item.name : typeof item?.value === "string" ? item.value : undefined; };
const lookup = (scope: Scope, name: string): Binding | undefined => scope.bindings.get(name) ?? (scope.parent && lookup(scope.parent, name));
const propertyExpression = (member: Node): Node | undefined => member.computed ? node(member.key) : { type: "Literal", value: name(member.key) };
const restExpression = (pattern: Node, expression: Node): Node => ({ type: "ObjectRest", argument: expression, excluded: nodes(pattern.properties).filter(item => item.type === "Property").map(propertyExpression) });
const execution = (scope: Scope): Scope => scope.function || !scope.parent ? scope : execution(scope.parent);
const position = (value: Node): number => typeof value.start === "number" ? value.start : 0;
const completion = (value: Node): number => typeof value.end === "number" ? value.end : position(value);
const terminates = (value: Node | undefined): boolean => {
  if (!value) return false;
  if (["ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement"].includes(String(value.type))) return true;
  if (value.type === "BlockStatement") return nodes(value.body).some(terminates);
  if (value.type === "IfStatement") return terminates(node(value.consequent)) && terminates(node(value.alternate));
  return false;
};
const mayTerminate = (value: Node | undefined): boolean => {
  if (!value) return false;
  if (terminates(value)) return true;
  if (value.type === "BlockStatement") return nodes(value.body).some(mayTerminate);
  if (value.type === "IfStatement") return mayTerminate(node(value.consequent)) || mayTerminate(node(value.alternate));
  return false;
};

/** Trace presentation values, never arbitrary literals from server modules. */
export function presentationClassStrings(project: AdmittedProject): string[] {
  const modules = new Map<string, Module>(), contexts = new WeakMap<Node, Scope>();
  const sourceFiles = new WeakMap<Scope, { path: string; source: string }>();
  const repeated = new WeakSet<Node>();
  const unreachable = new WeakSet<Node>();
  const sinks: { value: Node; scope: Scope; property?: string }[] = [];
  const calls: (Effect & { callee: Node })[] = [];
  const assignments: (Effect & { target: Node; replacement: Node })[] = [];
  const mutations: Mutation[] = [];
  const declare = (pattern: Node | undefined, expression: Node | undefined, scope: Scope): void => {
    if (pattern?.type === "Identifier") {
      const existing = scope.bindings.get(String(pattern.name));
      if (existing) { if (expression) assignments.push({ target: pattern, value: expression, replacement: expression, scope, conditional: true }); }
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
    sourceFiles.set(scope, { path, source });
    modules.set(path, module);
    const visit = (value: unknown, outer: Scope, conditional = false, looping = false, reachable = true): void => {
      if (Array.isArray(value)) { value.forEach(item => visit(item, outer, conditional, looping, reachable)); return; }
      const item = node(value);
      if (!item || typeof item.type !== "string") return;
      let current = outer;
      if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(item.type)) {
        if (item.type === "FunctionDeclaration" && name(item.id)) declare(node(item.id), item, outer);
        current = { parent: outer, bindings: new Map(), function: true };
        conditional = false;
        looping = false;
        reachable = true;
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
      if (looping) repeated.add(item);
      if (!reachable) unreachable.add(item);
      if (item.type === "VariableDeclaration") {
        let target = current;
        if (item.kind === "var") while (target.parent && !target.function) target = target.parent;
        for (const declaration of nodes(item.declarations)) declare(node(declaration.id), node(declaration.init), target);
      }
      if (reachable && item.type === "AssignmentExpression") {
        const target = node(item.left), value = node(item.right);
        if (target && value) assignments.push({ target, value: item, replacement: value, scope: current, conditional });
        if (target?.type === "MemberExpression" && node(target.object)) {
          const key = target.computed ? node(target.property) : { type: "Literal", value: name(target.property) };
          mutations.push({ target: node(target.object)!, value: item, scope: current, conditional, ...(key ? { key } : {}), ...(item.operator === "=" && value ? { replacement: value } : {}) });
        }
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
      if (reachable && item.type === "JSXAttribute" && ["class", "className"].includes(name(item.name) ?? "")) {
        const value = node(item.value); if (value) sinks.push({ value, scope: current });
      }
      if (reachable && item.type === "JSXSpreadAttribute") {
        const value = node(item.argument); if (value) for (const property of ["class", "className"]) sinks.push({ value, scope: current, property });
      }
      if (reachable && item.type === "CallExpression") {
        const callee = node(item.callee); if (callee) calls.push({ callee, value: item, scope: current, conditional });
        if (callee?.type === "MemberExpression" && ["pop", "push", "shift", "splice", "unshift", "reverse", "sort", "fill", "copyWithin"].includes(name(callee.property) ?? "") && node(callee.object)) mutations.push({ target: node(callee.object)!, value: item, scope: current, conditional, method: name(callee.property)!, arguments: nodes(item.arguments) });
      }
      for (const [key, child] of Object.entries(item)) {
        if (key === "body" && ["BlockStatement", "Program"].includes(item.type)) {
          let active = reachable, possibleExit = false;
          for (const statement of nodes(child)) {
            visit(statement, current, conditional || possibleExit, looping, active);
            if (terminates(statement)) active = false;
            if (mayTerminate(statement)) possibleExit = true;
          }
          continue;
        }
        const once = item.type === "DoWhileStatement" && node(item.test)?.type === "Literal" && node(item.test)?.value === false;
        const branch = ["IfStatement", "ConditionalExpression"].includes(item.type) && ["consequent", "alternate"].includes(key) || item.type === "LogicalExpression" && key === "right" || !once && ["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "SwitchStatement"].includes(item.type);
        const repeats = !once && ["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"].includes(item.type) && !["init", "right"].includes(key);
        visit(child, current, conditional || branch, looping || repeats, reachable);
      }
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
    const props = nodes(value.arguments)[1];
    if (props && (direct || namespace)) for (const property of ["class", "className"]) sinks.push({ value: props, scope, property });
  }
  interface Call { readonly values: Node[]; readonly scope: Scope; readonly point: Point; }
  type Primitive = string | number | boolean | null | undefined;
  const constants = (value: Node | undefined, scope: Scope, point: Point, arguments_: ReadonlyMap<Binding, Binding>, seen = new Map<Binding, Point>()): Primitive[] | undefined => {
    if (!value) return [undefined];
    scope = contexts.get(value) ?? scope;
    if (value.type === "Literal" && (value.value === null || ["string", "number", "boolean"].includes(typeof value.value))) return [value.value as Primitive];
    if (value.type === "ProjectedValue") {
      const read = value.point as Point;
      return constants(node(value.expression), read.scope, read, value.arguments as ReadonlyMap<Binding, Binding>, seen);
    }
    if (["TSAsExpression", "TSTypeAssertion", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(value.type))) return constants(node(value.expression), scope, point, arguments_, seen);
    const combine = (possibilities: (Primitive[] | undefined)[]): Primitive[] | undefined => {
      if (possibilities.some(value => value === undefined)) return;
      const values = [...new Set(possibilities.flatMap(value => value!))];
      if (values.length > 128) throw new Error("SOURCE_REJECTED");
      return values;
    };
    if (value.type === "ProjectedUnion") return combine(nodes(value.values).map(value => constants(value, scope, point, arguments_, seen)));
    if (value.type === "ConditionalExpression") return combine([constants(node(value.consequent), scope, point, arguments_, seen), constants(node(value.alternate), scope, point, arguments_, seen)]);
    if (value.type === "Identifier") {
      const binding = resolveBinding(lookup(scope, String(value.name)));
      if (!binding) return value.name === "undefined" ? [undefined] : undefined;
      if (seen.has(binding) && !before(point, seen.get(binding)!) || seen.size > 100) return;
      const expressions = bindingValues(binding, point, arguments_);
      return expressions.length ? combine(expressions.map(expression => constants(expression.value, expression.scope, expression.read, expression.arguments, new Map([...seen, [binding, point]])))) : undefined;
    }
    if (value.type === "UnaryExpression") {
      if (value.operator === "void") return [undefined];
      const values = constants(node(value.argument), scope, point, arguments_, seen);
      if (value.operator === "-") return values?.map(value => -Number(value));
      if (value.operator === "+") return values?.map(value => Number(value));
      if (value.operator === "!") return values?.map(value => !value);
    }
    if (value.type === "BinaryExpression" || value.type === "LogicalExpression") {
      const left = constants(node(value.left), scope, point, arguments_, seen), right = constants(node(value.right), scope, point, arguments_, seen);
      if (!left || !right) return;
      const operation = (left: Primitive, right: Primitive): Primitive => {
        switch (value.operator) {
          case "+": return typeof left === "string" || typeof right === "string" ? String(left) + String(right) : Number(left) + Number(right);
          case "-": return Number(left) - Number(right);
          case "*": return Number(left) * Number(right);
          case "/": return Number(left) / Number(right);
          case "%": return Number(left) % Number(right);
          case "&&": return left && right;
          case "||": return left || right;
          case "??": return left ?? right;
          default: return undefined;
        }
      };
      if (!["+", "-", "*", "/", "%", "&&", "||", "??"].includes(String(value.operator))) return;
      return combine(left.map(value => right.map(other => operation(value, other))));
    }
  };
  // An unknown computed key selects any possible value, never the key expression itself.
  const keys = (value: Node | undefined, scope: Scope, point: Point, arguments_: ReadonlyMap<Binding, Binding>): string[] => constants(value, scope, point, arguments_)?.map(String) ?? ["*"];
  const before = (effect: Point, point: Point): boolean => {
    const owner = execution(effect.scope), reader = execution(point.scope);
    for (let writer: Point | undefined = effect; writer; writer = writer.caller)
      for (let frame: Point | undefined = point; frame; frame = frame.caller)
        if (execution(frame.scope) === execution(writer.scope)) return completion(writer.value) < (frame.offset ?? position(frame.value));
    for (let writer: Point | undefined = effect; writer; writer = writer.caller)
      for (let ancestor = reader.parent; ancestor; ancestor = ancestor.parent)
        if (ancestor === execution(writer.scope)) return true;
    // Imported module initialization completes before a function can read it.
    return !owner.parent && !!reader.parent;
  };
  const located = (value: Node, scope: Scope, context?: Point): Point => {
    for (let frame = context; frame; frame = frame.caller) if (execution(frame.scope) === execution(scope)) return { value, scope, ...(frame.caller ? { caller: frame.caller } : {}) };
    return { value, scope };
  };
  const bindingValues = (binding: Binding, point: Point, arguments_: ReadonlyMap<Binding, Binding>): ResolvedValue[] => {
    const selected = arguments_.get(binding) ?? binding;
    const origin = located(selected.expression ?? { type: "Empty", start: 0 }, selected.scope, point);
    let values: ResolvedValue[] = selected.expression ? [{ ...origin, read: selected.point ?? origin, arguments: arguments_ }] : [];
    if (!arguments_.has(binding)) for (const effect of effects(origin, point, arguments_)) {
      if (effect.binding !== binding || !effect.mutation.replacement) continue;
      const replacement = { value: effect.mutation.replacement, scope: effect.mutation.scope, read: effect.point, arguments: effect.arguments };
      const operator = effect.mutation.value.operator;
      if (typeof operator === "string" && operator !== "=") {
        const previous = { type: "ProjectedUnion", values: values.map(value => captured(value.value, value.read, value.arguments)) };
        replacement.value = { type: ["&&=", "||=", "??="].includes(operator) ? "LogicalExpression" : "BinaryExpression", operator: operator.slice(0, -1), left: previous, right: captured(replacement.value, replacement.read, replacement.arguments) };
      }
      values = effect.optional ? [...values, replacement] : [replacement];
    }
    return values;
  };
  const origins = (value: Node | undefined, scope: Scope, point: Point, arguments_: ReadonlyMap<Binding, Binding>, seen = new Map<Binding, Point>()): Point[] | undefined => {
    if (!value || seen.size > 100) return;
    scope = contexts.get(value) ?? scope;
    if (value.type === "ProjectedValue") {
      const read = value.point as Point;
      return origins(node(value.expression), read.scope, read, value.arguments as ReadonlyMap<Binding, Binding>, seen);
    }
    if (value.type === "ArrayExpression") return [{ ...located(value, scope, point), bindings: arguments_ }];
    if (["TSAsExpression", "TSTypeAssertion", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(value.type))) return origins(node(value.expression), scope, point, arguments_, seen);
    if (value.type === "ConditionalExpression") {
      const left = origins(node(value.consequent), scope, point, arguments_, seen), right = origins(node(value.alternate), scope, point, arguments_, seen);
      return left && right ? [...left, ...right] : undefined;
    }
    if (value.type !== "Identifier") return;
    const binding = resolveBinding(lookup(scope, String(value.name)));
    if (!binding || seen.has(binding) && !before(point, seen.get(binding)!)) return;
    const nextSeen = new Map([...seen, [binding, point]]), expressions = bindingValues(binding, point, arguments_);
    const resolved = expressions.map(expression => origins(expression.value, expression.scope, expression.read, expression.arguments, nextSeen));
    return resolved.length && resolved.every(value => value !== undefined) ? resolved.flatMap(value => value!) : undefined;
  };
  interface AppliedMutation { readonly mutation: Mutation; readonly binding?: Binding; readonly point: Point; readonly optional: boolean; readonly repeated: boolean; readonly arguments: ReadonlyMap<Binding, Binding>; }
  const argumentValues = (values: Node[], scope: Scope, point: Point, arguments_: ReadonlyMap<Binding, Binding>, seen = new Set<Node>()): Node[][] | undefined => {
    let alternatives: Node[][] = [[]];
    for (const value of values) {
      const read = located(value, scope, point);
      const choices = value.type === "SpreadElement" ? arrays(node(value.argument), scope, read, arguments_, seen) : [[captured(value, read, arguments_)]];
      if (!choices) return;
      alternatives = bounded(alternatives.flatMap(prefix => choices.map(suffix => [...prefix, ...suffix])));
    }
    return alternatives;
  };
  const effects = (origin: Point, point: Point, arguments_: ReadonlyMap<Binding, Binding>): AppliedMutation[] => {
    const collected: AppliedMutation[] = [];
    const collect = (owner: Scope, limit: Point, inherited: ReadonlyMap<Binding, Binding>, optional = false, looping = false, invocation?: Point, seen = new Set<Scope>()): void => {
      if (seen.has(owner) || seen.size > 100) return;
      const nextSeen = new Set([...seen, owner]);
      const events = [...mutations, ...assignments.filter(event => event.target.type === "Identifier"), ...calls].filter(event => execution(event.scope) === owner && (invocation || before(event, limit)) && (execution(origin.scope) !== owner || position(event.value) > position(origin.value))).sort((left, right) => completion(left.value) - completion(right.value));
      for (const event of events) {
        const eventPoint = { ...(invocation ? { value: event.value, scope: event.scope, caller: invocation } : located(event.value, event.scope, limit)), offset: completion(event.value) };
        if ("target" in event) {
          const binding = assignments.some(assignment => assignment === event) ? resolveBinding(lookup(event.scope, String(event.target.name))) : undefined;
          collected.push({ mutation: event, ...(binding ? { binding } : {}), point: eventPoint, optional: optional || event.conditional, repeated: looping || repeated.has(event.value), arguments: inherited });
          continue;
        }
        const binding = event.callee.type === "Identifier" ? resolveBinding(lookup(event.scope, String(event.callee.name))) : undefined;
        const fn = binding?.expression, local = fn && contexts.get(fn);
        if (!fn || !local || !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(String(fn.type))) continue;
        const possibilities = argumentValues(nodes(event.value.arguments), event.scope, eventPoint, inherited);
        if (!possibilities) continue;
        for (const values of possibilities) {
          const replacements = new Map(inherited);
          nodes(fn.params).forEach((parameter, index) => {
            const argument = values[index], parameterBinding = parameter.type === "Identifier" && lookup(local, String(parameter.name));
            if (parameterBinding && argument) replacements.set(parameterBinding, { scope: event.scope, expression: argument, point: eventPoint });
          });
          collect(local, event, replacements, optional || event.conditional || possibilities.length > 1, looping || repeated.has(event.value), eventPoint, nextSeen);
        }
      }
    };
    const owners: Scope[] = [];
    const frames: Point[] = [];
    for (let frame: Point | undefined = point; frame; frame = frame.caller) frames.unshift(frame);
    for (const frame of frames) {
      const ancestors: Scope[] = [];
      for (let scope: Scope | undefined = execution(frame.scope); scope; scope = scope.parent ? execution(scope.parent) : undefined) ancestors.unshift(scope);
      for (const owner of ancestors) if (!owners.includes(owner)) owners.push(owner);
    }
    const allocationOwner = execution(origin.scope);
    if (!allocationOwner.parent && owners.includes(allocationOwner)) owners.splice(owners.indexOf(allocationOwner), 1);
    if (!owners.includes(allocationOwner)) owners.unshift(allocationOwner);
    for (const owner of owners) collect(owner, point, arguments_);
    return collected;
  };
  const bounded = (arrays: Node[][]): Node[][] => {
    if (arrays.length > 128 || arrays.some(array => array.length > 2000)) throw new Error("SOURCE_REJECTED");
    return arrays;
  };
  const unresolvedSort = (mutation: Mutation): never => {
    let scope = mutation.scope;
    while (scope.parent) scope = scope.parent;
    const file = sourceFiles.get(scope);
    throw new SourceAdmissionError(file ? relative(project.root, file.path) : "application source", file ? file.source.slice(0, position(mutation.value)).split("\n").length : 1, "UNRESOLVED_CLASS_SORT", "Select complete classes explicitly or use a statically resolvable pure sort comparator.");
  };
  const captured = (value: Node | undefined, point: Point, arguments_: ReadonlyMap<Binding, Binding>): Node => ({ type: "ProjectedValue", expression: value, point, arguments: arguments_ });
  const pureConstantExpression = (value: Node | undefined): boolean => {
    if (!value || !["Literal", "Identifier", "UnaryExpression", "BinaryExpression", "LogicalExpression", "ConditionalExpression", "TSAsExpression", "TSTypeAssertion", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(value.type))) return false;
    if (value.type === "UnaryExpression" && value.operator === "delete") return false;
    return Object.values(value).every(child => {
      const expression = node(child);
      return !expression || typeof expression.type !== "string" || pureConstantExpression(expression);
    });
  };
  const functionValue = (value: Node | undefined, scope: Scope, point: Point, arguments_: ReadonlyMap<Binding, Binding>, seen = new Set<Binding>()): ResolvedValue | undefined => {
    if (!value) return;
    scope = contexts.get(value) ?? scope;
    if (value.type === "ProjectedValue") {
      const capturedPoint = value.point as Point;
      return functionValue(node(value.expression), capturedPoint.scope, capturedPoint, value.arguments as ReadonlyMap<Binding, Binding>, seen);
    }
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(String(value.type))) return { value, scope, read: point, arguments: arguments_ };
    if (["TSAsExpression", "TSTypeAssertion", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(value.type))) return functionValue(node(value.expression), scope, point, arguments_, seen);
    if (value.type === "Identifier") {
      const binding = resolveBinding(lookup(scope, String(value.name)));
      if (!binding || seen.has(binding) || seen.size > 100) return;
      const possible = bindingValues(binding, point, arguments_);
      if (possible.length === 1) {
        const expression = possible[0]!;
        return functionValue(expression.value, expression.scope, expression.read, expression.arguments, new Set([...seen, binding]));
      }
    }
  };
  // Each alternative describes one array allocation at the read point. Copies
  // capture their elements at creation; aliases retain the allocation identity.
  const arrays = (value: Node | undefined, scope: Scope, point: Point, arguments_: ReadonlyMap<Binding, Binding>, seen = new Set<Node>()): Node[][] | undefined => {
    const allocations = origins(value, scope, point, arguments_);
    if (!allocations) return;
    const result: Node[][] = [];
    for (const origin of allocations) {
      if (seen.has(origin.value)) return;
      const nextSeen = new Set([...seen, origin.value]);
      const bindings = origin.bindings ?? arguments_;
      let alternatives: Node[][] = [[]];
      for (const item of Array.isArray(origin.value.elements) ? origin.value.elements : []) {
        const element = node(item);
        const read = element ? located(element, origin.scope, origin) : origin;
        const choices = element?.type === "SpreadElement" ? arrays(node(element.argument), origin.scope, read, bindings, nextSeen) : [[captured(element, read, bindings)]];
        if (!choices) return;
        alternatives = bounded(alternatives.flatMap(prefix => choices.map(suffix => [...prefix, ...suffix])));
      }
      for (const effect of effects(origin, point, arguments_)) {
        if (effect.binding) continue;
        const mutation = effect.mutation;
        const targets = origins(mutation.target, mutation.scope, effect.point, effect.arguments);
        if (!targets?.some(target => target.value === origin.value)) continue;
        if (effect.repeated && ["pop", "shift"].includes(mutation.method ?? "")) {
          // A loop can remove any prefix/suffix, including every element. Keep
          // the finite states instead of assuming that its body runs once.
          if (alternatives.reduce((count, values) => count + values.length + 1, 0) > 128) return;
          alternatives = alternatives.flatMap(values => Array.from({ length: values.length + 1 }, (_, count) => mutation.method === "pop" ? values.slice(0, count) : values.slice(count)));
          continue;
        }
        if (effect.repeated && ["push", "unshift", "splice"].includes(mutation.method ?? "")) return;
        const optional = effect.optional || targets.some(target => target.value !== origin.value);
        const selected = mutation.key ? keys(mutation.key, mutation.scope, located(mutation.key, mutation.scope, effect.point), effect.arguments) : [];
        const numeric = (value: Node | undefined): number | undefined => {
          const values = keys(value, mutation.scope, effect.point, effect.arguments);
          const result = values.length === 1 && values[0] !== "*" ? Number(values[0]) : NaN;
          return Number.isSafeInteger(result) ? result : undefined;
        };
        const insertions = (values: Node[]): Node[][] | undefined => argumentValues(values, mutation.scope, effect.point, effect.arguments, nextSeen);
        const transformed: Node[][] = [];
        for (const previous of alternatives) {
          const next = [...previous], argumentsList = mutation.arguments ?? [];
          const at = (index: number) => captured(argumentsList[index], effect.point, effect.arguments);
          if (selected.length) {
            if (selected.length !== 1 || !mutation.replacement) return;
            if (selected[0] === "length") {
              const length = numeric(mutation.replacement);
              if (length === undefined || length < 0) return;
              if (length > 2000) throw new Error("SOURCE_REJECTED");
              next.length = length;
              for (let index = previous.length; index < length; index++) next[index] = captured(undefined, effect.point, effect.arguments);
            } else if (/^(0|[1-9][0-9]*)$/.test(selected[0]!)) {
              const index = Number(selected[0]);
              if (index >= 2000) throw new Error("SOURCE_REJECTED");
              while (next.length <= index) next.push(captured(undefined, effect.point, effect.arguments));
              next[index] = captured(mutation.replacement, effect.point, effect.arguments);
            }
          } else if (mutation.method === "pop") next.pop();
          else if (mutation.method === "shift") next.shift();
          else if (mutation.method === "push" || mutation.method === "unshift") {
            const additions = insertions(argumentsList);
            if (!additions) return;
            transformed.push(...additions.map(items => mutation.method === "push" ? [...next, ...items] : [...items, ...next]));
            continue;
          }
          else if (mutation.method === "reverse") next.reverse();
          else if (mutation.method === "sort") {
            const comparator = constants(argumentsList[0], mutation.scope, effect.point, effect.arguments);
            if (comparator?.length === 1 && comparator[0] === undefined) {
              const ordered = previous.map(value => ({ value, known: constants(value, mutation.scope, effect.point, effect.arguments) }));
              if (ordered.some(item => item.known?.length !== 1)) unresolvedSort(mutation);
              ordered.sort((left, right) => {
                const a = left.known![0], b = right.known![0];
                return a === undefined ? b === undefined ? 0 : 1 : b === undefined ? -1 : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
              });
              next.splice(0, next.length, ...ordered.map(item => item.value));
            } else {
              const fn = functionValue(argumentsList[0], mutation.scope, effect.point, effect.arguments);
              if (!fn) return unresolvedSort(mutation);
              const body = node(fn.value.body), statements = body?.type === "BlockStatement" ? nodes(body.body).filter(value => !unreachable.has(value) && value.type !== "EmptyStatement") : [];
              if (body?.type === "BlockStatement" && (statements.length !== 1 || statements[0]?.type !== "ReturnStatement")) unresolvedSort(mutation);
              const returned = body?.type === "BlockStatement" ? node(statements[0]?.argument) : body;
              if (!pureConstantExpression(returned)) unresolvedSort(mutation);
              const entries = previous.map(value => ({ value, known: constants(value, mutation.scope, effect.point, effect.arguments) }));
              if (entries.some(entry => entry.known?.length !== 1)) unresolvedSort(mutation);
              const defined = entries.filter(entry => entry.known![0] !== undefined).map(entry => entry.value);
              // JavaScript never passes undefined entries or holes to a sort
              // comparator. Both follow all defined values in the result.
              defined.sort((left, right) => {
                const replacements = new Map(fn.arguments);
                nodes(fn.value.params).forEach((parameter, index) => {
                  const binding = parameter.type === "Identifier" && lookup(fn.scope, String(parameter.name));
                  if (!binding) return unresolvedSort(mutation);
                  replacements.set(binding, { scope: mutation.scope, expression: index === 0 ? left : index === 1 ? right : captured(undefined, effect.point, effect.arguments), point: effect.point });
                });
                const result = constants(returned, fn.scope, { value: returned ?? fn.value, scope: fn.scope, caller: effect.point }, replacements);
                if (result?.length !== 1) return unresolvedSort(mutation);
                return Number(result[0]) || 0;
              });
              next.splice(0, next.length, ...defined, ...entries.filter(entry => entry.known![0] === undefined).map(entry => entry.value));
            }
          } else if (mutation.method === "fill") {
            const start = argumentsList[1] ? numeric(argumentsList[1]) : 0, end = argumentsList[2] ? numeric(argumentsList[2]) : next.length;
            if (start === undefined || end === undefined) for (let index = 0; index < next.length; index++) next[index] = { type: "ProjectedUnion", values: [next[index], at(0)] };
            else next.fill(at(0), start, end);
          } else if (mutation.method === "copyWithin") {
            const target = numeric(argumentsList[0]), start = numeric(argumentsList[1]), end = argumentsList[2] ? numeric(argumentsList[2]) : next.length;
            if (target === undefined || start === undefined || end === undefined) next.fill({ type: "ProjectedUnion", values: previous });
            else next.copyWithin(target, start, end);
          } else if (mutation.method === "splice") {
            const start = numeric(argumentsList[0]), count = argumentsList[1] ? numeric(argumentsList[1]) : next.length;
            if (start === undefined || count === undefined) return;
            const additions = insertions(argumentsList.slice(2));
            if (!additions) return;
            transformed.push(...additions.map(items => { const values = [...next]; values.splice(start, count, ...items); return values; }));
            continue;
          }
          transformed.push(next);
        }
        alternatives = bounded(optional ? [...alternatives, ...transformed] : transformed);
      }
      result.push(...alternatives);
      bounded(result);
    }
    return result;
  };
  const trace = (value: Node | undefined, outer: Scope, properties: readonly Selection[] = [], seen = new Map<Binding, Point>(), arguments_: ReadonlyMap<Binding, Binding> = new Map(), call?: Call, point?: Point): void => {
    if (!value || seen.size > 100) return;
    const scope = contexts.get(value) ?? outer;
    const read = point ?? { value, scope };
    const visit = (value: Node | undefined, scope: Scope, selected: readonly Selection[] = properties, nextSeen = seen, invocation = call) => trace(value, scope, selected, nextSeen, arguments_, invocation, point);
    if (value.type === "ProjectedValue") {
      const capturedPoint = value.point as Point;
      trace(node(value.expression), capturedPoint.scope, properties, seen, value.arguments as ReadonlyMap<Binding, Binding>, call, capturedPoint);
      return;
    }
    if (value.type === "ProjectedUnion") { for (const item of nodes(value.values)) visit(item, scope); return; }
    if (["Identifier", "ArrayExpression"].includes(String(value.type)) && !call) {
      const projected = arrays(value, scope, read, arguments_);
      if (projected) {
        const selected = properties[0];
        for (const values of projected) {
          if (!selected || selected.key === "*") for (const item of values) visit(item, scope, properties.slice(1));
          else if (/^(0|[1-9][0-9]*)$/.test(selected.key)) visit(values[Number(selected.key)], scope, properties.slice(1));
        }
        return;
      }
    }
    if (value.type === "Identifier") {
      let binding = resolveBinding(lookup(scope, String(value.name)));
      if (binding?.imported?.name === "*" && properties[0]) { binding = resolveBinding(exported(binding.imported.module, properties[0].key)); properties = properties.slice(1); }
      if (!binding || seen.has(binding) && (call || !before(read, seen.get(binding)!))) return;
      const nextSeen = new Map([...seen, [binding, read]]);
      for (const expression of bindingValues(binding, read, arguments_)) trace(expression.value, expression.scope, properties, nextSeen, expression.arguments, call, expression.read);
    } else if (value.type === "ConditionalExpression") {
      visit(node(value.consequent), scope); visit(node(value.alternate), scope);
    } else if (value.type === "LogicalExpression") {
      if (value.operator !== "&&") visit(node(value.left), scope);
      visit(node(value.right), scope);
    } else if (value.type === "MemberExpression") {
      const selected = value.computed ? keys(node(value.property), scope, read, arguments_) : [name(value.property)];
      for (const key of selected) if (key) visit(node(value.object), scope, [{ key }, ...properties]);
    } else if (value.type === "ObjectRest" && properties[0]) {
      const definite = nodes(value.excluded).flatMap(value => { const selected = keys(value, scope, located(value, scope, read), arguments_); return selected.length === 1 && selected[0] !== "*" ? selected : []; });
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
            const argument = node(element.argument), projected = arrays(argument, scope, read, arguments_);
            const lengths = new Set(projected?.map(value => value.length));
            const count = lengths.size === 1 ? [...lengths][0] : undefined;
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
      const invocation = { ...located(value, scope, read), offset: completion(value) };
      const possibilities = argumentValues(nodes(value.arguments), scope, invocation, arguments_);
      if (possibilities) for (const values of possibilities) visit(callee, scope, properties, seen, { values, scope, point: invocation });
    } else if (call && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(String(value.type))) {
      const local = contexts.get(value) ?? scope;
      const replacements = new Map(arguments_);
      const replace = (pattern: Node | undefined, expression: Node | undefined): void => {
        if (!pattern || !expression) return;
        if (pattern.type === "Identifier") {
          const declaration = lookup(local, String(pattern.name));
          if (declaration) replacements.set(declaration, { scope: call.scope, expression, point: call.point });
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
        const expression = rest ? { type: "ArrayExpression", elements: call.values.slice(index), start: position(call.point.value) } : call.values[index];
        replace(parameter, expression);
      });
      const body = node(value.body);
      if (body?.type !== "BlockStatement") trace(body, local, properties, seen, replacements, undefined, body ? { value: body, scope: local, caller: call.point } : undefined);
      else {
        const returns = (value: unknown): void => {
          if (Array.isArray(value)) { value.forEach(returns); return; }
          const statement = node(value);
          if (!statement || unreachable.has(statement) || ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(String(statement.type))) return;
          if (statement.type === "ReturnStatement") trace(node(statement.argument), contexts.get(statement) ?? local, properties, seen, replacements, undefined, { value: statement, scope: contexts.get(statement) ?? local, caller: call.point });
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

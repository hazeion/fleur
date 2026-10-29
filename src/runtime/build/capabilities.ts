// This analysis distinguishes ambient capability references from ordinary data
// and lexical bindings. It is an admission check, not a replacement for the
// native worker, browser transport/DOM guards or CSP.
type Node = Record<string, unknown>;
type Kind = "unknown" | "global" | "navigator" | "document" | "element" | "parser" | "function" | "factory" | "preact" | "timer" | "reflect" | "reflect-get" | "transport" | "executable" | "injection";
interface Scope { parent?: Scope; bindings: Map<string, Binding>; }
interface Binding { scope: Scope; expression?: Node; kind?: Kind; }
const node = (value: unknown): Node | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Node : undefined;
const executable = new Set(["eval", "Function", "AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction", "require", "Worker", "SharedWorker", "importScripts", "WebAssembly", "Bun", "Deno", "process"]);
const transport = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection", "sendBeacon", "AudioContext", "OfflineAudioContext", "BroadcastChannel"]);
const injection = new Set(["dangerouslySetInnerHTML", "innerHTML", "outerHTML", "insertAdjacentHTML", "createContextualFragment", "parseFromString", "setHTML", "setHTMLUnsafe", "insertRule", "replaceSync", "adoptedStyleSheets", "styleSheets"]);
const functions = new Set(["Object", "Array", "String", "Number", "Boolean", "Date", "RegExp", "Error", "Promise", "Map", "Set", "Symbol", "BigInt", "Uint8Array", "URL"]);

export function staticString(value: unknown): string | undefined {
  const expression = node(value);
  if (!expression) return;
  if (typeof expression.value === "string") return expression.value;
  if (expression.type === "JSXExpressionContainer") return staticString(expression.expression);
  if (expression.type === "TemplateLiteral" && Array.isArray(expression.expressions) && expression.expressions.length === 0) return (expression.quasis as Node[]).map(part => String(node(part.value)?.cooked ?? "")).join("");
  if (expression.type === "BinaryExpression" && expression.operator === "+") {
    const left = staticString(expression.left), right = staticString(expression.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
}
function propertyName(expression: Node): string | undefined {
  const property = node(expression.property ?? expression.key);
  return expression.computed ? staticString(property) : typeof property?.name === "string" ? property.name : staticString(property);
}
function globalKind(name: string): Kind {
  if (executable.has(name)) return "executable";
  if (transport.has(name)) return "transport";
  if (["globalThis", "window", "self"].includes(name)) return "global";
  if (name === "navigator") return "navigator";
  if (name === "document") return "document";
  if (name === "DOMParser") return "parser";
  if (name === "CSSStyleSheet") return "injection";
  if (name === "Reflect") return "reflect";
  if (["setTimeout", "setInterval"].includes(name)) return "timer";
  return functions.has(name) ? "function" : "unknown";
}
function parameterKind(pattern: Node): Kind {
  const annotation = node(node(pattern.typeAnnotation)?.typeAnnotation);
  const name = node(annotation?.typeName)?.name;
  if (typeof name === "string" && /^(?:HTML.*Element|SVG.*Element|Element|HTMLElement|Node)$/.test(name)) return "element";
  if (name === "Document") return "document";
  if (name === "Window") return "global";
  if (name === "Navigator") return "navigator";
  return "unknown";
}

export function sourceCapabilities(program: unknown): (value: Node) => Kind {
  const scopes = new WeakMap<object, Scope>();
  const root: Scope = { bindings: new Map() };
  const bind = (pattern: Node | undefined, scope: Scope, expression?: Node, kind?: Kind): void => {
    if (!pattern) return;
    if (pattern.type === "Identifier") scope.bindings.set(String(pattern.name), { scope, ...(expression ? { expression } : {}), ...(kind ? { kind } : {}) });
    else if (pattern.type === "ObjectPattern") for (const value of pattern.properties as Node[]) {
      bind(node(value.value ?? value.argument), scope, expression && value.key ? { type: "MemberExpression", object: expression, property: value.key, computed: value.computed } : undefined);
    }
    else if (pattern.type === "ArrayPattern") for (const value of pattern.elements as unknown[]) bind(node(value), scope);
    else if (pattern.type === "AssignmentPattern") bind(node(pattern.left), scope, node(pattern.right));
    else if (pattern.type === "RestElement") bind(node(pattern.argument), scope);
  };
  const declare = (value: unknown, scope: Scope): void => {
    const statement = node(value);
    if (!statement || statement.declare) return;
    if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") return declare(statement.declaration, scope);
    if (statement.type === "VariableDeclaration") for (const declaration of statement.declarations as Node[]) bind(node(declaration.id), scope, node(declaration.init));
    if (["FunctionDeclaration", "ClassDeclaration"].includes(String(statement.type))) bind(node(statement.id), scope, undefined, "function");
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type") for (const specifier of statement.specifiers as Node[]) {
      if (specifier.importKind === "type") continue;
      const imported = node(specifier.imported)?.name;
      const preact = ["preact", "preact/jsx-runtime", "preact/jsx-dev-runtime"].includes(String(node(statement.source)?.value));
      const factory = preact && ["h", "createElement", "jsx", "jsxs", "jsxDEV"].includes(String(imported));
      bind(node(specifier.local), scope, undefined, factory ? "factory" : preact && ["ImportNamespaceSpecifier", "ImportDefaultSpecifier"].includes(String(specifier.type)) ? "preact" : "unknown");
    }
  };
  const hoist = (value: unknown, scope: Scope): void => {
    if (Array.isArray(value)) { for (const child of value) hoist(child, scope); return; }
    const current = node(value);
    if (!current || String(current.type).includes("Function")) return;
    if (current.type === "VariableDeclaration" && current.kind === "var") declare(current, scope);
    for (const child of Object.values(current)) hoist(child, scope);
  };
  const visit = (value: unknown, parent: Scope): void => {
    if (Array.isArray(value)) { for (const child of value) visit(child, parent); return; }
    const current = node(value);
    if (!current) return;
    let scope = parent;
    const type = String(current.type);
    if (type === "Program" || type === "BlockStatement" || type === "SwitchStatement") {
      scope = { parent, bindings: new Map() };
      const statements = (type === "SwitchStatement" ? (current.cases as Node[]).flatMap(item => item.consequent as unknown[]) : current.body) as unknown[];
      for (const statement of statements) declare(statement, scope);
      if (type === "Program") hoist(current, scope);
    } else if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(type)) {
      scope = { parent, bindings: new Map() };
      bind(node(current.id), scope, undefined, "function");
      for (const value of current.params as Node[]) bind(value, scope, undefined, parameterKind(value));
      hoist(current.body, scope);
    } else if (["ForStatement", "ForInStatement", "ForOfStatement", "CatchClause"].includes(type)) {
      scope = { parent, bindings: new Map() };
      declare(current.init ?? current.left, scope);
      bind(node(current.param), scope);
    }
    scopes.set(current, scope);
    for (const child of Object.values(current)) visit(child, scope);
  };
  visit(program, root);
  const resolve = (name: string, scope: Scope): Binding | undefined => scope.bindings.get(name) ?? (scope.parent && resolve(name, scope.parent));
  const valueBinding = (value: unknown, scope: Scope, depth: number): { value: Node | undefined; scope: Scope } => {
    const expression = node(value);
    if (!expression || depth > 40) return { value: expression, scope };
    if (expression.type === "Identifier") {
      const binding = resolve(String(expression.name), scope);
      if (binding?.expression) return valueBinding(binding.expression, binding.scope, depth + 1);
    }
    if (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(expression.type))) return valueBinding(expression.expression, scope, depth + 1);
    return { value: expression, scope };
  };
  const knownString = (value: unknown, scope: Scope, depth: number): string | undefined => {
    if (depth > 40) return;
    const resolved = valueBinding(value, scope, depth + 1);
    if (resolved.value?.type === "BinaryExpression" && resolved.value.operator === "+") {
      const left = knownString(resolved.value.left, resolved.scope, depth + 1), right = knownString(resolved.value.right, resolved.scope, depth + 1);
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    return staticString(resolved.value);
  };
  const infer = (value: unknown, scope: Scope, depth = 0): Kind => {
    const current = node(value);
    if (!current || depth > 40) return "unknown";
    if (current.type === "Identifier") {
      const binding = resolve(String(current.name), scope);
      return binding ? binding.kind ?? infer(binding.expression, binding.scope, depth + 1) : globalKind(String(current.name));
    }
    if (["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration", "ClassExpression"].includes(String(current.type))) return "function";
    if (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ChainExpression", "ParenthesizedExpression"].includes(String(current.type))) return infer(current.expression, scope, depth + 1);
    if (current.type === "MemberExpression") {
      const key = current.computed ? knownString(current.property, scope, depth + 1) : propertyName(current);
      const receiver = infer(current.object, scope, depth + 1);
      if (key === undefined) return "unknown";
      const resolved = valueBinding(current.object, scope, depth + 1);
      if (resolved.value?.type === "ObjectExpression") {
        const property = [...resolved.value.properties as Node[]].reverse().find(property => propertyName(property) === key);
        if (property) return infer(property.value, resolved.scope, depth + 1);
      }
      if (receiver === "global") return globalKind(key);
      if (receiver === "preact" && ["h", "createElement", "jsx", "jsxs", "jsxDEV"].includes(key)) return "factory";
      if (["executable", "transport", "injection"].includes(receiver)) return receiver;
      if (receiver === "navigator" && ["sendBeacon", "serviceWorker"].includes(key)) return "transport";
      if (receiver === "reflect" && key === "get") return "reflect-get";
      if (receiver === "function" && key === "constructor") return "executable";
      if (["element", "document", "parser"].includes(receiver) && injection.has(key)) return "injection";
      if (receiver === "document" && ["write", "writeln", "execCommand"].includes(key)) return "injection";
      if (receiver === "document" && ["createElement", "createElementNS", "querySelector", "getElementById"].includes(key)) return "factory";
      // Any constructor can lead to Function on the next .constructor access.
      if (key === "constructor") return "function";
    }
    if (current.type === "CallExpression" || current.type === "NewExpression") {
      const callee = infer(current.callee, scope, depth + 1);
      if (callee === "factory") return "element";
      if (callee === "parser") return "parser";
      if (["executable", "transport", "injection"].includes(callee)) return callee;
      if (callee === "reflect-get") {
        const args = current.arguments as unknown[];
        return infer({ type: "MemberExpression", object: args[0], property: args[1], computed: true }, scope, depth + 1);
      }
    }
    return "unknown";
  };
  return value => infer(value, scopes.get(value) ?? root);
}

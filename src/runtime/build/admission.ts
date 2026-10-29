import { readdir, realpath, readFile, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseSync } from "rolldown/utils";
import { SourceAdmissionError } from "./diagnostics";
import { admitPresentationAssets, type PresentationAsset } from "./assets";
import { forbiddenPresentationElements, validatePresentationAttribute } from "../presentation-policy";
import { sourceCapabilities, staticString } from "./capabilities";

const packages = new Set(["fleur/schema", "fleur/database", "fleur/server", "fleur/client", "fleur/routing", "preact", "preact/hooks", "preact/jsx-runtime", "preact/jsx-dev-runtime"]);
const extensions = [".ts", ".tsx", ".js", ".jsx"];
const denied = (): never => { throw new SourceAdmissionError("application source", 1, "UNAPPROVED_SOURCE", "Use supported Fleur imports, local application modules, Tailwind utilities and inert presentation assets."); };
async function projectAliases(root: string): Promise<(specifier: string) => readonly string[]> {
  const path = join(root, "tsconfig.json");
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576) return denied();
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return () => [];
    throw error;
  }
  let config;
  try { config = JSON.parse(text); } catch { return denied(); }
  if (!config || typeof config !== "object" || Array.isArray(config) || config.extends !== undefined) return denied();
  const options = config.compilerOptions ?? {};
  if (!options || typeof options !== "object" || Array.isArray(options) || options.baseUrl !== undefined && options.baseUrl !== ".") return denied();
  const paths = options.paths ?? {};
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return denied();
  const aliases = Object.entries(paths).map(([pattern, targets]) => {
    if (!pattern || pattern.startsWith(".") || pattern.includes(":") || pattern.includes("\\") || pattern.split("*").length > 2 || packages.has(pattern) || pattern === "*" || pattern.startsWith("fleur/") || pattern.startsWith("preact/")) return denied();
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 10 || targets.some(target => typeof target !== "string" || isAbsolute(target) || target.includes("\\") || target.split("*").length > 2)) return denied();
    return { pattern, targets: targets as string[], prefix: pattern.split("*")[0]!, suffix: pattern.includes("*") ? pattern.split("*")[1]! : undefined };
  }).sort((a, b) => Number(a.suffix !== undefined) - Number(b.suffix !== undefined) || b.prefix.length - a.prefix.length);
  return specifier => {
    const alias = aliases.find(value => value.suffix === undefined ? specifier === value.pattern : specifier.startsWith(value.prefix) && specifier.endsWith(value.suffix) && specifier.length >= value.prefix.length + value.suffix.length);
    if (!alias) return [];
    const matched = alias.suffix === undefined ? "" : specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
    return alias.targets.map(target => resolve(root, target.replace("*", matched)));
  };
}
export interface AdmittedProject { readonly root: string; readonly server: readonly string[]; readonly shared: readonly string[]; readonly client: readonly string[]; readonly sources: ReadonlyMap<string, string>; readonly resolutions: ReadonlyMap<string, string>; readonly assets: ReadonlyMap<string, PresentationAsset>; }
export async function admitProject(directory: string): Promise<AdmittedProject> {
  try { return await collectProject(directory); }
  catch (error) { if (error instanceof SourceAdmissionError) throw error; return denied(); }
}
async function collectProject(directory: string): Promise<AdmittedProject> {
  const root = await realpath(directory);
  const aliases = await projectAliases(root);
  const assets = await admitPresentationAssets(root);
  const groups: Record<"server" | "shared" | "client", string[]> = { server: [], shared: [], client: [] };
  const files = new Set<string>();
  const directories = new Set<string>();
  const sources = new Map<string, string>();
  const resolutions = new Map<string, string>();
  const group = (path: string): keyof typeof groups => {
    const relativePath = relative(root, path);
    const first = relativePath.split(/[\\/]/)[0];
    const name = first === "seeds" ? "server" : first;
    if (isAbsolute(relativePath) || !["server", "shared", "client"].includes(name ?? "")) return denied();
    return name as keyof typeof groups;
  };
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return denied();
    const canonical = await realpath(path);
    if (group(canonical) !== group(path)) return denied();
    if (info.isDirectory()) {
      if (directories.has(canonical)) return;
      directories.add(canonical);
      for (const entry of await readdir(canonical)) await visit(join(canonical, entry));
    } else {
      if (!info.isFile() || !extensions.includes(extname(canonical)) || info.size > 1048576) return denied();
      files.add(canonical);
      if (files.size > 2000) return denied();
    }
  };
  for (const name of [...Object.keys(groups), "seeds"]) {
    const path = join(root, name);
    try { await lstat(path); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
    await visit(path);
  }
  for (const file of [...files].sort()) {
    const authority = group(file);
    groups[authority].push(file);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1048576 || await realpath(file) !== file) return denied();
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== info.size) return denied();
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } finally { await handle.close(); }
    sources.set(file, text);
    const parsed = parseSync(file, text);
    if (parsed.errors.length) return denied();
    const imports: string[] = [];
    const capability = sourceCapabilities(parsed.program);
    const literal = (value: unknown): string => {
      if (!value || typeof value !== "object" || !("value" in value) || typeof value.value !== "string") return denied();
      return value.value;
    };
    const fail = (node: Record<string, unknown>, code: string, action: string): never => {
      throw new SourceAdmissionError(relative(root, file), text.slice(0, typeof node.start === "number" ? node.start : 0).split("\n").length, code, action);
    };
    const checkCapability = (node: Record<string, unknown>) => {
      const kind = capability(node);
      if (kind === "executable") fail(node, "EXECUTABLE_CODE", "Use statically named local imports and registered Fleur islands; executable code and workers are not application capabilities.");
      if (kind === "transport") fail(node, "MANUAL_TRANSPORT", "Use Fleur queries, mutations or retrievals for application data.");
      if (kind === "injection") fail(node, "PRESENTATION_INJECTION", "Use Tailwind utilities and JSX inline styles or custom properties; authored stylesheets and HTML injection are not supported.");
    };
    const inspect = (value: unknown, parent?: Record<string, unknown>, key?: string, typeOnly = false): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(item => inspect(item, parent, key, typeOnly)); return; }
      const node = value as Record<string, unknown>;
      typeOnly ||= String(node.type).startsWith("TS") && !["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSInstantiationExpression"].includes(String(node.type));
      const propertyKey = key === "key" && ["Property", "MethodDefinition", "PropertyDefinition"].includes(String(parent?.type)) && !parent?.computed && !parent?.shorthand;
      const memberKey = key === "property" && parent?.type === "MemberExpression" && !parent.computed;
      if (!typeOnly && !propertyKey && !memberKey && ["Identifier", "MemberExpression"].includes(String(node.type))) checkCapability(node);
      if (node.type === "MetaProperty" && (node.meta as Record<string, unknown> | undefined)?.name === "import") fail(node, "ASSET_REFERENCE", "Import validated files from assets/ or use their /assets/ URLs; import.meta asset transforms are not supported.");
      if (node.type === "JSXAttribute" && (node.name as Record<string, unknown> | undefined)?.name === "dangerouslySetInnerHTML") fail(node, "PRESENTATION_INJECTION", "Use JSX elements and inline styles; HTML injection is not supported.");
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(String(node.type)) && node.source !== null && node.source !== undefined) imports.push(literal(node.source));
      if (node.type === "JSXOpeningElement") {
        const name = node.name as Record<string, unknown> | undefined;
        if (name?.type === "JSXIdentifier" && typeof name.name === "string" && /^[a-z]/.test(name.name)) {
          if (forbiddenPresentationElements.includes(name.name.toLowerCase())) fail(node, "FORBIDDEN_ELEMENT", "Use inert presentation elements; scripts, stylesheets and embedded documents are not allowed.");
          for (const attribute of node.attributes as Record<string, unknown>[]) {
            const key = attribute.name as Record<string, unknown> | undefined;
            const value = staticString(attribute.value);
            if (key?.type === "JSXIdentifier" && value !== undefined) {
              try { validatePresentationAttribute(name.name, String(key.name), value); }
              catch { fail(attribute, "PRESENTATION_ATTRIBUTE", "Use local or HTTPS inert presentation URLs and JSX event handlers; executable attributes are not supported."); }
            }
          }
        }
      }
      if (node.type === "TSImportEqualsDeclaration") return denied();
      if (node.type === "TSImportType") imports.push(literal(node.source));
      if (node.type === "CallExpression" || node.type === "NewExpression") {
        const callee = node.callee as Record<string, unknown> | undefined;
        if (!typeOnly && callee) checkCapability(callee);
        const arguments_ = node.arguments as unknown[];
        const property = callee?.property as Record<string, unknown> | undefined;
        const name = callee?.type === "Identifier" ? String(callee.name) : property?.name;
        if (typeof name === "string" && (callee && capability(callee) === "factory")) {
          const tag = staticString(arguments_[name === "createElementNS" ? 1 : 0]);
          if (tag && forbiddenPresentationElements.includes(tag.toLowerCase())) fail(node, "FORBIDDEN_ELEMENT", "Use inert presentation elements and JSX inline styles; executable documents and stylesheet elements are not supported.");
        }
        if (callee && capability(callee) === "timer" && staticString(arguments_[0]) !== undefined) fail(node, "EXECUTABLE_CODE", "Pass a function to timers; executable strings are not supported.");
      }
      Object.entries(node).forEach(([name, child]) => inspect(child, node, name, typeOnly));
    };
    inspect(parsed.program);
    for (const imported of imports) {
      if (packages.has(imported)) {
        if (authority !== "server" && ["fleur/server", "fleur/database"].includes(imported)) return denied();
        continue;
      }
      const stems = imported.startsWith("./") || imported.startsWith("../") ? [resolve(dirname(file), imported)] : aliases(imported);
      if (!stems.length) return denied();
      const candidates = stems.flatMap(stem => [stem, ...extensions.map(extension => stem+extension), ...extensions.map(extension => join(stem, "index"+extension))]);
      let found: string | undefined;
      for (const candidate of candidates) {
        try { const actual = await realpath(candidate); if (files.has(actual) || assets.has(actual)) { found = actual; break; } }
        catch (error) { if (!(error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)))) throw error; }
      }
      if (!found || (!assets.has(found) && authority !== "server" && group(found) === "server")) return denied();
      resolutions.set(file+"\0"+imported, found);
    }
  }
  return Object.freeze({ root, server: Object.freeze(groups.server), shared: Object.freeze(groups.shared), client: Object.freeze(groups.client), sources, resolutions, assets });
}

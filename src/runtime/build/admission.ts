import { readdir, realpath, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseSync } from "rolldown/utils";

const packages = new Set(["fleur/schema", "fleur/database", "fleur/server", "fleur/client", "fleur/routing", "preact", "preact/hooks", "preact/jsx-runtime", "preact/jsx-dev-runtime"]);
const extensions = [".ts", ".tsx", ".js", ".jsx"];
const denied = (): never => { throw new Error("SOURCE_REJECTED"); };
export interface AdmittedProject { readonly root: string; readonly server: readonly string[]; readonly shared: readonly string[]; readonly client: readonly string[]; readonly sources: ReadonlyMap<string, string>; readonly resolutions: ReadonlyMap<string, string>; }
export async function admitProject(directory: string): Promise<AdmittedProject> {
  const root = await realpath(directory);
  const groups: Record<"server" | "shared" | "client", string[]> = { server: [], shared: [], client: [] };
  const files = new Set<string>();
  const directories = new Set<string>();
  const sources = new Map<string, string>();
  const resolutions = new Map<string, string>();
  const group = (path: string): keyof typeof groups => {
    const relativePath = relative(root, path);
    const name = relativePath.split(/[\\/]/)[0];
    if (isAbsolute(relativePath) || !["server", "shared", "client"].includes(name ?? "")) return denied();
    return name as keyof typeof groups;
  };
  const visit = async (path: string): Promise<void> => {
    const canonical = await realpath(path);
    if (group(canonical) !== group(path)) return denied();
    const info = await stat(canonical);
    if (info.isDirectory()) {
      if (directories.has(canonical)) return;
      directories.add(canonical);
      for (const entry of await readdir(canonical)) await visit(join(canonical, entry));
    } else {
      if (!extensions.includes(extname(canonical)) || info.size > 1048576) return denied();
      files.add(canonical);
      if (files.size > 2000) return denied();
    }
  };
  for (const name of Object.keys(groups)) {
    try { await visit(join(root, name)); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
  }
  for (const file of [...files].sort()) {
    const authority = group(file);
    groups[authority].push(file);
    const text = await readFile(file, "utf8");
    sources.set(file, text);
    const parsed = parseSync(file, text);
    if (parsed.errors.length) return denied();
    const imports: string[] = [];
    const literal = (value: unknown): string => {
      if (!value || typeof value !== "object" || !("value" in value) || typeof value.value !== "string") return denied();
      return value.value;
    };
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(inspect); return; }
      const node = value as Record<string, unknown>;
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(String(node.type)) && node.source !== null && node.source !== undefined) imports.push(literal(node.source));
      if (node.type === "TSImportEqualsDeclaration") return denied();
      if (node.type === "TSImportType") imports.push(literal(node.source));
      if (node.type === "CallExpression" || node.type === "NewExpression") {
        const callee = node.callee as Record<string, unknown> | undefined;
        if (callee?.type === "Identifier" && ["require", "eval", "Function", "Worker", "SharedWorker"].includes(String(callee.name))) return denied();
      }
      Object.values(node).forEach(inspect);
    };
    inspect(parsed.program);
    for (const imported of imports) {
      if (packages.has(imported)) {
        if (authority !== "server" && ["fleur/server", "fleur/database"].includes(imported)) return denied();
        continue;
      }
      if (!imported.startsWith("./") && !imported.startsWith("../")) return denied();
      const stem = resolve(dirname(file), imported);
      const candidates = [stem, ...extensions.map(extension => stem+extension), ...extensions.map(extension => join(stem, "index"+extension))];
      let found: string | undefined;
      for (const candidate of candidates) {
        try { const actual = await realpath(candidate); if (files.has(actual)) { found = actual; break; } }
        catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
      }
      if (!found || (authority !== "server" && group(found) === "server")) return denied();
      resolutions.set(file+"\0"+imported, found);
    }
  }
  return Object.freeze({ root, server: Object.freeze(groups.server), shared: Object.freeze(groups.shared), client: Object.freeze(groups.client), sources, resolutions });
}

import { build, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { exportId, publicModules, preactModules } from "./worker";
import type { AdmittedProject } from "./admission";
import { createHash } from "node:crypto";
import { compileStyles } from "./styles";
import { SourceAdmissionError } from "./diagnostics";
import { clientCompatibility } from "./hook-compatibility";
import { parseSync } from "rolldown/utils";

export interface BrowserBuild { readonly entry: string; readonly module?: string; readonly compatibility?: string; readonly stylesheet?: string; readonly files: ReadonlyMap<string, { readonly body: string | Uint8Array; readonly type: string; readonly cache?: "no-cache" }>; }
export async function compileClient(project: AdmittedProject): Promise<BrowserBuild> {
  try { return await compileBrowser(project); }
  catch (error) {
    if (error instanceof SourceAdmissionError) throw error;
    throw new SourceAdmissionError("application source", 1, "BUILD_REFUSED", "Use admitted local modules, inert assets and the Fleur-owned Preact and Tailwind compilers.");
  }
}
// The runtime is compiled independently of application source. Every source
// generation imports these same immutable modules, keeping hooks and transports
// in one browser realm rather than creating a second Preact runtime.
async function browserRuntime() {
  const paths = [...["fleur/schema", "fleur/client", "fleur/routing"].map(name => publicModules[name]!), ...Object.values(preactModules)];
  const namespaces = await Promise.all(paths.map(path => import(path) as Promise<Record<string, unknown>>));
  const source = [
    ...paths.map((path, index) => `import * as m${index} from ${JSON.stringify(path)};`),
    `export const libraries = [${paths.map((_, index) => `m${index}`).join(",")}];`,
    `export {hydrateAdmitted} from ${JSON.stringify(fileURLToPath(new URL("../hydration.ts", import.meta.url)))};`,
  ].join("\n");
  const result = await build({ configFile: false, envFile: false, envPrefix: [], publicDir: false, logLevel: "silent",
    plugins: [{ name: "fleur-browser-runtime", resolveId(id) { if (id === "fleur-runtime") return "\0fleur-runtime"; }, load(id) { if (id === "\0fleur-runtime") return source; } }],
    build: { write: false, minify: true, rolldownOptions: { preserveEntrySignatures: "strict", input: "fleur-runtime", output: { entryFileNames: "assets/runtime-[hash].js" } } },
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("Runtime build failed");
  const entry = result.output.find(file => file.type === "chunk" && file.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Runtime entry missing");
  return { entry: "/"+entry.fileName, code: entry.code, paths, namespaces };
}
async function compileBrowser(project: AdmittedProject): Promise<BrowserBuild> {
  const modules = [...project.shared, ...project.client];
  const runtime = await browserRuntime();
  // Vite's import.meta transforms may read files without resolveId/load hooks.
  // Recheck this compiler boundary independently of source admission, before
  // Vite sees any application bytes. Static asset imports use frozen URL stubs.
  for (const path of modules) {
    const source = project.sources.get(path);
    if (source === undefined) throw new Error("SOURCE_REJECTED");
    const parsed = parseSync(path, source);
    if (parsed.errors.length) throw new Error("SOURCE_REJECTED");
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(inspect); return; }
      const item = value as Record<string, unknown>;
      if (item.type === "MetaProperty" && (item.meta as Record<string, unknown> | undefined)?.name === "import") throw new Error("SOURCE_REJECTED");
      Object.values(item).forEach(inspect);
    };
    inspect(parsed.program);
  }
  const entry = [
    ...modules.map((path, index) => `import * as m${index} from ${JSON.stringify(path)};`),
    `export default Object.assign({}, ${modules.map((path, index) => `Object.fromEntries(Object.entries(m${index}).map(([key,value])=>[${JSON.stringify(exportId(project, path)+"#")}+key,value]))`).join(",")});`,
  ].join("\n");
  const plugin: Plugin = {
    name: "fleur-admitted-client", enforce: "pre",
    resolveId(id, importer) {
      if (importer && project.sources.has(importer)) {
        const path = publicModules[id] ?? preactModules[id] ?? project.resolutions.get(importer+"\0"+id);
        if (!path || project.server.includes(path)) throw new Error("SOURCE_REJECTED");
        if (project.assets.has(path)) return "\0fleur-presentation:" + path;
        return path;
      }
      if (id === runtime.entry) return { id, external: true };
      if (id === "fleur-client-entry") return "\0fleur-client-entry";
      if (publicModules[id] || preactModules[id]) return publicModules[id] ?? preactModules[id];
      if (project.server.includes(id)) throw new Error("SOURCE_REJECTED");
    },
    load(id) {
      const library = runtime.paths.indexOf(id);
      if (library >= 0) return `import {libraries} from ${JSON.stringify(runtime.entry)}; ${Object.keys(runtime.namespaces[library]!).filter(name => name !== "default").map(name => `export const ${name} = libraries[${library}][${JSON.stringify(name)}];`).join("\n")}`;
      if (id === "\0fleur-client-entry") return entry;
      if (id.startsWith("\0fleur-presentation:")) {
        const asset = project.assets.get(id.slice("\0fleur-presentation:".length));
        if (!asset) throw new Error("SOURCE_REJECTED");
        return `export default ${JSON.stringify(asset.url)};`;
      }
      if (project.server.includes(id)) throw new Error("SOURCE_REJECTED");
      const source = project.sources.get(id);
      if (source !== undefined) return source;
    },
  };
  const result = await build({
    configFile: false, envFile: false, envPrefix: [], publicDir: false, plugins: [plugin], logLevel: "silent",
    root: project.root, resolve: { tsconfigPaths: false },
    oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
    build: { write: false, sourcemap: true, minify: true, rolldownOptions: { preserveEntrySignatures: "strict", input: "fleur-client-entry", output: { entryFileNames: "assets/client-[hash].js" } } },
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("Client build failed");
  let filename: string | undefined;
  const files = new Map<string, { body: string | Uint8Array; type: string; cache?: "no-cache" }>();
  for (const asset of project.assets.values()) files.set(asset.url, asset);
  for (const file of result.output) {
    if (file.type === "chunk") {
      if (file.isEntry) filename = "/"+file.fileName;
      files.set("/"+file.fileName, { body: file.code, type: "text/javascript; charset=utf-8" });
    } else files.set("/"+file.fileName, { body: file.source, type: file.fileName.endsWith(".map") ? "application/json" : "text/css; charset=utf-8" });
  }
  if (!filename) throw new Error("Client entry missing");
  files.set(runtime.entry, { body: runtime.code, type: "text/javascript; charset=utf-8" });
  const boot = `import {hydrateAdmitted} from ${JSON.stringify(runtime.entry)}; const load = async path => (await import(path)).default; hydrateAdmitted(await load(${JSON.stringify(filename)}), load);`;
  const bootstrap = `/assets/boot-${createHash("sha256").update(boot).digest("hex").slice(0, 16)}.js`;
  files.set(bootstrap, { body: boot, type: "text/javascript; charset=utf-8" });
  const css = await compileStyles(project);
  const stylesheet = `/assets/styles-${createHash("sha256").update(css).digest("hex").slice(0, 16)}.css`;
  files.set(stylesheet, { body: css, type: "text/css; charset=utf-8" });
  return Object.freeze({ entry: bootstrap, module: filename, compatibility: clientCompatibility(project, runtime.entry), stylesheet, files });
}

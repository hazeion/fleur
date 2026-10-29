import { build, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { exportId, publicModules, preactModules } from "./worker";
import type { AdmittedProject } from "./admission";
import { createHash } from "node:crypto";
import { compileStyles } from "./styles";
import { SourceAdmissionError } from "./diagnostics";

export interface BrowserBuild { readonly entry: string; readonly stylesheet?: string; readonly files: ReadonlyMap<string, { readonly body: string | Uint8Array; readonly type: string; readonly cache?: "no-cache" }>; }
export async function compileClient(project: AdmittedProject): Promise<BrowserBuild> {
  try { return await compileBrowser(project); }
  catch (error) {
    if (error instanceof SourceAdmissionError) throw error;
    throw new SourceAdmissionError("application source", 1, "BUILD_REFUSED", "Use admitted local modules, inert assets and the Fleur-owned Preact and Tailwind compilers.");
  }
}
async function compileBrowser(project: AdmittedProject): Promise<BrowserBuild> {
  const modules = [...project.shared, ...project.client];
  const entry = [
    `import ${JSON.stringify(fileURLToPath(new URL("../browser-transport.ts", import.meta.url)))};`,
    `import {hydrateAdmitted} from ${JSON.stringify(fileURLToPath(new URL("../hydration.ts", import.meta.url)))};`,
    ...modules.map((path, index) => `import * as m${index} from ${JSON.stringify(path)};`),
    `hydrateAdmitted(Object.assign({}, ${modules.map((path, index) => `Object.fromEntries(Object.entries(m${index}).map(([key,value])=>[${JSON.stringify(exportId(project, path)+"#")}+key,value]))`).join(",")}));`,
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
      if (id === "fleur-client-entry") return "\0fleur-client-entry";
      if (publicModules[id] || preactModules[id]) return publicModules[id] ?? preactModules[id];
      if (project.server.includes(id)) throw new Error("SOURCE_REJECTED");
    },
    load(id) {
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
    build: { write: false, sourcemap: true, minify: true, rolldownOptions: { input: "fleur-client-entry", output: { entryFileNames: "assets/client-[hash].js" } } },
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
  const css = await compileStyles(project.sources);
  const stylesheet = `/assets/styles-${createHash("sha256").update(css).digest("hex").slice(0, 16)}.css`;
  files.set(stylesheet, { body: css, type: "text/css; charset=utf-8" });
  return Object.freeze({ entry: filename, stylesheet, files });
}

import { fileURLToPath } from "node:url";
import { relative, extname } from "node:path";
import type { AdmittedProject } from "./admission";
import { SourceAdmissionError } from "./diagnostics";

export function exportId(project: AdmittedProject, path: string): string { return relative(project.root, path).replaceAll("\\", "/"); }
export const publicModules = Object.fromEntries(["schema", "database", "server", "client", "routing"].map(name => [`fleur/${name}`, fileURLToPath(new URL(`../../${name}.ts`, import.meta.url))]));
export const preactModules = Object.fromEntries(["preact", "preact/hooks", "preact/jsx-runtime", "preact/jsx-dev-runtime"].map(name => [name, fileURLToPath(import.meta.resolve(name))]));
export async function compileWorker(project: AdmittedProject): Promise<string> {
  try { return await compileAdmittedWorker(project); }
  catch (error) {
    if (error instanceof SourceAdmissionError) throw error;
    throw new SourceAdmissionError("application source", 1, "BUILD_REFUSED", "Use admitted local modules and the Fleur-owned Preact JSX runtime.");
  }
}
async function compileAdmittedWorker(project: AdmittedProject): Promise<string> {
  const modules = [...project.shared, ...project.client, ...project.server];
  const entry = [
    `import {makeRunner} from ${JSON.stringify(fileURLToPath(new URL("../worker-entry.ts", import.meta.url)))};`,
    ...modules.map((path, index) => `import * as m${index} from ${JSON.stringify(path)};`),
    `export const run = makeRunner(Object.assign({}, ${modules.map((path, index) => `Object.fromEntries(Object.entries(m${index}).map(([key,value])=>[${JSON.stringify(exportId(project, path)+"#")}+key,value]))`).join(",")}));`,
  ].join("\n");
  const result = await Bun.build({
    entrypoints: ["fleur-worker-entry"], target: "browser", format: "cjs", minify: { whitespace: true }, jsx: { runtime: "automatic", importSource: "preact" },
    tsconfig: fileURLToPath(new URL("worker.tsconfig.json", import.meta.url)),
    plugins: [{ name: "fleur-admitted-worker", setup(builder) {
      builder.onResolve({ filter: /^fleur-worker-entry$/ }, () => ({ path: "entry", namespace: "fleur" }));
      builder.onLoad({ filter: /.*/, namespace: "fleur" }, () => ({ contents: entry, loader: "ts" }));
      builder.onResolve({ filter: /.*/ }, args => {
        if (project.sources.has(args.importer)) {
          const path = publicModules[args.path] ?? preactModules[args.path] ?? project.resolutions.get(args.importer+"\0"+args.path);
          if (!path) throw new Error("SOURCE_REJECTED");
          return { path };
        }
      });
      builder.onResolve({ filter: /^(fleur\/|preact(?:\/|$))/ }, args => {
        const path = publicModules[args.path] ?? preactModules[args.path];
        if (!path) throw new Error("SOURCE_REJECTED");
        return { path };
      });
      builder.onLoad({ filter: /.*/ }, args => {
        const asset = project.assets.get(args.path);
        if (asset) return { contents: `export default ${JSON.stringify(asset.url)};`, loader: "js" };
      });
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
        const contents = project.sources.get(args.path);
        if (contents !== undefined) return { contents, loader: extname(args.path).slice(1) as "ts" | "tsx" | "js" | "jsx" };
      });
    } }],
  });
  if (!result.success || result.outputs.length !== 1) throw new SourceAdmissionError("application source", 1, "BUILD_REFUSED", "Use admitted local modules and the Fleur-owned Preact JSX runtime.");
  return result.outputs[0]!.text();
}

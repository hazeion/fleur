import { catalogFailure } from "../cli/catalog";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { releaseVersion } from "./release";
import { readMetadata, readMetadataText } from "../cli/project-pin";
import { join } from "node:path";
import type { CommandInput } from "../cli/catalog";
import { failure, success } from "../cli/result";
import { hasToolingProfile } from "./tooling-profile";
import { runTool } from "./tool-process";
import { productionCommands } from "../runtime/production/commands";
async function hasToolGraph(project: string, command: string): Promise<boolean> {
  try {
  const template = JSON.parse(await readFile(new URL("./template/package.json.txt", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readMetadataText(join(project, "package.json")));
  const lintTemplate = JSON.parse(await readFile(new URL("./template/lint-package.json.txt", import.meta.url), "utf8"));
  const lint = JSON.parse(await readMetadataText(join(project, "lint/package.json")));
  const dependencies = { ...manifest.dependencies }, development = { ...manifest.devDependencies };
  const fleurPins = [dependencies.fleur, development.fleur].filter(value => value !== undefined);
  let matchingFleur = fleurPins.length <= 1 && fleurPins.every(value => value === releaseVersion);
  if (fleurPins.length) {
    try { const installed = await readMetadata(join(project, "node_modules/fleur/package.json")); matchingFleur &&= installed !== null && typeof installed === "object" && "name" in installed && installed.name === "fleur" && "version" in installed && installed.version === releaseVersion; } catch { matchingFleur = false; }
  }
  delete dependencies.fleur; delete development.fleur;
  if (!await hasToolingProfile(project) || !matchingFleur || !isDeepStrictEqual(dependencies, template.dependencies) || !isDeepStrictEqual(development, template.devDependencies) || !isDeepStrictEqual(lint, lintTemplate)) return false;
  const installed: { path: string; name: string; version: string }[] = [];
  if (command === "test" || command === "verify") installed.push({ path: "node_modules/@playwright/test/package.json", name: "@playwright/test", version: template.devDependencies["@playwright/test"] });
  if (command === "types" || command === "verify") for (const name of ["typescript", "@types/bun"] as const) installed.push({ path: `node_modules/${name}/package.json`, name, version: template.devDependencies[name] });
  if (command === "lint" || command === "verify") {
    installed.push({ path: "node_modules/oxlint/package.json", name: "oxlint", version: template.devDependencies.oxlint });
    for (const name of ["eslint", "typescript-eslint", "typescript"] as const) installed.push({ path: `lint/node_modules/${name}/package.json`, name, version: lintTemplate.dependencies[name] });
  }
  for (const item of installed) {
    const metadata = await readMetadata(join(project, item.path));
    if (!metadata || typeof metadata !== "object" || !("name" in metadata) || !("version" in metadata) || metadata.name !== item.name || metadata.version !== item.version) return false;
  }
  return true;
  } catch { return false; }
}
/** Runs only the release-owned tool graph, never arbitrary package scripts or a compiler fallback. */
export async function verifyProject(input: CommandInput, command = "verify") {
  const deadline = performance.now() + input.timeoutSeconds * 1000;
  if (!await hasToolGraph(input.project, command)) return failure(command, 4, { code: "VERSION_MISMATCH", message: "Verification requires the release-owned exact tool graph, strict Microsoft compiler profile and both lint profiles.", actions: [] });
  const checks: string[] = [];
  const tools: [string, string[]][] = [
    ["tests", ["test", "tests"]],
    ["types", ["./node_modules/typescript/bin/tsc", "--noEmit"]],
    ["oxlint", ["./node_modules/oxlint/bin/oxlint", "client", "server", "shared", "tests"]],
    ["eslint", ["./lint/node_modules/eslint/bin/eslint.js", "--no-error-on-unmatched-pattern", "--config", "lint/eslint.config.mjs", "client", "server", "shared", "tests"]],
  ];
  const selected = command === "verify" ? tools : tools.filter(([name]) => command === "lint" ? name === "oxlint" || name === "eslint" : name === (command === "test" ? "tests" : command));
  if (command === "test") {
    const suite = input.args.includes("--suite") ? input.args[input.args.indexOf("--suite") + 1] : undefined;
    const filter = input.args.includes("--filter") ? input.args[input.args.indexOf("--filter") + 1] : undefined;
    const directory = suite ? `tests/${suite}` : "tests";
    selected[0]![1] = ["test", `./${directory}`];
    if (filter) {
      const files = await Array.fromAsync(new Bun.Glob("**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}").scan({ cwd: join(input.project, directory), onlyFiles: true }));
      const matching = files.filter(path => `${directory}/${path}`.includes(filter));
      selected[0]![1] = matching.length ? ["test", ...matching.map(path => `./${directory}/${path}`)] : ["test", `./${directory}`, "--test-name-pattern", filter];
    }
  }
  for (const [name, args] of selected) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return catalogFailure(command, "VERIFY_TIMEOUT", { message: "Verification exhausted its deadline." }, { checks });
    const tool = await runTool(args, input.project, remaining);
    if (tool.timedOut) return catalogFailure(command, "VERIFY_TIMEOUT", { message: "Verification exhausted its deadline." }, { checks, failed: name });
    if (tool.exit !== 0) return catalogFailure(command, "VERIFY_FAILED", { message: `The ${name} check failed. Run the pinned tool directly for diagnostics.` }, { checks, failed: name });
    checks.push(name);
  }
  if (command !== "verify") return success(command, { checks });
  const remaining = (deadline - performance.now()) / 1000;
  if (remaining <= 0) return catalogFailure(command, "VERIFY_TIMEOUT", { message: "Verification exhausted its deadline." }, { checks });
  const result = await productionCommands.find(command => command.name === "build")!.run({ ...input, args: [], timeoutSeconds: remaining });
  return result.exitCode === 0 ? success("verify", { checks: [...checks, "build"] }) : { ...result, result: { ...result.result, command: "verify", data: { checks, failed: "build" } } };
}

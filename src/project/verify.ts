import { catalogFailure } from "../cli/catalog";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { releaseVersion } from "./release";
import { readMetadata } from "../cli/project-pin";
import { join } from "node:path";
import type { CommandInput } from "../cli/catalog";
import { failure, success } from "../cli/result";
import { productionCommands } from "../runtime/production/commands";
/** Runs only the release-owned tool graph, never arbitrary package scripts or a compiler fallback. */
export async function verifyProject(input: CommandInput) {
  const template = JSON.parse(await readFile(new URL("./template/package.json.txt", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(join(input.project, "package.json"), "utf8"));
  const lintTemplate = JSON.parse(await readFile(new URL("./template/lint-package.json.txt", import.meta.url), "utf8"));
  const lint = JSON.parse(await readFile(join(input.project, "lint/package.json"), "utf8"));
  const dependencies = { ...manifest.dependencies }, development = { ...manifest.devDependencies };
  const fleurPins = [dependencies.fleur, development.fleur].filter(value => value !== undefined);
  let matchingFleur = fleurPins.length <= 1 && fleurPins.every(value => value === releaseVersion);
  if (fleurPins.length) {
    try { const installed = await readMetadata(join(input.project, "node_modules/fleur/package.json")); matchingFleur &&= installed !== null && typeof installed === "object" && "name" in installed && installed.name === "fleur" && "version" in installed && installed.version === releaseVersion; } catch { matchingFleur = false; }
  }
  delete dependencies.fleur; delete development.fleur;
  if (!matchingFleur || !isDeepStrictEqual(dependencies, template.dependencies) || !isDeepStrictEqual(development, template.devDependencies) || !isDeepStrictEqual(lint, lintTemplate)) return failure("verify", 4, { code: "VERSION_MISMATCH", message: "Verification requires the release-owned exact tool graph and selected Microsoft compiler.", actions: [] });
  const checks: string[] = [];
  const deadline = performance.now() + input.timeoutSeconds * 1000;
  for (const [name, args] of [
    ["tests", ["test", "tests"]],
    ["types", ["./node_modules/typescript/bin/tsc", "--noEmit"]],
    ["oxlint", ["./node_modules/oxlint/bin/oxlint", "client", "server", "shared", "tests"]],
    ["eslint", ["./lint/node_modules/eslint/bin/eslint.js", "--no-error-on-unmatched-pattern", "--config", "lint/eslint.config.mjs", "client", "server", "shared", "tests"]],
  ] as const) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return catalogFailure("verify", "VERIFY_TIMEOUT", { message: "Verification exhausted its deadline." }, { checks });
    const child = Bun.spawn([process.execPath, "--no-env-file", ...args], { cwd: input.project, env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: remaining, killSignal: "SIGKILL", stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    if (await child.exited !== 0) return catalogFailure("verify", "VERIFY_FAILED", { message: `The ${name} check failed. Run the pinned tool directly for diagnostics.` }, { checks, failed: name });
    checks.push(name);
  }
  const remaining = (deadline - performance.now()) / 1000;
  if (remaining <= 0) return catalogFailure("verify", "VERIFY_TIMEOUT", { message: "Verification exhausted its deadline." }, { checks });
  const result = await productionCommands.find(command => command.name === "build")!.run({ ...input, args: [], timeoutSeconds: remaining });
  return result.exitCode === 0 ? success("verify", { checks: [...checks, "build"] }) : { ...result, result: { ...result.result, command: "verify", data: { checks, failed: "build" } } };
}

import { catalogFailure, operationCatalog, validateCatalogArguments, type CommandDefinition } from "../cli/catalog";
import { success, type CliOutcome } from "../cli/result";
import { releaseVersion, exactStableVersion } from "./release";
const definitions = [
  { name: "explain", usage: "explain", summary: "Explain the pinned application environment and workflow.", grammar: { minPositionals: 0, maxPositionals: 0, optionForms: [[]] } },
  { name: "test", usage: "test [--suite unit|database|browser] [--filter <name-or-path>]", summary: "Run the whole application test suite or an explicit subset.", grammar: { minPositionals: 0, maxPositionals: 0, optionForms: [[], ["--suite"], ["--filter"], ["--suite", "--filter"]] }, options: [{ name: "--suite", value: true, pattern: "^(unit|database|browser)$" }, { name: "--filter", value: true }] },
  { name: "types", usage: "types", summary: "Check application types with the pinned compiler.", grammar: { minPositionals: 0, maxPositionals: 0, optionForms: [[]] } },
  { name: "lint", usage: "lint", summary: "Run both pinned application lint engines.", grammar: { minPositionals: 0, maxPositionals: 0, optionForms: [[]] } },
  { name: "docs", usage: "docs [core|catalog|upgrades]", summary: "Read pinned offline documentation or machine schemas.", grammar: { minPositionals: 0, maxPositionals: 1, positionalEnum: ["core", "catalog", "upgrades"], optionForms: [[]] } },
  { name: "docs refresh", usage: "docs refresh [--preview | --replace <token> | --recover]", summary: "Refresh generated guidance while preserving user instructions.", grammar: { minPositionals: 0, maxPositionals: 0, optionForms: [[], ["--preview"], ["--replace"], ["--recover"]] }, options: [{ name: "--preview", value: false }, { name: "--replace", value: true, pattern: "^[a-f0-9]{64}$" }, { name: "--recover", value: false }] },
  { name: "upgrade", usage: "upgrade --to <exact-version> [--preview | --accept <token>]", summary: "Preview or apply a documented exact-version upgrade.", grammar: { minPositionals: 0, maxPositionals: 0, optionForms: [["--to"], ["--to", "--preview"], ["--to", "--accept"]] }, options: [{ name: "--to", value: true, pattern: exactStableVersion.source }, { name: "--preview", value: false }, { name: "--accept", value: true, pattern: "^[a-f0-9]{64}$" }] },
  { name: "verify", usage: "verify", summary: "Check pinned guidance, tests, types, full lint and production build.", grammar: { minPositionals: 0, maxPositionals: 0, optionForms: [[]] } },
] as const;
export const guidanceCommands: readonly CommandDefinition[] = definitions.map(definition => ({ ...definition,
  validateArgs(args) { return validateCatalogArguments(definition, args); },
  async run(input) {
    const deadline = performance.now() + input.timeoutSeconds * 1000;
    const { args } = input;
    const { findProjectPin } = await import("../cli/project-pin");
    const pin = await findProjectPin(input.project);
    const root = pin.kind === "configured" ? pin.root : input.project;
    if (definition.name === "docs" || definition.name === "explain") {
      if (args[0] === "upgrades") return success("docs", (await import("./upgrade")).upgradeCatalog());
      if (args[0] === "catalog") { const { commands } = await import("../cli/operations"); return success("docs", { ...operationCatalog(commands), fleurVersion: releaseVersion }); }
      const text = (await (await import("./guidance-state")).guidanceFiles())["docs/fleur.md"];
      return { ...success(definition.name, { fleurVersion: releaseVersion, content: text }), human: text };
    }
    if (["verify", "test", "types", "lint"].includes(definition.name)) {
      const mismatch = await (await import("./guidance-state")).guardGuidance(definition.name, root); if (mismatch) return mismatch;
      const { verifyProject } = await import("./verify"); return verifyProject({ ...input, project: root }, definition.name);
    }
    try {
      if (performance.now() >= deadline) throw new Error("UPDATE_TIMEOUT");
      if (definition.name === "upgrade") return await (await import("./upgrade")).upgradeProject(root, args[args.indexOf("--to") + 1]!, args.includes("--preview"), args.includes("--accept") ? args[args.indexOf("--accept") + 1] : undefined, undefined, deadline);
      if (args.includes("--recover")) {
        const { recoverFiles, findUpdateRoot } = await import("./file-update");
        const result = recoverFiles(findUpdateRoot(input.project));
        return result.ok ? success("docs refresh", { recovered: true, databaseChanged: false }) : updateFailed("docs refresh", result.unrestored);
      }
      const plan = await (await import("./guidance-state")).guidancePlan(root);
      if (args.includes("--preview")) return success("docs refresh", plan);
      if (args.includes("--replace") && args[1] !== plan.token) return catalogFailure("docs refresh", "PREVIEW_CHANGED", { message: "The generated diff changed after preview. Review a new preview before replacing content." });
      if (plan.conflicts.length && !args.includes("--replace")) return catalogFailure("docs refresh", "GUIDANCE_CONFLICT", { message: "Edited generated content requires a preview and explicit replacement choice.", actual: plan.conflicts, actions: [{ command: "fleur docs refresh --preview", description: "Review the diff, then pass its token with --replace." }] });
      const result = await (await import("./file-update")).applyFiles(root, plan.changes, undefined, undefined, deadline);
      return result.ok ? success("docs refresh", { refreshed: plan.changes.map(change => change.path), fleurVersion: releaseVersion }) : updateFailed("docs refresh", result.unrestored);
    } catch (error) {
      if (error instanceof Error && error.message === "UPDATE_TIMEOUT") return catalogFailure(definition.name, "UPDATE_TIMEOUT", { message: "The file update deadline expired before further work was authorized." });
      return catalogFailure(definition.name, "RECOVERY_REQUIRED", { message: "Protected update files, markers or compatibility checks could not be verified. No unverified replacement is authorized.", actions: [{ command: "fleur doctor", description: "Inspect pin/guidance mismatch and retained update evidence before retrying." }] }); }
  },
}));
function updateFailed(command: string, unrestored: string[]): CliOutcome {
  return catalogFailure(command, unrestored.length ? "RECOVERY_REQUIRED" : "GUIDANCE_REFRESH_FAILED", { message: unrestored.length ? "A file update is active or could not be restored safely. Retained private evidence requires reconciliation." : "The refresh failed and previous files were restored.", actual: { unrestored }, actions: [{ command: "fleur docs refresh --recover", description: "Recover unchanged owned files after the original update owner exits; preserve concurrent edits." }] });
}

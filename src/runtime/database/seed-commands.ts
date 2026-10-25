import type { CommandDefinition } from "../../cli/catalog";
import { failure, success } from "../../cli/result";

export const seedCommands: readonly CommandDefinition[] = [
  { name: "db seed", usage: "db seed", summary: "Reconcile declared seed ownership without overwriting user edits.", options: [] },
  { name: "db reset", usage: "db reset [--seed] [--grant <id>]", summary: "Reset only the explicitly bound development database after approved verified backup.", options: [{ name: "--seed", value: false }, { name: "--grant", value: true }] },
].map(definition => ({ ...definition,
  validateArgs(args) {
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]!, option = definition.options.find(option => option.name === flag);
      if (!option || seen.has(flag) || option.value && (!args[index + 1] || args[index + 1]!.startsWith("--"))) return failure(definition.name, 2, { code: "ARGUMENT_INVALID", message: "Use the documented seed/reset options.", actions: [] });
      seen.add(flag); if (option.value) index++;
    }
    return undefined;
  },
  async run({ project, args, json, timeoutSeconds }) {
    const url = process.env.FLEUR_PRIVATE_DATABASE_URL;
    if (!url) return failure(definition.name, 4, { code: "CONFIGURATION_MISSING", message: "Explicit private database configuration is required.", actions: [] });
    try {
      const developmentUrl = process.env.FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL;
      if (definition.name === "db reset" && (!developmentUrl || new URL(developmentUrl).toString() !== new URL(url).toString())) throw new Error("REQUEST_DENIED");
      const grant = args.includes("--grant") ? args[args.indexOf("--grant") + 1] : undefined;
      const config = { timeoutMs: timeoutSeconds * 1000, ...(developmentUrl ? { developmentUrl } : {}), seed: args.includes("--seed"), ...(grant ? { grant } : {}), ...(!json ? { confirm: (request: import("./maintenance-authority").MaintenanceApproval) => import("./maintenance-authority").then(module => module.terminalApproval(request, timeoutSeconds * 1000)) } : {}), ...(process.env.FLEUR_PRIVATE_CONTROL_DATABASE_URL ? { controlUrl: process.env.FLEUR_PRIVATE_CONTROL_DATABASE_URL } : {}), ...(process.env.FLEUR_PRIVATE_PG_TOOLS ? { toolDirectory: process.env.FLEUR_PRIVATE_PG_TOOLS } : {}) };
      const seeds = definition.name === "db seed" || config.seed ? (await (await import("./migration-declarations")).applicationDeclarations(project)).seeds : [];
      const result = definition.name === "db seed"
        ? await (await import("./seeds")).seedDatabase(url, project, seeds, config)
        : await (await import("./reset")).resetDatabase(url, project, seeds, config);
      return success(definition.name, JSON.parse(JSON.stringify(result)));
    } catch (error) {
      const allowed = ["AUTHORITY_REQUIRED", "REQUEST_DENIED", "SEED_INVALID", "SEED_CONFLICT", "MIGRATION_EDITED", "MIGRATIONS_PENDING", "MIGRATION_INCOMPATIBLE", "SCHEMA_DRIFT", "MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "CONFIGURATION_MISSING", "PREREQUISITE_UNAVAILABLE", "SOURCE_REJECTED", "BACKUP_VERIFICATION_FAILED"];
      const code = error instanceof Error && allowed.includes(error.message) ? error.message : "INTERNAL_FAILURE";
      const exit = ["AUTHORITY_REQUIRED", "REQUEST_DENIED"].includes(code) ? 3 : ["SCHEMA_DRIFT", "MIGRATION_EDITED", "MIGRATIONS_PENDING", "MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "SEED_CONFLICT"].includes(code) ? 5 : ["CONFIGURATION_MISSING", "PREREQUISITE_UNAVAILABLE"].includes(code) ? 4 : 1;
      return failure(definition.name, exit, { code, message: "Seed/reset could not complete safely.", actions: [{ command: "fleur db recover --inspect", description: "Inspect retained maintenance evidence before recovery." }] });
    }
  },
}));

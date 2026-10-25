import { backupDatabase } from "./backup";
import { inspectDatabase } from "./inspection";
import { MaintenanceLease } from "./maintenance";
import type { CommandDefinition } from "../../cli/catalog";
import { failure, success } from "../../cli/result";

export const databaseCommands: readonly CommandDefinition[] = [
  { name: "db inspect", usage: "db inspect [--table <name>] [--limit 100] [--cursor <token>] [--export <file>]", options: ["--table", "--limit", "--cursor", "--export"].map(name => ({ name, value: true })) },
  { name: "db backup", usage: "db backup --out <file>", options: [{ name: "--out", value: true }] },
  { name: "db recover", usage: "db recover --inspect", options: [{ name: "--inspect", value: false }] },
].map(definition => ({ ...definition, summary: definition.name === "db inspect" ? "Inspect bounded application data or export it to a file." : definition.name === "db backup" ? "Create and restore-verify a retained database backup." : "Inspect durable maintenance state without clearing it.",
  validateArgs(args) {
    const flags = new Set(definition.options.map(option => option.name));
    for (let index = 0; index < args.length; index++) {
      if (!flags.has(args[index]!)) return failure(definition.name, 2, { code: "ARGUMENT_INVALID", message: "Use the documented named database operation options.", actions: [] });
      if (args[index] !== "--inspect") index++;
    }
    const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag)+1] : undefined;
    if ((definition.name === "db backup" && !value("--out")) || (definition.name === "db recover" && !args.includes("--inspect")) || (value("--cursor") && !/^[A-Za-z0-9_-]{40,16384}$/.test(value("--cursor")!)) || (value("--limit") && (!/^[0-9]+$/.test(value("--limit")!) || Number(value("--limit")) < 1 || Number(value("--limit")) > 500))) return failure(definition.name, 2, { code: "ARGUMENT_INVALID", message: "Supply complete options and a row limit from 1 to 500.", actions: [] });
    return undefined;
  },
  async run({ args, timeoutSeconds }) {
    const url = process.env.FLEUR_PRIVATE_DATABASE_URL;
    if (!url) return failure(definition.name, 4, { code: "CONFIGURATION_MISSING", message: "Explicit private database configuration is required.", actions: [] });
    const config = { timeoutMs: timeoutSeconds*1000, ...(process.env.FLEUR_PRIVATE_CONTROL_DATABASE_URL ? { controlUrl: process.env.FLEUR_PRIVATE_CONTROL_DATABASE_URL } : {}) };
    const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag)+1] : undefined;
    try {
      if (definition.name === "db recover") {
        const lease = await MaintenanceLease.acquire(url, false, config, true);
        try { return success(definition.name, { target: lease.target, maintenance: await lease.marker(), busy: lease.busy }); } finally { await lease.close(); }
      }
      if (definition.name === "db inspect") {
        const result = await inspectDatabase(url, { ...(value("--table") ? { table: value("--table")! } : {}), ...(value("--limit") ? { limit: Number(value("--limit")) } : {}), ...(value("--cursor") ? { cursor: value("--cursor")! } : {}), ...(value("--export") ? { export: value("--export")! } : {}) }, config);
        const outcome = success(definition.name, result.data);
        return { ...outcome, result: { ...outcome.result, truncated: result.truncated } };
      }
      return success(definition.name, await backupDatabase(url, value("--out")!, { ...config, timeoutMs: timeoutSeconds*1000, ...(process.env.FLEUR_PRIVATE_PG_TOOLS ? { toolDirectory: process.env.FLEUR_PRIVATE_PG_TOOLS } : {}) }));
    } catch (error) {
      const code = error instanceof Error && ["ARGUMENT_INVALID", "CONFIGURATION_MISSING", "MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "RESULT_TOO_LARGE", "UNSUPPORTED_CAPABILITY", "PREREQUISITE_UNAVAILABLE", "BACKUP_VERIFICATION_FAILED", "DESTINATION_EXISTS"].includes(error.message) ? error.message : "INTERNAL_FAILURE";
      return failure(definition.name, code === "ARGUMENT_INVALID" ? 2 : ["MAINTENANCE_BUSY", "RECOVERY_REQUIRED"].includes(code) ? 5 : ["CONFIGURATION_MISSING", "PREREQUISITE_UNAVAILABLE", "BACKUP_VERIFICATION_FAILED", "DESTINATION_EXISTS"].includes(code) ? 4 : 1, { code, message: "The database operation could not complete safely.", actions: [{ command: "fleur db recover --inspect", description: "Inspect maintenance state before retrying." }] });
    }
  },
}));

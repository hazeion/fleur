import type { CommandDefinition } from "../../cli/catalog";
import { failure, success, type CliOutcome, type RecoveryAction } from "../../cli/result";
import { capabilities, privilegeShortfall, profileCapabilities, type PrivilegeInsufficient } from "./privilege";
/** The one shared option that selects the production target for read-only diagnostics. */
export const productionOption = { name: "--production", value: false } as const;

/**
 * DATABASE_PRIVILEGE_INSUFFICIENT, exit 4: names the missing capability category and points to the documented
 * profile. It never names the role, host, port or URL, and is raised before the command changes anything.
 */
export function privilegeFailure(command: string, shortfall: PrivilegeInsufficient): CliOutcome {
  const { capability } = shortfall;
  const description = profileCapabilities.includes(capability)
    ? "Grant the configured database credential this capability from the minimum-privilege profile under \"Credential authority\" in the package docs/maintenance.md, then retry."
    : "This command needs authority beyond the minimum-privilege profile. Configure a credential with this capability, listed under \"Credential authority\" in the package docs/maintenance.md, then retry.";
  return failure(command, 4, { code: "DATABASE_PRIVILEGE_INSUFFICIENT", message: `The configured database credential lacks the ${capability} capability this command needs. Nothing was changed.`, expected: { capability, privileges: capabilities[capability] }, actions: [{ command: `fleur ${command}`, description }] });
}
const unavailableAction: RecoveryAction = { command: "fleur status", description: "Check database connectivity, then start the PostgreSQL server or correct the private database configuration." };
/** Maps an operation failure to its stable code, exit category and recovery action. */
export function databaseFailure(command: string, error: unknown, codes: readonly string[], action: RecoveryAction): CliOutcome {
  const shortfall = privilegeShortfall(error);
  if (shortfall) return privilegeFailure(command, shortfall);
  const code = error instanceof Error && [...codes, "DATABASE_UNAVAILABLE"].includes(error.message) ? error.message : "INTERNAL_FAILURE";
  if (code === "DATABASE_UNAVAILABLE") return failure(command, 4, { code, message: "The database could not be reached or refused the connection.", actions: [unavailableAction] });
  return failure(command, code === "ARGUMENT_INVALID" ? 2 : ["MAINTENANCE_BUSY", "RECOVERY_REQUIRED"].includes(code) ? 5 : ["CONFIGURATION_MISSING", "PREREQUISITE_UNAVAILABLE"].includes(code) ? 4 : 1, { code, message: "The database operation could not complete safely.", actions: [action] });
}
const configurationAction: RecoveryAction = { command: "fleur status", description: "Correct FLEUR_PRIVATE_DATABASE_URL and FLEUR_PRIVATE_CONTROL_DATABASE_URL so both reach the same PostgreSQL cluster, then check status again." };
const configurationMissing = (command: string) => failure(command, 4, { code: "CONFIGURATION_MISSING", message: "Explicit private database configuration for the selected target is required.", actions: [] });

/** `status`: application state plus database health. Findings are exit-0 data; nothing is changed. */
export const statusCommand: CommandDefinition = {
  name: "status", usage: "status [--production]", summary: "Report application state and read-only database health.", options: [productionOption],
  validateArgs(args) {
    if (args.length > 1 || (args.length === 1 && args[0] !== productionOption.name)) return failure("status", 2, { code: "ARGUMENT_INVALID", message: "Use status with only the documented options.", actions: [] });
    return undefined;
  },
  async run({ args, project, timeoutSeconds, timeoutExplicit, environment = process.env }) {
    const production = args.includes(productionOption.name);
    if (!production) {
      const { developmentStatus } = await import("../development/lifecycle");
      const state = await developmentStatus(project, timeoutExplicit ? timeoutSeconds * 1000 : 5000);
      if (state) return success("status", state);
      if (![environment.FLEUR_PRIVATE_DATABASE_URL, environment.FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL, environment.FLEUR_PRIVATE_CONTROL_DATABASE_URL].some(value => value !== undefined)) return success("status", { state: "stopped", ready: false, instance: null, url: null, generation: 0, error: null, database: null, reasons: [] });
    }
    const { selectTarget } = await import("./target");
    let target;
    try { target = selectTarget(production, environment); } catch { return configurationMissing("status"); }
    try {
      const { databaseHealth, readinessReasons } = await import("./health");
      // The probe has its own 5 s default deadline; an explicit --timeout replaces it.
      const config = { ...(environment.FLEUR_PRIVATE_STATE_ROOT ? { stateRoot: environment.FLEUR_PRIVATE_STATE_ROOT } : {}), timeoutMs: timeoutExplicit ? timeoutSeconds * 1000 : 5000, ...(environment.FLEUR_PRIVATE_CONTROL_DATABASE_URL ? { controlUrl: environment.FLEUR_PRIVATE_CONTROL_DATABASE_URL } : {}) };
      const health = await databaseHealth(target.url, target, project, config);
      // No lifecycle binding exists here. Explicit private targets still use
      // shared read-only health; production registration belongs to start (#36).
      return success("status", JSON.parse(JSON.stringify({ state: production ? null : "stopped", ready: false, reasons: health.reasons.map(code => ({ code, ...readinessReasons[code] })), database: health.database })));
    } catch (error) {
      // The control and target connections reached different servers or databases: only configuration can fix that.
      if (error instanceof Error && error.message === "CONFIGURATION_MISSING") return failure("status", 4, { code: "CONFIGURATION_MISSING", message: "The configured database and control database do not identify the same PostgreSQL target.", actions: [configurationAction] });
      if (error instanceof Error && error.message === "SOURCE_REJECTED") return failure("status", 1, { code: "SOURCE_REJECTED", message: "The committed migration files could not be read.", actions: [{ command: "fleur db migration plan", description: "Inspect the committed migration files." }] });
      return databaseFailure("status", error, [], { command: "fleur status", description: "Retry status; the failure did not change anything." });
    }
  },
};

const databaseOperations: readonly CommandDefinition[] = [
  { name: "db inspect", usage: "db inspect [--table <name>] [--limit 100] [--cursor <token>] [--export <file>] [--production]", options: [...["--table", "--limit", "--cursor", "--export"].map(name => ({ name, value: true })), productionOption] },
  { name: "db backup", usage: "db backup --out <file>", options: [{ name: "--out", value: true }] },
  { name: "db recover", usage: "db recover --inspect", options: [{ name: "--inspect", value: false }] },
].map(definition => ({ ...definition, summary: definition.name === "db inspect" ? "Inspect the schema overview or bounded table data, or export a page to a file." : definition.name === "db backup" ? "Create and restore-verify a retained database backup." : "Inspect durable maintenance state without clearing it.",
  validateArgs(args) {
    const flags = new Map<string, boolean>(definition.options.map(option => [option.name, option.value]));
    for (let index = 0; index < args.length; index++) {
      if (!flags.has(args[index]!)) return failure(definition.name, 2, { code: "ARGUMENT_INVALID", message: "Use the documented named database operation options.", actions: [] });
      if (flags.get(args[index]!)) index++;
    }
    const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag)+1] : undefined;
    if ((definition.name === "db backup" && !value("--out")) || (definition.name === "db recover" && !args.includes("--inspect")) || (value("--cursor") && !/^[A-Za-z0-9_-]{40,16384}$/.test(value("--cursor")!)) || (value("--limit") && (!/^[0-9]+$/.test(value("--limit")!) || Number(value("--limit")) < 1 || Number(value("--limit")) > 500))) return failure(definition.name, 2, { code: "ARGUMENT_INVALID", message: "Supply complete options and a row limit from 1 to 500.", actions: [] });
    return undefined;
  },
  async run({ args, timeoutSeconds, project, environment = process.env }) {
    let url = environment.FLEUR_PRIVATE_DATABASE_URL, kind: import("./target").TargetKind = "development";
    if (definition.name === "db inspect") {
      const { selectTarget } = await import("./target");
      try { ({ url, kind } = selectTarget(args.includes(productionOption.name), environment)); } catch { return configurationMissing(definition.name); }
    }
    if (!url) return failure(definition.name, 4, { code: "CONFIGURATION_MISSING", message: "Explicit private database configuration is required.", actions: [] });
    const config = { ...(environment.FLEUR_PRIVATE_STATE_ROOT ? { stateRoot: environment.FLEUR_PRIVATE_STATE_ROOT } : {}), timeoutMs: timeoutSeconds*1000, ...(environment.FLEUR_PRIVATE_CONTROL_DATABASE_URL ? { controlUrl: environment.FLEUR_PRIVATE_CONTROL_DATABASE_URL } : {}) };
    const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag)+1] : undefined;
    try {
      if (definition.name === "db recover") {
        const {inspectMaintenance}=await import("./recovery");
        return success(definition.name,JSON.parse(JSON.stringify(await inspectMaintenance(url,config))));
      }
      if (definition.name === "db inspect") {
        const { inspectDatabase } = await import("./inspection");
        const result = await inspectDatabase(url, { project, ...(value("--table") ? { table: value("--table")! } : {}), ...(value("--limit") ? { limit: Number(value("--limit")) } : {}), ...(value("--cursor") ? { cursor: value("--cursor")! } : {}), ...(value("--export") ? { export: value("--export")! } : {}) }, { ...config, kind });
        const outcome = success(definition.name, result.data);
        return { ...outcome, result: { ...outcome.result, truncated: result.truncated } };
      }
      const { backupDatabase } = await import("./backup");
      return success(definition.name, await backupDatabase(url, value("--out")!, { ...config, timeoutMs: timeoutSeconds*1000, ...(environment.FLEUR_PRIVATE_PG_TOOLS ? { toolDirectory: environment.FLEUR_PRIVATE_PG_TOOLS } : {}) }));
    } catch (error) {
      return databaseFailure(definition.name, error, ["ARGUMENT_INVALID", "CONFIGURATION_MISSING", "MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "RESULT_TOO_LARGE", "UNSUPPORTED_CAPABILITY", "PREREQUISITE_UNAVAILABLE", "BACKUP_VERIFICATION_FAILED", "DESTINATION_EXISTS", "SOURCE_REJECTED"], { command: "fleur db recover --inspect", description: "Inspect maintenance state before retrying." });
    }
  },
}));
/** Catalogued database commands; `status` leads so the release entry point's handler list stays unchanged. */
export const databaseCommands: readonly CommandDefinition[] = [statusCommand, ...databaseOperations];

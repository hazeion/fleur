import type { CommandDefinition } from "../../cli/catalog";
import { failure, success } from "../../cli/result";
import { databaseFailure, privilegeFailure, productionOption } from "./commands";
import { privilegeShortfall } from "./privilege";

export const migrationCommands: readonly CommandDefinition[] = [
  ...["generate", "plan", "status", "apply"].map(action => ({ name: `db migration ${action}`, usage: `db migration ${action}${action === "apply" ? " [--grant <id>]" : action === "status" ? " [--production]" : ""}`, options: action === "apply" ? [{ name: "--grant", value: true }] : action === "status" ? [productionOption] : [] })),
  { name: "db restore", usage: "db restore --from <file> [--grant <id>]", options: [{ name: "--from", value: true }, { name: "--grant", value: true }] },
].map(definition => ({ ...definition, summary: "Review transactional migrations and explicitly recover database maintenance.",
  validateArgs(args) {
    for (let index = 0; index < args.length; index++) {
      const option = definition.options.find(item => item.name === args[index]);
      if (!option || (option.value && !args[++index])) return failure(definition.name, 2, { code: "ARGUMENT_INVALID", message: "Use the documented migration options.", actions: [] });
    }
    if (definition.name === "db restore" && !args.includes("--from")) return failure(definition.name, 2, { code: "ARGUMENT_INVALID", message: "Select the retained backup with --from.", actions: [] });
    return undefined;
  },
  async run({ project, timeoutSeconds, args, json }) {
    try {
    if (definition.name === "db migration generate") {
      const { migrationTables } = await import("./migration-declarations");
      const { generateMigration } = await import("./migration-plan");
      return success(definition.name, JSON.parse(JSON.stringify(await generateMigration(project, await migrationTables(project)))));
    }
    if (definition.name === "db migration plan") {
      const { readMigrations } = await import("./migration-plan");
      return success(definition.name, JSON.parse(JSON.stringify({ migrations: await readMigrations(project) })));
    }
    let url=process.env.FLEUR_PRIVATE_DATABASE_URL,kind:import("./target").TargetKind="development";
    if (definition.name==="db migration status") {
      const { selectTarget } = await import("./target");
      try { ({ url, kind } = selectTarget(args.includes(productionOption.name))); } catch { url = undefined; }
    }
    if (url) {
      const { applyMigrations, migrationStatus, restoreDatabase } = await import("./migrations");
      const {terminalApproval}=await import("./maintenance-authority");
      const grant=args.includes("--grant")?args[args.indexOf("--grant")+1]:undefined;
      const config={...(grant?{grant}:{}),...(!json?{confirm:(request:import("./maintenance-authority").MaintenanceApproval)=>terminalApproval(request,timeoutSeconds*1000)}:{}),timeoutMs:timeoutSeconds*1000,...(process.env.FLEUR_PRIVATE_CONTROL_DATABASE_URL?{controlUrl:process.env.FLEUR_PRIVATE_CONTROL_DATABASE_URL}:{}),...(process.env.FLEUR_PRIVATE_PG_TOOLS?{toolDirectory:process.env.FLEUR_PRIVATE_PG_TOOLS}:{})};
      if(definition.name==="db restore") return success(definition.name,JSON.parse(JSON.stringify(await restoreDatabase(url,project,args[args.indexOf("--from")+1]!,config))));
      if(definition.name==="db migration status") {
        const report=await migrationStatus(url,project,{...config,kind});
        const outcome=success(definition.name,JSON.parse(JSON.stringify(report)));
        return {...outcome,result:{...outcome.result,truncated:report.differencesTruncated}};
      }
      if(definition.name==="db migration apply") return success(definition.name,JSON.parse(JSON.stringify(await applyMigrations(url,project,config))));
    }
    return failure(definition.name, 4, { code: "CONFIGURATION_MISSING", message: "Explicit private database configuration is required.", actions: [] });
    } catch(error) {
      const shortfall=privilegeShortfall(error);
      if(shortfall)return privilegeFailure(definition.name,shortfall);
      if(error instanceof Error&&error.message==="DATABASE_UNAVAILABLE")return databaseFailure(definition.name,error,[],{command:"fleur status",description:"Check database connectivity."});
      const code=error instanceof Error && ["AUTHORITY_REQUIRED","MIGRATION_EDITED","MIGRATIONS_PENDING","MIGRATION_INCOMPATIBLE","SCHEMA_DRIFT","MAINTENANCE_BUSY","RECOVERY_REQUIRED","CONFIGURATION_MISSING","PREREQUISITE_UNAVAILABLE","SOURCE_REJECTED","BACKUP_VERIFICATION_FAILED"].includes(error.message)?error.message:"INTERNAL_FAILURE";
      return failure(definition.name,code==="AUTHORITY_REQUIRED"?3:["SCHEMA_DRIFT","MIGRATION_EDITED","MIGRATIONS_PENDING","MAINTENANCE_BUSY","RECOVERY_REQUIRED"].includes(code)?5:["CONFIGURATION_MISSING","PREREQUISITE_UNAVAILABLE"].includes(code)?4:1,{code,message:"Migration maintenance could not complete safely.",actions:[{command:"fleur db recover --inspect",description:"Inspect actual state before taking recovery action."}]});
    }
  },
}));

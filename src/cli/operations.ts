import { lifecycleCommands } from "../runtime/development/commands";
import { productionCommands } from "../runtime/production/commands";
import { seedCommands } from "../runtime/database/seed-commands";
import { migrationCommands } from "../runtime/database/migration-commands";
import { databaseCommands } from "../runtime/database/commands";
import { projectCommands } from "../project/commands";
import { setupCommands } from "../setup/commands";
import { guidanceCommands } from "../project/guidance-commands";
export function operationCommands(setupDefinitions = setupCommands()) {
  return [...projectCommands, ...setupDefinitions, ...databaseCommands, ...seedCommands, ...migrationCommands, ...lifecycleCommands, ...productionCommands, ...guidanceCommands];
}
export const commands = operationCommands();

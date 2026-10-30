import { isIP } from "node:net";
import type { CommandDefinition } from "../../cli/catalog";
import { failure } from "../../cli/result";

export const lifecycleCommands: readonly CommandDefinition[] = [
  { name: "dev", summary: "Run the owned development environment.", usage: "dev [--background] [--host <address>] [--port <number>]", options: [{ name: "--background", value: false }, { name: "--host", value: true }, { name: "--port", value: true }] },
  { name: "stop", summary: "Stop owned development resources, preserving data and backups.", usage: "stop" },
  { name: "logs", summary: "Read bounded development logs.", usage: "logs [--limit 200] [--cursor <token>] [--follow]", options: [{ name: "--limit", value: true }, { name: "--cursor", value: true }, { name: "--follow", value: false }] },
].map(definition => ({ ...definition,
  validateArgs(args) {
    const options: readonly { name: string; value: boolean }[] = "options" in definition ? definition.options ?? [] : [];
    for (let index = 0; index < args.length; index++) {
      const option = options.find(option => option.name === args[index]);
      if (!option) return invalid(definition.name);
      if (option.value) {
        const value = args[++index];
        if (!value || (option.name === "--port" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) || (option.name === "--limit" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200)) || (option.name === "--host" && value !== "localhost" && !isIP(value)) || (option.name === "--cursor" && !/^[0-9]{1,16}\.[a-f0-9]{64}$/.test(value))) return invalid(definition.name);
      }
    }
    return undefined;
  },
  async run(input) {
    const { runLifecycle } = await import("./lifecycle");
    return runLifecycle(definition.name, input);
  },
}));
function invalid(command: string) { return failure(command, 2, { code: "ARGUMENT_INVALID", message: "Use the documented lifecycle options and bounds.", actions: [] }); }

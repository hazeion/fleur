import { isIP } from "node:net";
import type { CommandDefinition } from "../../cli/catalog";
import { failure } from "../../cli/result";

const startOptions = [{ name: "--artifact", value: true }, { name: "--host", value: true }, { name: "--port", value: true }];
const invalid = (command: string) => failure(command, 2, { code: "ARGUMENT_INVALID", message: "Use the documented production options and bounds.", actions: [] });
export const productionCommands: readonly CommandDefinition[] = [
  { name: "build", usage: "build", summary: "Build an immutable, self-contained production artifact.", options: [],
    validateArgs: args => args.length ? invalid("build") : undefined,
    async run(input) { return (await import("./build")).runBuild(input); } },
  { name: "start", usage: "start --artifact <dir> [--host <address>] [--port <number>]", summary: "Serve a verified production artifact against configured PostgreSQL.", options: startOptions,
    validateArgs(args) {
      const seen = new Set<string>();
      for (let index = 0; index < args.length; index += 2) {
        const name = args[index]!, value = args[index + 1];
        if (!startOptions.some(option => option.name === name) || seen.has(name) || !value) return invalid("start");
        seen.add(name);
        if (name === "--port" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) return invalid("start");
        if (name === "--host" && value !== "localhost" && !isIP(value)) return invalid("start");
      }
      return seen.has("--artifact") ? undefined : invalid("start");
    },
    async run(input) { return (await import("./start")).runStart(input); } },
];

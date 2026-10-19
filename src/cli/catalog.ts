import type { CliOutcome } from "./result.ts";
export interface CommandInput {
  readonly args: readonly string[];
  readonly project: string;
  readonly timeoutSeconds: number;
  readonly json: boolean;
}
export interface CommandDefinition {
  readonly name: string;
  readonly summary: string;
  readonly options?: readonly { readonly name: string; readonly value: boolean }[];
  readonly run: (input: CommandInput) => Promise<CliOutcome>;
}
export const helpCommand = { name: "help", summary: "Show available commands and global options." } as const;
export const globalOptions = [
  { name: "--project", value: "dir", description: "Select the project directory." },
  { name: "--json", value: null, description: "Print one JSON version 1 result." },
  { name: "--timeout", value: "seconds", description: "Set a positive operation timeout; default 60 seconds." },
  { name: "--help", value: null, description: "Show available commands and global options." },
] as const;
export function renderHelp(handlers: readonly CommandDefinition[] = []): string {
  return [
    "Usage: fleur <command> [options]",
    "",
    "Commands:",
    ...[helpCommand, ...handlers].map(({ name, summary }) => `  ${name}  ${summary}`),
    "",
    "Global options:",
    ...globalOptions.map(({ name, value, description }) => `  ${name}${value ? ` <${value}>` : ""}  ${description}`),
    "",
  ].join("\n");
}

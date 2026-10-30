import type { CliOutcome } from "./result.ts";
export interface CommandInput {
  readonly args: readonly string[];
  readonly project: string;
  readonly timeoutSeconds: number;
  /** True when --timeout was given; commands with their own shorter default deadline use it only then. */
  readonly timeoutExplicit?: boolean;
  readonly json: boolean;
  /** Trusted private invocation configuration, never application input. */
  readonly environment?: Record<string, string | undefined>;
}
export interface CommandDefinition {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  readonly options?: readonly { readonly name: string; readonly value: boolean }[];
  /** Pure syntax validation only; must not probe or change external state. */
  readonly validateArgs?: (args: readonly string[]) => CliOutcome | undefined;
  readonly run: (input: CommandInput) => Promise<CliOutcome>;
}
export const helpCommand = { name: "help", summary: "Show available commands and global options." } as const;
export const globalOptions = [
  { name: "--project", value: "dir", description: "Select the project directory." },
  { name: "--json", value: null, description: "Print JSON version 1 results or newline-delimited stream events." },
  { name: "--timeout", value: "seconds", description: "Set a positive operation timeout; default 60 seconds." },
  { name: "--help", value: null, description: "Show available commands and global options." },
] as const;
export function renderHelp(handlers: readonly CommandDefinition[] = []): string {
  return [
    "Usage: fleur <command> [options]",
    "",
    "Commands:",
    ... [helpCommand, ...handlers].flatMap((command) => [
      `  ${"usage" in command && command.usage ? command.usage : command.name}  ${command.summary}`,
      ...("options" in command ? command.options ?? [] : []).map(({ name, value }) => `    ${name}${value ? " <value>" : ""}`),
    ]),
    "",
    "Global options:",
    ...globalOptions.map(({ name, value, description }) => `  ${name}${value ? ` <${value}>` : ""}  ${description}`),
    "",
  ].join("\n");
}

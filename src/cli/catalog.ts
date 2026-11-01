import { failure, type CliOutcome, type Json, type CommandError } from "./result.ts";
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
  readonly options?: readonly { readonly name: string; readonly value: boolean; readonly repeatable?: boolean; readonly text?: boolean; readonly pattern?: string }[];
  /** Pure syntax validation only; must not probe or change external state. */
  readonly grammar?: ArgumentGrammar;
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

/** The same definitions drive dispatch, help, offline reference and machine grammar. */
export function operationCatalog(handlers: readonly CommandDefinition[]): { readonly [key: string]: Json } {
  return { catalogVersion: 1, guidanceErrors, commands: [helpCommand, ...handlers.map(command => { const { name, summary, usage, options } = command; return { name, summary, usage: usage ?? name, inputSchema: commandInputSchema(command), options: (options ?? []).map(option => ({ name: option.name, value: option.value, ...(option.repeatable ? { repeatable: true } : {}), ...(option.text ? { text: true } : {}), ...(option.pattern ? { pattern: option.pattern } : {}) })) }; })], globalOptions,
    resultSchema: { type: "object", required: ["formatVersion", "command", "ok", "data", "error", "truncated"], additionalProperties: false,
      properties: { formatVersion: { const: 1 }, command: { enum: ["help", ...handlers.map(handler => handler.name)] }, ok: { type: "boolean" }, data: {}, error: { oneOf: [{ type: "null" }, { type: "object", required: ["code", "message", "actions"], properties: { code: { type: "string" }, message: { type: "string" }, actions: { type: "array", items: { type: "object", required: ["command", "description"], properties: { command: { type: "string" }, description: { type: "string" } } } }, expected: {}, actual: {} } }] }, truncated: { type: "boolean" } } } };
}
export function operationReference(handlers: readonly CommandDefinition[]): string {
  return "\n## Operation catalog (version 1)\n\n" + renderHelp(handlers).split("\n").map(line => line ? "    " + line : "").join("\n");
}

export interface ArgumentGrammar {
  readonly minPositionals: number;
  readonly maxPositionals: number;
  readonly positionalEnum?: readonly string[];
  /** Admitted sets of option names, independent of order. */
  readonly optionForms: readonly (readonly string[])[];
}
export function validateCatalogArguments(command: Pick<CommandDefinition, "name" | "options" | "grammar">, args: readonly string[]): CliOutcome | undefined {
  const grammar = command.grammar;
  if (!grammar) return undefined;
  const positionals: string[] = [], names: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) { positionals.push(arg); continue; }
    const option = command.options?.find(option => option.name === arg);
    if (!option || names.includes(arg)) return argumentInvalid(command.name);
    names.push(arg);
    if (option.value) {
      const value = args[++index];
      if (value === undefined || (option.pattern && !new RegExp(option.pattern).test(value))) return argumentInvalid(command.name);
    }
  }
  if (positionals.length < grammar.minPositionals || positionals.length > grammar.maxPositionals || (grammar.positionalEnum && positionals.some(value => !grammar.positionalEnum!.includes(value))) || !grammar.optionForms.some(form => form.length === names.length && form.every(name => names.includes(name)))) return argumentInvalid(command.name);
  return undefined;
}
function argumentInvalid(command: string): CliOutcome {
  return { exitCode: 2, result: { formatVersion: 1, command, ok: false, data: null, error: { code: "ARGUMENT_INVALID", message: "Use the catalog's documented operation grammar.", actions: [] }, truncated: false } };
}
function commandInputSchema(command: CommandDefinition): Json {
  const options: Record<string, Json> = Object.fromEntries((command.options ?? []).map((option): [string, Json] => [option.name, option.repeatable ? { type: "array", items: { type: "string", ...(option.pattern ? { pattern: option.pattern } : {}) } } : option.value ? { type: "string", ...(option.pattern ? { pattern: option.pattern } : {}) } : { const: true }]));
  return { type: "object", additionalProperties: false, required: ["positionals", "options"], properties: {
    positionals: { type: "array", items: command.grammar?.positionalEnum ? { enum: [...command.grammar.positionalEnum] } : { type: "string" }, ...(command.grammar ? { minItems: command.grammar.minPositionals, maxItems: command.grammar.maxPositionals } : {}) },
    options: { type: "object", additionalProperties: false, properties: options, ...(command.grammar ? { oneOf: command.grammar.optionForms.map(form => ({ required: [...form], minProperties: form.length, maxProperties: form.length })) } : {}) },
  } };
}
/** Stable errors introduced by the guidance/upgrade slice. Other slices retain their command-specific errors. */
export const guidanceErrors = {
  GUIDANCE_MISMATCH: { exit: 4, recovery: "fleur docs refresh --preview" },
  GUIDANCE_CONFLICT: { exit: 3, recovery: "fleur docs refresh --preview" },
  PREVIEW_CHANGED: { exit: 3, recovery: "fleur docs refresh --preview" },
  GUIDANCE_REFRESH_FAILED: { exit: 1, recovery: "fleur docs refresh --preview" },
  UPGRADE_PATH_UNSUPPORTED: { exit: 4, recovery: "fleur docs upgrades" },
  UPGRADE_REVIEW_REQUIRED: { exit: 3, recovery: "fleur upgrade --to <exact-version> --preview" },
  UPGRADE_INCOMPATIBLE: { exit: 4, recovery: "fleur doctor" },
  UPGRADE_FAILED: { exit: 1, recovery: "fleur doctor" },
  UPDATE_TIMEOUT: { exit: 4, recovery: "fleur docs refresh --preview" },
  VERIFY_TIMEOUT: { exit: 4, recovery: "fleur verify --timeout <seconds>" },
  VERIFY_FAILED: { exit: 1, recovery: "fleur docs core" },
  RECOVERY_REQUIRED: { exit: 5, recovery: "fleur docs refresh --recover" },
} as const;

export function catalogFailure(command: string, code: keyof typeof guidanceErrors, details: Omit<CommandError, "code" | "actions"> & { readonly actions?: CommandError["actions"] }, data: Json = null): CliOutcome {
  const rule = guidanceErrors[code];
  return failure(command, rule.exit, { ...details, code, actions: details.actions ?? [{ command: rule.recovery, description: "Inspect the documented recovery operation before retrying." }] }, data);
}

import release from "../../package.json" with { type: "json" };
import { resolve } from "node:path";
import { bunAdmission, bunFloor } from "../project/release.ts";
import { globalOptions, helpCommand, type CommandDefinition } from "./catalog.ts";
import { failure, success, type CliOutcome } from "./result.ts";
export interface CliContext { readonly cwd: string; readonly handlers?: readonly CommandDefinition[] }
function invalid(): CliOutcome {
  return failure("help", 2, { code: "ARGUMENT_INVALID", message: "Invalid command or options.", actions: [{ command: "fleur --help", description: "Inspect the available command grammar." }] });
}
export interface Invocation {
  readonly handler: CommandDefinition | undefined;
  readonly commandArgs: readonly string[];
  readonly project: string;
  readonly timeoutSeconds: number;
  readonly timeoutExplicit: boolean;
  readonly json: boolean;
  readonly help: boolean;
}
export function parseInvocation(argv: readonly string[], context: CliContext): { readonly error: CliOutcome } | { readonly invocation: Invocation } {
  const args: string[] = [];
  const seen = new Set<string>();
  let project = context.cwd;
  let timeoutSeconds = 60;
  let json = false;
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!globalOptions.some(({ name }) => name === arg)) { args.push(arg); continue; }
    if (seen.has(arg)) return { error: invalid() };
    seen.add(arg);
    if (arg === "--json") json = true;
    else if (arg === "--help") help = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("-")) return { error: invalid() };
      if (arg === "--project") project = resolve(context.cwd, value);
      else {
        if (!/^(?:[0-9]+)(?:\.[0-9]+)?$/.test(value)) return { error: invalid() };
        timeoutSeconds = Number(value);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 2147483) return { error: invalid() };
      }
    }
  }
  const handlers = context.handlers ?? [];
  const handler = [...handlers].sort((a, b) => b.name.split(" ").length - a.name.split(" ").length).find(({ name }) => name.split(" ").every((part, index) => args[index] === part));
  const commandArgs = handler ? args.slice(handler.name.split(" ").length) : args;
  if (!handler && args.length && !(args.length === 1 && args[0] === "help")) return { error: invalid() };
  const commandSeen = new Set<string>();
  for (let index = 0; index < commandArgs.length && handler; index++) {
    const arg = commandArgs[index]!;
    if (!arg.startsWith("-")) continue;
    const option = handler.options?.find(({ name }) => name === arg);
    if (!option || commandSeen.has(arg)) return { error: invalid() };
    commandSeen.add(arg);
    if (option.value) {
      const value = commandArgs[++index];
      if (!value || value.startsWith("-")) return { error: invalid() };
    }
  }
  return { invocation: { handler, commandArgs, project, timeoutSeconds, timeoutExplicit: seen.has("--timeout"), json, help } };
}
export async function runCli(argv: readonly string[], context: CliContext = { cwd: process.cwd() }): Promise<CliOutcome> {
  const parsed = parseInvocation(argv, context);
  if ("error" in parsed) return parsed.error;
  const { handler, commandArgs, project, timeoutSeconds, timeoutExplicit, json, help } = parsed.invocation;
  const handlers = context.handlers ?? [];
  if (help || !handler) return success("help", {
    commands: [helpCommand, ...handlers.map(({ name, summary, usage, options }) => ({ name, summary, ...(usage ? { usage } : {}), ...(options ? { options } : {}) }))],
    options: globalOptions,
  });
  const invalidArguments = handler.validateArgs?.(commandArgs);
  if (invalidArguments) return invalidArguments;
  const { guardProjectPin } = await import("./project-pin.ts");
  const blocked = await guardProjectPin(handler.name, project);
  if (blocked) return blocked;
  // The stored floor is validated before any comparison; an invalid floor refuses rather than admitting every Bun.
  const admission = bunAdmission(Bun.version, bunFloor);
  if (!admission.admitted && admission.reason === "invalid-floor") return failure(handler.name, 4, {
    code: "BUN_VERSION_MISMATCH", expected: ">=X.Y.Z", actual: bunFloor,
    message: `Fleur ${release.version} declares an invalid Bun floor ${JSON.stringify(bunFloor)}; its package metadata must declare >=X.Y.Z. Reinstall this exact Fleur release manually and retry.`,
    actions: [{ command: "bun --version", description: `Inspect Bun, then reinstall Fleur ${release.version} from its official package. Fleur does not upgrade or replace Bun.` }],
  });
  if (!admission.admitted) return failure(handler.name, 4, {
    code: "BUN_VERSION_MISMATCH", expected: bunFloor, actual: Bun.version,
    message: `Fleur ${release.version} requires Bun ${bunFloor}; invoking Bun is ${Bun.version}. Install a Bun release at or above the floor manually and retry.`,
    actions: [{ command: "bun --version", description: `Inspect Bun, then install a stable release at or above ${bunFloor} manually using https://bun.sh/docs/installation. Fleur does not upgrade or replace Bun.` }],
  });
  try {
    let environment = process.env;
    if (handler.name.startsWith("db ") && !["db migration generate", "db migration plan"].includes(handler.name) && !commandArgs.includes("--production")) {
      try { environment = await (await import("../runtime/development/database-context")).databaseEnvironment(project); }
      catch (error) {
        if (error instanceof Error && error.message === "RECOVERY_REQUIRED") return failure(handler.name, 5, { code: "RECOVERY_REQUIRED", message: "The development storage binding could not be verified.", actions: [{ command: "fleur logs", description: "Inspect private ownership evidence before selecting a database." }] });
        return failure(handler.name, 4, { code: "DATABASE_UNAVAILABLE", message: "The owned development database is unavailable.", actions: [{ command: "fleur dev", description: "Explicitly start the development environment before using database operations." }] }); }
    }
    return await handler.run({ args: commandArgs, project, timeoutSeconds, timeoutExplicit, json, environment });
  }
  catch { return failure(handler.name, 1, { code: "INTERNAL_FAILURE", message: "The command failed unexpectedly.", actions: [] }); }
}

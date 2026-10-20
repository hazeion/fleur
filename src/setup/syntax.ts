import { failure, type CliOutcome } from "../cli/result.ts";
/** Pure grammar only: never inspect the machine, authority store or project filesystem. */
export function validateSetupArguments(command: string, args: readonly string[]): CliOutcome | undefined {
  const message = command === "doctor" && args.length ? "Doctor takes no positional arguments."
    : command === "setup grants list" && args.length ? "Grant inspection takes no positional arguments."
      : command === "setup grants revoke" && (args.length !== 1 || !args[0] || !/^[a-f0-9-]{36}$/.test(args[0])) ? "Specify exactly one setup grant ID."
        : command === "setup" && args.some((arg, index) => arg !== "--grant" && args[index - 1] !== "--grant") ? "Setup accepts only --grant <id>." : undefined;
  return message ? failure(command, 2, { code: "ARGUMENT_INVALID", message, actions: [] }) : undefined;
}

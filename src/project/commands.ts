import { resolve } from "node:path";
import type { CommandDefinition } from "../cli/catalog.ts";
import { failure, type CliOutcome } from "../cli/result.ts";
import { createProject } from "./create.ts";
function projectArguments(name: string, args: readonly string[]): { dirs: string[]; compiler: string; error?: CliOutcome } {
  const dirs: string[] = [];
  let compiler = "microsoft";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--compiler") compiler = args[++index]!;
    else if (arg !== "--no-git") dirs.push(arg);
  }
  const error = !["microsoft", "rust-experimental"].includes(compiler)
    ? failure(name, 2, { code: "ARGUMENT_INVALID", message: "Choose microsoft or rust-experimental.", actions: [] })
    : dirs.length !== (name === "new" ? 1 : 0) || dirs.some((dir) => dir.length === 0)
      ? failure(name, 2, { code: "ARGUMENT_INVALID", message: "Supply one directory for new, or no directory for init.", actions: [] }) : undefined;
  return { dirs, compiler, error };
}
export const projectCommands: readonly CommandDefinition[] = ["new", "init"].map((name) => ({
  name, usage: `${name}${name === "new" ? " <dir>" : ""} [--compiler microsoft|rust-experimental] [--no-git]`, summary: name === "new" ? "Create an exactly pinned Fleur project." : "Initialize a Fleur project without overwriting user files.",
  options: [{ name: "--no-git", value: false }, { name: "--compiler", value: true }],
  validateArgs: (args: readonly string[]) => projectArguments(name, args).error,
  async run({ args, project, timeoutSeconds }) {
    const { dirs, compiler, error } = projectArguments(name, args);
    if (error) return error;
    if (compiler === "rust-experimental") return failure(name, 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The experimental Rust compiler equivalence gate has not passed.", expected: "verified exact compiler package and upstream revision", actual: "unavailable", actions: [{ command: "fleur new <dir> --compiler microsoft", description: "Use the verified default compiler." }] });
    return await createProject(name, name === "new" ? resolve(project, dirs[0]!) : project, !args.includes("--no-git"), timeoutSeconds);
  },
}));

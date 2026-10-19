import { resolve } from "node:path";
import type { CommandDefinition } from "../cli/catalog.ts";
import { failure } from "../cli/result.ts";
import { createProject } from "./create.ts";
export const projectCommands: readonly CommandDefinition[] = ["new", "init"].map((name) => ({
  name, summary: name === "new" ? "Create an exactly pinned Fleur project." : "Initialize a Fleur project without overwriting user files.",
  options: [{ name: "--no-git", value: false }, { name: "--compiler", value: true }],
  async run({ args, project, timeoutSeconds }) {
    const dirs: string[] = [];
    let compiler = "microsoft";
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "--compiler") compiler = args[++index]!;
      else if (arg !== "--no-git") dirs.push(arg);
    }
    if (!["microsoft", "rust-experimental"].includes(compiler)) return failure(name, 2, { code: "ARGUMENT_INVALID", message: "Choose microsoft or rust-experimental.", actions: [] });
    if (compiler === "rust-experimental") return failure(name, 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The experimental Rust compiler equivalence gate has not passed.", expected: "verified exact compiler package and upstream revision", actual: "unavailable", actions: [{ command: "fleur new <dir> --compiler microsoft", description: "Use the verified default compiler." }] });
    if (dirs.length !== (name === "new" ? 1 : 0)) return failure(name, 2, { code: "ARGUMENT_INVALID", message: "Supply one directory for new, or no directory for init.", actions: [] });
    return await createProject(name, name === "new" ? resolve(project, dirs[0]!) : project, !args.includes("--no-git"), timeoutSeconds);
  },
}));

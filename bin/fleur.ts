#!/usr/bin/env bun
import { seedCommands } from "../src/runtime/database/seed-commands.ts";
import { renderHelp } from "../src/cli/catalog.ts";
import { parseInvocation, runCli } from "../src/cli/main.ts";
import { migrationCommands } from "../src/runtime/database/migration-commands.ts";
import { databaseCommands, statusCommand } from "../src/runtime/database/commands.ts";
import { projectCommands } from "../src/project/commands.ts";
import { setupCommands } from "../src/setup/commands.ts";
import type { CliOutcome } from "../src/cli/result.ts";
const argv = process.argv.slice(2);
const handlers = [...projectCommands, ...setupCommands(), statusCommand, ...databaseCommands, ...seedCommands, ...migrationCommands];
const context = { cwd: process.cwd(), handlers };
const parsed = parseInvocation(argv, context);
let outcome: CliOutcome | undefined;
if ("error" in parsed) outcome = parsed.error;
else {
  const { resolveProjectLauncher } = await import("../src/cli/project-pin.ts");
  const launcher = await resolveProjectLauncher(parsed.invocation, process.argv[1]!);
  if (launcher.kind === "delegate") {
    const { runDelegated } = await import("../src/cli/delegate.ts");
    process.exitCode = await runDelegated(launcher.bin, argv);
  } else outcome = launcher.kind === "blocked" ? launcher.outcome : await runCli(argv, context);
}
if (outcome) {
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(outcome.result) + "\n");
  else if (outcome.result.ok && outcome.result.command === "help") process.stdout.write(renderHelp(handlers));
  else process.stdout.write(outcome.result.error ? `${outcome.result.error.code}: ${outcome.result.error.message}\n` : JSON.stringify(outcome.result.data) + "\n");
  process.exitCode = outcome.exitCode;
}

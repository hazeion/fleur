#!/usr/bin/env bun
import { renderHelp } from "../src/cli/catalog.ts";
import { parseInvocation, runCli } from "../src/cli/main.ts";
import { projectCommands } from "../src/project/commands.ts";
import type { CliOutcome } from "../src/cli/result.ts";
const argv = process.argv.slice(2);
const context = { cwd: process.cwd(), handlers: projectCommands };
const parsed = parseInvocation(argv, context);
let outcome: CliOutcome | undefined;
if ("error" in parsed) outcome = parsed.error;
else {
  const { resolveProjectLauncher } = await import("../src/cli/project-pin.ts");
  const launcher = await resolveProjectLauncher(parsed.invocation, process.argv[1]!);
  if (launcher.kind === "delegate") {
    const child = Bun.spawn([process.execPath, launcher.bin, ...argv], { cwd: process.cwd(), env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const exit = await child.exited;
    const signal = child.signalCode;
    process.exitCode = signal ? 128 + (typeof signal === "number" ? signal : (await import("node:os")).constants.signals[signal]) : exit;
  } else outcome = launcher.kind === "blocked" ? launcher.outcome : await runCli(argv, context);
}
if (outcome) {
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(outcome.result) + "\n");
  else if (outcome.result.ok && outcome.result.command === "help") process.stdout.write(renderHelp(projectCommands));
  else process.stdout.write(outcome.result.error ? `${outcome.result.error.code}: ${outcome.result.error.message}\n` : JSON.stringify(outcome.result.data) + "\n");
  process.exitCode = outcome.exitCode;
}

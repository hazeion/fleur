#!/usr/bin/env bun
import { renderHelp } from "../src/cli/catalog.ts";
import { runCli } from "../src/cli/main.ts";
const outcome = await runCli(process.argv.slice(2));
if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(outcome.result) + "\n");
else if (outcome.result.ok && outcome.result.command === "help") process.stdout.write(renderHelp());
else process.stdout.write(outcome.result.error ? `${outcome.result.error.code}: ${outcome.result.error.message}\n` : JSON.stringify(outcome.result.data) + "\n");
process.exitCode = outcome.exitCode;

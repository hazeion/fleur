import { afterAll, beforeAll, expect, test } from "bun:test";
import { runCli } from "../../src/cli/main";
import { databaseCommands } from "../../src/runtime/database/commands";

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
let root: string;
const context = { cwd: "", handlers: databaseCommands };
beforeAll(async () => {
  root = await mkdtemp(`${tmpdir()}/fleur-query-grammar-`);
  context.cwd = root;
  await writeFile(`${root}/fleur.json`, JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
  await writeFile(`${root}/package.json`, JSON.stringify({ dependencies: { fleur: "0.1.0" } }));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
test("db query is discoverable and rejects production and invalid bounds before configuration", async () => {
  const help = await runCli(["--help"], context);
  expect(JSON.stringify(help.result.data)).toContain('db query');
  for (const args of [["--production", "--sql", "SELECT 1"], [], ["--sql", "SELECT 1", "--sql-file", "x"], ["--sql", "SELECT 1", "--limit", "501"], ["--sql", "SELECT 1", "--timeout", "31"]]) {
    const outcome = await runCli(["db", "query", ...args], context);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.result.error?.code).toBe("ARGUMENT_INVALID");
  }
});
test("db query refuses an unbound development database even with private production credentials", async () => {
  const outcome = await runCli(["db", "query", "--sql", "SELECT 1"], context);
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.error?.code).toBe("DATABASE_UNAVAILABLE");
});

test("SQL parameters spelling command or global options stay opaque", async () => {
  const { parseInvocation } = await import("../../src/cli/main");
  const parsed = parseInvocation(["db", "query", "--sql", "-- a comment\nSELECT $1::text", "--param", "--help", "--param", "--json", "--param", "--sql-file", "--param", "--limit"], context);
  expect(parsed).toMatchObject({ invocation: { json: false, help: false, commandArgs: ["--sql", "-- a comment\nSELECT $1::text", "--param", "--help", "--param", "--json", "--param", "--sql-file", "--param", "--limit"] } });
});

test("a parameter named --sql-file cannot select file input", async () => {
  const { queryCommand } = await import("../../src/runtime/database/query-command");
  const outcome = await queryCommand.run({ args: ["--sql", "SELECT $1::text", "--param", "--sql-file"], project: root, timeoutSeconds: 5, timeoutExplicit: false, json: true });
  expect(outcome.result.error?.code).toBe("DATABASE_UNAVAILABLE");
});

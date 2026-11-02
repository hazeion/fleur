import { expect, test } from "bun:test";
import { commands } from "../../src/cli/operations";
import { runCli } from "../../src/cli/main";

for (const name of ["test", "types", "lint", "explain"]) test(`approved ${name} command exists with closed grammar`, async () => {
  const command = commands.find(command => command.name === name);
  expect(command).toBeDefined();
  const response = await runCli([name, "--shell", "touch sentinel"], { cwd: process.cwd(), handlers: commands });
  expect(response.exitCode).toBe(2);
});
test("test admits explicit suites and filters but rejects unknown suites, duplicates and positional shell input", () => {
  const command = commands.find(command => command.name === "test");
  expect(command).toBeDefined();
  for (const args of [[], ["--suite", "database"], ["--suite", "browser", "--filter", "save"], ["--filter", "tests/value.test.ts"]]) expect(command!.validateArgs!(args)).toBeUndefined();
  for (const args of [["--suite", "arbitrary"], ["--suite", "unit", "--suite", "browser"], ["sh", "-c", "true"]]) expect(command!.validateArgs!(args)?.exitCode).toBe(2);
});

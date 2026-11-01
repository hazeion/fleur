import { expect, test } from "bun:test";
import { commands } from "../../src/cli/operations";
import { parseInvocation } from "../../src/cli/main";
import { recoveryExamples } from "../../src/project/recovery-examples";
import { readFile } from "node:fs/promises";
for (const example of recoveryExamples) test(`recovery commands and resulting-state proof remain present: ${example.name}`, async () => {
  for (const argv of [...example.diagnostics, ...example.recovery]) {
    const parsed = parseInvocation(argv, { cwd: "/synthetic", handlers: commands });
    expect("invocation" in parsed).toBe(true);
    if (!("invocation" in parsed)) throw new Error("Invalid example command");
    expect(parsed.invocation.handler).toBeDefined();
    expect(parsed.invocation.handler?.validateArgs?.(parsed.invocation.commandArgs)).toBeUndefined();
  }
  expect(example.authority.length).toBeGreaterThan(40);
  expect(example.proof.length).toBeGreaterThan(80);
  for (const path of example.tests) expect(await readFile(new URL("../../" + path, import.meta.url), "utf8")).toContain("expect(");
});

test("machine schemas and CLI validation use the same new-operation grammar", async () => {
  const { default: Ajv } = await import("../../lint/node_modules/ajv");
  const validator = new Ajv();
  const { operationCatalog } = await import("../../src/cli/catalog");
  const catalog = operationCatalog(commands);
  const entries = catalog.commands as readonly { name: string; inputSchema?: object }[];
  const samples = [
    ["docs", [], {}, true], ["docs", ["unknown"], {}, false],
    ["docs refresh", [], {}, true], ["docs refresh", [], { "--preview": true }, true],
    ["docs refresh", [], { "--replace": "a".repeat(64) }, true], ["docs refresh", [], { "--replace": "wrong" }, false],
    ["docs refresh", [], { "--preview": true, "--replace": "a".repeat(64) }, false],
    ["upgrade", [], { "--to": "0.2.0", "--preview": true }, true], ["upgrade", [], { "--to": "latest" }, false],
    ["upgrade", [], {}, false], ["verify", ["extra"], {}, false], ["verify", [], {}, true],
  ] as const;
  for (const [name, positionals, options, admitted] of samples) {
    const entry = entries.find(entry => entry.name === name)!;
    expect(validator.compile(entry.inputSchema!)({ positionals: [...positionals], options }), name + JSON.stringify(options)).toBe(admitted);
    const args = [...positionals, ...Object.entries(options).flatMap(([name, value]) => typeof value === "string" ? [name, value] : [name])];
    expect(commands.find(command => command.name === name)!.validateArgs?.(args) === undefined).toBe(admitted);
  }
});

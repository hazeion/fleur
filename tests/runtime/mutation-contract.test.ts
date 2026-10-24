import { expect, test } from "bun:test";
import * as contracts from "../../src/schema";
import * as server from "../../src/server";
import * as execution from "../../src/runtime/worker-execution";
import type { WriteDb } from "../../src/database";

test("mutation validates input before handler and output before returning to its broker", async () => {
  expect(typeof contracts.defineMutation).toBe("function");
  const mutation = contracts.defineMutation({ name: "contract.save", input: contracts.schema.object({ name: contracts.schema.string() }), output: contracts.schema.object({ saved: contracts.schema.boolean() }) });
  let calls = 0;
  server.handleMutation(mutation, async () => { calls++; return { saved: true }; });
  const db = {} as WriteDb;
  const log = { info() {}, warn() {} };
  await expect(execution.executeMutation("contract.save", { name: "Squat", extra: true }, db, log)).rejects.toThrow();
  expect(calls).toBe(0);
  expect(await execution.executeMutation("contract.save", { name: "Squat" }, db, log)).toEqual({ saved: true });
  expect(calls).toBe(1);
  const invalid = contracts.defineMutation({ name: "contract.invalid", input: contracts.schema.object({}), output: contracts.schema.boolean() });
  server.handleMutation(invalid, async () => "private SQL and secret" as unknown as boolean);
  await expect(execution.executeMutation("contract.invalid", {}, db, log)).rejects.toThrow();
});

test("explicit unversioned declarations emit the no-lost-update warning", async () => {
  const { spyOn } = await import("bun:test");
  const { column, defineTable } = await import("../../src/database");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    defineTable("audit_notes", { versioned: false, columns: { id: column.safeInteger().primaryKey() } });
    expect(warning).toHaveBeenCalledWith('Table "audit_notes" is unversioned. Updates and deletes have no lost-update guarantee.');
  } finally { warning.mockRestore(); }
});

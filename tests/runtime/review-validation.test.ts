import { expect, test } from "bun:test";
import { column, defineTable } from "../../src/database";
import { compileRead } from "../../src/runtime/database/selection";

const rows = defineTable("review_strict_options", { columns: { id: column.uuid().primaryKey() } });
for (const key of ["limit", "where", "orderBy"]) {
  test(`read requests reject explicit null ${key} instead of silently applying defaults`, () => {
    expect(() => compileRead({
      from: rows, joins: [], fields: { id: rows.id }, [key]: null,
    }, new Set([rows]), new Uint8Array(32))).toThrow();
  });
}

for (const [factory, code, details] of [
  ['publicError("NOT_FOUND", { resource: "ingredient" })', "NOT_FOUND", { resource: "ingredient" }],
  ['inputError({ name: "A name is required." })', "INPUT_INVALID", { name: "A name is required." }],
] as const) {
  test(`registered query preserves declared ${code} and safe details across worker entry`, () => {
    // Each process models the one-shot worker registration lifetime without
    // mutating the registrations used by other tests in this test process.
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { schema, defineQuery } from "./src/schema.ts";
      import { handleQuery, publicError, inputError } from "./src/server.ts";
      import { makeRunner } from "./src/runtime/worker-entry.ts";
      const query = defineQuery({ name: "review.declared", input: schema.object({}), output: schema.string() });
      handleQuery(query, async () => { throw ${factory}; });
      const result = await makeRunner({ query })({
        mode: "query", session: "00000000-0000-0000-0000-000000000000", operation: "review.declared", input: {},
      }, request => ({ session: request.session, sequence: request.sequence, value: null }));
      console.log(JSON.stringify(result));
    `], { cwd: new URL("../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ kind: "failure", code, details });
  });
}

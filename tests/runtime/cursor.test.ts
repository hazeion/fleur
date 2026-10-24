import { expect, test } from "bun:test";
import { column, defineTable } from "../../src/database";
import { compileRead } from "../../src/runtime/database/selection";

test("cursors cannot cross registered query or validated input identities", () => {
  const items = defineTable("cursor_items", { columns: { id: column.safeInteger().primaryKey() } });
  const admitted = new Set([items]), key = new Uint8Array(32).fill(7);
  const selection = { from: items, joins: [], fields: { id: items.id } };
  const cursor = compileRead(selection, admitted, key, { operation: "list", input: { locale: "en" } }).encode(() => 1);
  expect(() => compileRead({ ...selection, cursor }, admitted, key, { operation: "list", input: { locale: "en" } })).not.toThrow();
  expect(() => compileRead({ ...selection, cursor }, admitted, key, { operation: "other", input: { locale: "en" } })).toThrow("REQUEST_DENIED");
  expect(() => compileRead({ ...selection, cursor }, admitted, key, { operation: "list", input: { locale: "fr" } })).toThrow("REQUEST_DENIED");
});

test("a root continuation cursor advances without unbinding other query inputs", async () => {
  const { queryIdentity } = await import("../../src/runtime/query-identity");
  const { defineQuery, schema } = await import("../../src/schema");
  const query = defineQuery({ input: schema.object({ cursor: schema.string().optional(), locale: schema.string(), filter: schema.object({ cursor: schema.string() }) }), output: schema.boolean() });
  const items = defineTable("cursor_inputs", { columns: { id: column.safeInteger().primaryKey() } });
  const selection = { from: items, joins: [], fields: { id: items.id } }, admitted = new Set([items]), key = new Uint8Array(32).fill(4);
  const initial = { locale: "en", filter: { cursor: "business-value" } };
  const token = compileRead(selection, admitted, key, queryIdentity("list", query.input, initial)).encode(() => 1);
  expect(() => compileRead({ ...selection, cursor: token }, admitted, key, queryIdentity("list", query.input, { ...initial, cursor: token }))).not.toThrow();
  expect(() => compileRead({ ...selection, cursor: token }, admitted, key, queryIdentity("list", query.input, { ...initial, cursor: token, locale: "fr" }))).toThrow("REQUEST_DENIED");
  expect(() => compileRead({ ...selection, cursor: token }, admitted, key, queryIdentity("list", query.input, { ...initial, cursor: token, filter: { cursor: "different" } }))).toThrow("REQUEST_DENIED");
  expect(() => defineQuery({ input: schema.object({ cursor: schema.safeInteger() }), output: schema.boolean() })).toThrow("Invalid continuation cursor");
});

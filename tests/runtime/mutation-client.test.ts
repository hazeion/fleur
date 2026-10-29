import { expect, test } from "bun:test";
import { defineMutation, schema } from "../../src/schema";
import * as client from "../../src/runtime/mutation-client";
const save = defineMutation({ name: "test.save", input: schema.object({ name: schema.string() }), output: schema.boolean() });
test("mutation transport distinguishes not-sent, known failure and uncertain submitted work without retry", async () => {
  let calls = 0;
  const lost = async () => { calls++; throw new Error("private transport detail"); };
  expect(await client.runMutation(save, { name: 1 } as never, { send: lost, online: () => true })).toEqual({ status: "failure", delivery: "not-sent", error: { code: "INPUT_INVALID" } });
  expect(await client.runMutation(save, { name: "Sage" }, { send: lost, online: () => false })).toEqual({ status: "failure", delivery: "not-sent", error: { code: "NOT_SENT" } });
  expect(calls).toBe(0);
  expect(await client.runMutation(save, { name: "Sage" }, { send: lost, online: () => true })).toEqual({ status: "outcome-unknown" });
  expect(calls).toBe(1);
  const send = async () => Response.json({ status: "success", data: true });
  expect(await client.runMutation(save, { name: "Sage" }, { send, online: () => true })).toEqual({ status: "success", data: true });
  expect(await client.runMutation(save, { name: "Sage" }, { send: async () => Response.json({ status: "success", data: "wrong" }), online: () => true })).toEqual({ status: "outcome-unknown" });
});

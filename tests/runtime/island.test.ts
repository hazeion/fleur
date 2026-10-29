import { expect, test } from "bun:test";
import { h } from "preact";
import render from "preact-render-to-string";
import { defineIsland } from "../../src/client";
import { schema } from "../../src/schema";

test("islands validate props before rendering or executing their component", () => {
  let calls = 0;
  const Name = defineIsland({ props: schema.object({ name: schema.string() }), component: ({ name }) => { calls++; return h("span", null, name); } });
  expect(render(h(Name, { name: "Sage" }))).toContain("Sage");
  expect(calls).toBe(1);
  expect(() => render(h(Name, { name: "Sage", secret: "private" } as never))).toThrow();
  expect(calls).toBe(1);
});

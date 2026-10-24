import { afterEach, expect, test } from "bun:test";
import { defineQuery, schema } from "../../src/schema";
import { handleQuery, readQuery, registerPage } from "../../src/server";
import { definePage } from "../../src/routing";
import { h } from "preact";

test("server registration rejects duplicates and read dispatch requires render authority", async () => {
  const query = defineQuery({ name: "exercises.server-test", input: schema.object({}), output: schema.string() });
  handleQuery(query, async () => "Squat");
  expect(() => handleQuery(query, async () => "again")).toThrow();
  await expect(readQuery(query, {})).rejects.toThrow("UNSUPPORTED_CAPABILITY");
  const page = definePage({ path: "/registered-exercises", params: schema.object({}) });
  registerPage(page, { component: () => h("h1", null, "Exercises") });
  expect(() => registerPage(page, { component: () => h("h1", null, "duplicate") })).toThrow();
});

import { pages, queries, pageNames, queryNames } from "../../src/runtime/registrations";
afterEach(() => { pages.clear(); queries.clear(); pageNames.clear(); queryNames.clear(); });

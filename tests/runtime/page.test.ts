import { afterEach, expect, test } from "bun:test";
import { h } from "preact";
import { defineQuery, schema } from "../../src/schema";
import { defineIsland } from "../../src/client";
import { definePage } from "../../src/routing";
import { handleQuery, readQuery, registerPage } from "../../src/server";
import { executePage, executeQuery, nameExports } from "../../src/runtime/worker-execution";
import type { ReadDb } from "../../src/database";

test("a server page renders validated read data and only registered island descriptors", async () => {
  const contract = defineQuery({ name: "page.ingredients", input: schema.object({}), output: schema.array(schema.object({ name: schema.string() })) });
  handleQuery(contract, async () => [{ name: "Sage" }]);
  const page = definePage({ path: "/page-ingredients", params: schema.object({}) });
  const Name = defineIsland({ props: schema.object({ name: schema.string() }), component: ({ name }) => h("span", null, name) });
  registerPage(page, { component: async () => {
    const rows = await readQuery(contract, {});
    return h("main", null, h("h1", null, "Ingredients"), h(Name, { name: rows[0]!.name }));
  } });
  nameExports({ "shared/query#contract": contract, "shared/pages#page": page, "client/Name#default": Name });
  const result = await executePage("/page-ingredients", async () => [{ name: "Sage" }]);
  expect(result.html).toContain("<h1>Ingredients</h1>");
  expect(result.html).toContain("<span>Sage</span>");
  expect(result.islands).toEqual([{ key: "island-0", id: "client/Name#default", props: { name: "Sage" } }]);
  await expect(executePage("/unknown", async () => [])).rejects.toThrow("ROUTE_NOT_FOUND");
});

test("query handlers cannot acquire renderer dispatch authority", async () => {
  const query = defineQuery({ name: "query.denied-render", input: schema.object({}), output: schema.string() });
  handleQuery(query, async () => readQuery(query, {}));
  const unavailable = Object.freeze({}) as ReadDb;
  await expect(executeQuery("query.denied-render", {}, unavailable, { info() {}, warn() {} })).rejects.toThrow("UNSUPPORTED_CAPABILITY");
});

import { pages, queries, pageNames, queryNames } from "../../src/runtime/registrations";
afterEach(() => { pages.clear(); queries.clear(); pageNames.clear(); queryNames.clear(); });

import { expect, test } from "bun:test";
import { h, createContext, Component } from "preact";
import { useContext } from "preact/hooks";
import { schema, defineQuery } from "../../src/schema";
import { definePage } from "../../src/routing";
import { handleQuery, readQuery, registerPage } from "../../src/server";
import { executePage, nameExports } from "../../src/runtime/worker-execution";
import { defineIsland, useQuery } from "../../src/client";

test("server regions isolate a failed query and keep stable keyed identities across reorder", async () => {
  const query = defineQuery({ name: "regions.value", input: schema.object({ id: schema.string() }), output: schema.string() });
  handleQuery(query, async ({ input }) => input.id);
  const page = definePage({ path: "/reactive-regions", params: schema.object({}) });
  let order = ["a", "b"];
  const Region = async ({ id }: { id: string }) => h("p", null, await readQuery(query, { id }));
  registerPage(page, { component: () => h("main", null, order.map(id => h(Region as never, { key: id, id }))) });
  nameExports({ query, page });
  const first = await executePage("/reactive-regions", async (_name, input) => (input as { id: string }).id);
  order = ["b", "a"];
  const next = await executePage("/reactive-regions", async (_name, input) => {
    if ((input as { id: string }).id === "a") throw new Error("QUERY_TIMEOUT");
    return "healthy sibling";
  });
  expect(next.html).toContain("healthy sibling");
  const failed = next.regions.find(region => region.error === "QUERY_TIMEOUT")!;
  expect(failed).toBeDefined();
  expect(first.regions.find(region => region.id === failed.id)?.dependencies).toEqual([{ name: "regions.value", input: { id: "a" } }]);
});

test("exported unnamed queries can be observed by server-rendered islands", async () => {
  const query = defineQuery({ input: schema.object({}), output: schema.string() });
  handleQuery(query, async () => "value");
  const page = definePage({ path: "/unnamed-reactive", params: schema.object({}) });
  const View = defineIsland({ props: schema.object({}), component: () => h("p", null, useQuery(query, {}).status) });
  registerPage(page, { component: () => h(View, {}) });
  nameExports({ "shared/query#unnamed": query, page, View });
  expect((await executePage("/unnamed-reactive", async () => "value")).html).toContain("loading");
});

test("server components retain Preact provider context while rendering regions", async () => {
  const context = createContext("default");
  const page = definePage({ path: "/region-context", params: schema.object({}) });
  function Value() { return h("span", null, useContext(context)); }
  registerPage(page, { component: () => h("main", null, h(context.Provider, { value: "provided" }, h(Value, {}))) });
  nameExports({ page });
  expect((await executePage("/region-context", async () => null)).html).toContain("<span>provided</span>");
});

test("region boundaries preserve table content models and class component rendering", async () => {
  const page = definePage({ path: "/region-table", params: schema.object({}) });
  class Rows extends Component {
    render() { return h("tbody", null, h("tr", null, h("td", null, "Cell"))); }
  }
  registerPage(page, { component: () => h("table", null, h(Rows, {})) });
  nameExports({ page });
  const result = await executePage("/region-table", async () => null);
  expect(result.html).toContain("<tbody><tr><td>Cell</td></tr></tbody>");
  expect(result.html).not.toContain("<div");
  expect(result.regions.every(region => !region.error)).toBe(true);
});

test("a failure before later reads retains the stable boundary of the complete region", async () => {
  const firstQuery = defineQuery({ name: "region.first", input: schema.object({}), output: schema.string() });
  const secondQuery = defineQuery({ name: "region.second", input: schema.object({}), output: schema.string() });
  handleQuery(firstQuery, async () => "first"); handleQuery(secondQuery, async () => "second");
  const page = definePage({ path: "/partial-region", params: schema.object({}) });
  const Region = async () => {
    await readQuery(firstQuery, {});
    return h("p", null, await readQuery(secondQuery, {}));
  };
  registerPage(page, { component: () => h(Region as never, { key: "stable" }) });
  nameExports({ firstQuery, secondQuery, page });
  const complete = await executePage("/partial-region", async () => "stored");
  const failed = await executePage("/partial-region", async () => { throw new Error("QUERY_TIMEOUT"); });
  const boundary = failed.regions.find(region => region.error === "QUERY_TIMEOUT")!;
  expect(complete.regions.find(region => region.dependencies.length === 2)?.id).toBe(boundary.id);
});

test("page dependency discovery reports internal pending work without swallowing declared failures", async () => {
  const query = defineQuery({ name: "page.pending", input: schema.object({}), output: schema.string() });
  handleQuery(query, async () => "stored");
  const page = definePage({ path: "/page-pending", params: schema.object({}) });
  registerPage(page, { component: async () => h("p", null, await readQuery(query, {})) });
  nameExports({ query, page });
  const pending = await executePage("/page-pending", async () => { throw new Error("QUERY_PENDING"); });
  expect(pending.regions).toEqual([{ id: "page", dependencies: [{ name: "page.pending", input: {} }], error: "QUERY_PENDING" }]);
  expect(pending.html).not.toContain("stored");
  await expect(executePage("/page-pending", async () => { throw new Error("NOT_FOUND"); })).rejects.toThrow("NOT_FOUND");
});

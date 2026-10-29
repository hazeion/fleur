import { expect, test } from "bun:test";
import { definePage, href, matchPage } from "../../src/routing";
import { schema } from "../../src/schema";

test("routes validate and encode parameters in both directions", () => {
  const page = definePage({ path: "/ingredients/:name", params: schema.object({ name: schema.string().min(1) }) });
  expect(href(page, { name: "Sage / pepper" })).toBe("/ingredients/Sage%20%2F%20pepper");
  expect(matchPage(page, "/ingredients/Sage%20%2F%20pepper")).toEqual({ name: "Sage / pepper" });
  expect(matchPage(page, "/other")).toBeNull();
  expect(() => href(page, {} as never)).toThrow();
  expect(() => matchPage(page, "/ingredients/%ZZ")).toThrow();
  expect(() => definePage({ path: "/ingredients/:id", params: schema.object({ wrong: schema.string() }) } as never)).toThrow();
});

test("path placeholders require nonoptional string parameters", () => {
  expect(() => definePage({ path: "/ingredients/:id", params: schema.object({ id: schema.string().optional() }) } as never)).toThrow();
  expect(() => definePage({ path: "/ingredients/:id", params: schema.object({ id: schema.safeInteger() }) } as never)).toThrow();
});

import { expect, test } from "bun:test";
import { definePage, href, matchPage } from "../../src/routing";
import { schema } from "../../src/schema";

test("routes validate and encode parameters in both directions", () => {
  const page = definePage({ path: "/exercises/:name", params: schema.object({ name: schema.string().min(1) }) });
  expect(href(page, { name: "Squat / press" })).toBe("/exercises/Squat%20%2F%20press");
  expect(matchPage(page, "/exercises/Squat%20%2F%20press")).toEqual({ name: "Squat / press" });
  expect(matchPage(page, "/other")).toBeNull();
  expect(() => href(page, {} as never)).toThrow();
  expect(() => matchPage(page, "/exercises/%ZZ")).toThrow();
  expect(() => definePage({ path: "/exercises/:id", params: schema.object({ wrong: schema.string() }) } as never)).toThrow();
});

test("path placeholders require nonoptional string parameters", () => {
  expect(() => definePage({ path: "/exercises/:id", params: schema.object({ id: schema.string().optional() }) } as never)).toThrow();
  expect(() => definePage({ path: "/exercises/:id", params: schema.object({ id: schema.safeInteger() }) } as never)).toThrow();
});

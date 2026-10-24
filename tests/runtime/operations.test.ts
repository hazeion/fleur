import { expect, test } from "bun:test";
import { defineQuery, schema } from "../../src/schema";

test("named query contracts retain their input/output schemas and reject malformed names", () => {
  const query = defineQuery({ name: "exercises.list", input: schema.object({}), output: schema.array(schema.string()) });
  expect(query.input.parse({})).toEqual({});
  expect(query.output.parse(["Squat"])).toEqual(["Squat"]);
  expect(Object.isFrozen(query)).toBe(true);
  expect(() => defineQuery({ name: "../secret", input: schema.object({}), output: schema.string() })).toThrow();
});

import { expect, test } from "bun:test";
import { validateProps } from "./props";

test("public island props accept the declared name and revision", () => {
  expect(validateProps({ name: "Saved exercise", revision: 1 })).toEqual({
    name: "Saved exercise", revision: 1,
  });
});

test("public island props reject undeclared nested or unsupported values", () => {
  for (const value of [
    { name: "Saved", revision: 1, secret: "private" },
    { name: { secret: "private" }, revision: 1 },
    { name: "Saved", revision: undefined },
    { name: "Saved", revision: NaN },
    { name: "Saved", revision: Infinity },
    { name: "Saved", revision: 9007199254740992 },
    { name: new Date(), revision: 1 },
    { name: "Saved", revision: 1n },
  ]) expect(() => validateProps(value)).toThrow();
});

import { test, expect } from "bun:test";
import { SQL } from "bun";
import { input, output, router } from "./fixture";

test("internal schemas reject extra fields and preserve nullable decimal strings", async () => {
  expect(input.safeParse({ id: 1, extra: true }).success).toBe(false);
  expect(input.safeParse({ id: "1" }).success).toBe(false);
  expect(output.safeParse({ id: 1, name: "Squat", weight: null }).success).toBe(false);
  const caller = router.createCaller({});
  expect(await caller.exercise({ id: 1 })).toEqual({
    id: 1, name: "Squat", notes: null, weight: "12.50",
  });
});

test("Bun exports its SQL constructor without a database connection", () => {
  expect(typeof SQL).toBe("function");
});

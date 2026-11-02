import { expect, test } from "bun:test";
import { referenceRun, referenceScenario } from "../../scripts/reference-results";
test("nearest-rank p95 uses the 95th of 100 samples rather than interpolation or mean", () => {
  expect(referenceRun(Array.from({ length: 100 }, (_, index) => ({ milliseconds: index + 1 })), 95)).toMatchObject({ samples: 100, p95Milliseconds: 95, failures: 0, passed: true });
});
test("one timeout fails the run even when 99 fast samples leave p95 under budget", () => {
  const result = referenceRun([...Array.from({ length: 99 }, () => ({ milliseconds: 1 })), { milliseconds: null, error: "timeout" }], 500);
  expect(result).toMatchObject({ p95Milliseconds: 1, failures: 1, passed: false });
});
test("enough errors produce an explicit infinite percentile instead of a discarded sample", () => {
  const result = referenceRun([...Array.from({ length: 90 }, () => ({ milliseconds: 1 })), ...Array.from({ length: 10 }, () => ({ milliseconds: null, error: "timeout" }))], 500);
  expect(result).toMatchObject({ p95Milliseconds: null, infinite: true, failures: 10, passed: false });
});
test("three independent runs are mandatory and a failing run cannot be averaged away", () => {
  const fast = Array.from({ length: 100 }, () => ({ milliseconds: 1 }));
  const slow = Array.from({ length: 100 }, () => ({ milliseconds: 501 }));
  expect(referenceScenario([fast, fast, slow], 500).passed).toBe(false);
  expect(() => referenceScenario([fast, fast], 500)).toThrow();
  expect(() => referenceRun(fast.slice(1), 500)).toThrow();
  expect(() => referenceRun([...fast.slice(1), { milliseconds: Number.NaN }], 500)).toThrow();
});

import { expect, test } from "bun:test";
import * as contracts from "../../src/schema";
test("release-pinned Unicode full folding preserves default non-Turkic equivalence", () => {
  expect(typeof contracts.caseFold).toBe("function");
  expect(contracts.caseFold("Straße Σςσ İIı ﬃ 𐐀")).toBe("strasse σσσ i\u0307iı ffi 𐐨");
  expect(contracts.caseFold("SQUAT 💪")).toBe("squat 💪");
  expect(contracts.caseFold("é")).not.toBe(contracts.caseFold("e\u0301"));
});

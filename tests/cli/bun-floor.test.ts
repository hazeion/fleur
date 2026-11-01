import { expect, test } from "bun:test";
import { bunAdmission, bunFloor } from "../../src/project/release.ts";

test("the release declares its Bun floor as >=X.Y.Z", () => {
  expect(bunFloor).toBe(">=1.4.3");
  expect(bunAdmission(Bun.version)).toEqual({ admitted: true });
});

test("admission compares major, minor and patch numerically against the floor", () => {
  for (const version of ["1.4.3", "1.4.4", "1.4.10", "1.5.0", "1.10.0", "2.0.0", "10.0.0"]) expect(bunAdmission(version, ">=1.4.3"), version).toEqual({ admitted: true });
  for (const version of ["1.4.2", "1.3.9", "1.3.10", "0.9.9", "0.4.3"]) expect(bunAdmission(version, ">=1.4.3"), version).toEqual({ admitted: false, reason: "below-floor" });
  expect(bunAdmission("1.10.0", ">=1.9.9")).toEqual({ admitted: true });
  expect(bunAdmission("1.9.9", ">=1.10.0")).toEqual({ admitted: false, reason: "below-floor" });
});

test("an invalid stored floor refuses rather than admitting everything", () => {
  for (const floor of ["1.4.3", ">=abc", "^1.4.3", "~1.4.3", ">=1.4", ">= 1.4.3", ">=1.4.3 <2.0.0", ">=v1.4.3", ">=1.4.3-canary.1", "", "not a range", "*"]) {
    expect(bunAdmission("1.4.3", floor), floor).toEqual({ admitted: false, reason: "invalid-floor" });
    expect(bunAdmission("99.0.0", floor), floor).toEqual({ admitted: false, reason: "invalid-floor" });
  }
});

test("a Bun version outside the plain X.Y.Z form refuses as unparseable", () => {
  for (const version of ["1.4.3-debug", "1.4.4-canary.1", "v1.4.4", "1.4", "1.4.4.1", "abc", ""]) expect(bunAdmission(version, ">=1.4.3"), version).toEqual({ admitted: false, reason: "unparseable-version" });
});

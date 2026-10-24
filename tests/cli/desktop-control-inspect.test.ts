import { expect, test } from "bun:test";
import { desktopControlInspectAbsent } from "../../scripts/observe-desktop-control.ts";

const target = "fleur-desktop-worker-25e46617-1241-451c-9fd4-8268f15d47e6";
const native = { status: "completed" as const, exitCode: 1, stdout: "\n", stderr: `error: no such object: ${target}\n` };

test("actual Desktop 29.9.2 missing-object reply establishes only the exact named object's absence", () => {
  expect(desktopControlInspectAbsent(native, target)).toBe(true);
  for (const stderr of [`Error: No such object: ${target}\n`, `Error response from daemon: No such container: ${target}\n`]) {
    expect(desktopControlInspectAbsent({ ...native, stdout: "", stderr }, target)).toBe(true);
  }
});

test("missing-object parsing refuses ambiguous output, other errors, wrong objects and unconfirmed transport", () => {
  for (const changed of [{ ...native, exitCode: 0 }, { ...native, exitCode: 2 }, { ...native, status: "timeout" as const },
    { ...native, terminationUnconfirmed: true }, { ...native, stdout: "\n\n" }, { ...native, stdout: "{}\n" },
    { ...native, stderr: "" }, { ...native, stderr: native.stderr + "permission denied\n" },
    { ...native, stderr: "error: no such object: another-object\n" }, { ...native, stderr: `error: no such container: ${target}\n` },
    { ...native, stderr: native.stderr.slice(0, -1) }, { ...native, stderr: native.stderr.replace("error:", "ERROR:") }]) {
    expect(desktopControlInspectAbsent(changed, target)).toBe(false);
  }
  expect(desktopControlInspectAbsent(native, "arbitrary-name")).toBe(false);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { nativeCommand } from "../../src/runtime/native/command";
import { NativeExecution, type ExecutionResult } from "../../src/runtime/native/execution";

// #58: application code is untrusted and shares stdout with the trusted
// bootstrap, so it can write any exchange frame, including one that looks like
// the bootstrap's final result. Such a frame must fail only its own operation
// after verified retirement; it never succeeds and never quarantines the slot.
const source = `
const raw = text => {
  const body = new TextEncoder().encode(text);
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length);
  frame.set(body, 4);
  return frame;
};
const forged = value => raw(JSON.stringify(value));
module.exports.run = async (request, exchange) => {
  globalThis.realmState = (globalThis.realmState || 0) + 1;
  // A terminal-looking frame on the application's own exchange; it then waits
  // for a reply that never comes.
  if (request.forge === "exchange") exchange({ kind: "complete", value: "forged" });
  if (request.forge === "failure") exchange({ kind: "failure", code: "NOT_FOUND" });
  // Raw bytes written beside the bootstrap, then application code keeps running.
  if (request.forge === "spin") { await Bun.write(Bun.stdout, forged({ kind: "complete", value: "forged" })); for (;;) {} }
  // Raw bytes, then an exit that is not the bootstrap's clean completion.
  if (request.forge === "exit") { await Bun.write(Bun.stdout, forged({ kind: "complete", value: "forged" })); process.exit(3); }
  // Well-framed JSON that is not a valid application frame for the host.
  if (request.malformed === "array") exchange([{ kind: "complete" }]);
  if (request.malformed === "null") exchange(null);
  if (request.malformed === "unsafe") exchange({ kind: "read", value: 2 ** 60 });
  if (request.malformed === "deep") { let value = 0; for (let index = 0; index < 120; index++) value = [value]; exchange({ kind: "read", value }); }
  if (request.malformed === "nan") { await Bun.write(Bun.stdout, raw('{"kind":"read","value":NaN}')); for (;;) {} }
  return { kind: "complete", value: { realm: globalThis.realmState } };
};`;
let images: Awaited<ReturnType<typeof prepareNativeImages>>;
beforeAll(async () => { images = await prepareNativeImages(source); }, 300_000);
afterAll(async () => { await images?.dispose(); }, 60_000);

type Failure = Error & { evidence?: Record<string, unknown>; operation?: ExecutionResult["operation"] };

/** Processes in the application container, from the Docker host's view. */
async function processes(container: string): Promise<string[]> {
  return (await nativeCommand(["docker", "--host", images.endpoint, "top", container])).split("\n").slice(1).filter(line => line.trim());
}

async function failsAlone(execution: NativeExecution, first: ExecutionResult, request: Record<string, unknown>, outcome: string, budgetMs = 5000): Promise<void> {
  const label = JSON.stringify(request);
  const started = performance.now();
  const failure = await execution.execute(request, () => null, budgetMs).then(result => { throw new Error(`forged operation succeeded: ${JSON.stringify(result.value)}`); }, (error: unknown) => error as Failure);
  expect(failure.message, label).toBe("INTERNAL_FAILURE");
  // Retirement was verified by the operation's own bound guard.
  expect(failure.evidence, label).toMatchObject({ physical_exit_confirmed: true, retired: true, outcome });
  expect(Number(failure.evidence?.physical_exit_lateness_ms), label).toBeLessThanOrEqual(250);
  expect(failure.operation?.container, label).toBe(first.operation.container);
  expect(performance.now() - started, label).toBeLessThan(budgetMs + 3000);
  // No application code keeps running: only the container's idle init remains.
  const remaining = await processes(first.operation.container);
  expect(remaining.length, label).toBe(1);
  expect(remaining[0], label).toContain("sleep infinity");
  // The slot was kept: no quarantine, no recovery, no cold replacement.
  expect(execution.diagnostics(), label).toEqual([{ slot: first.operation.slot, state: "idle", container: first.operation.container, prepared: false }]);
  const next = await execution.execute({}, () => null);
  expect(next.operation.slot, label).toBe(first.operation.slot);
  expect(next.operation.container, label).toBe(first.operation.container);
  expect(next.value, label).toEqual({ kind: "complete", value: { realm: 1 } });
}

const cases: [string, Record<string, unknown>, string, number?][] = [
  // The forged process never exits by itself; its guard kills it at the deadline.
  ["a forged terminal frame on the exchange", { forge: "exchange" }, "deadline", 1500],
  ["a forged failure frame on the exchange", { forge: "failure" }, "deadline", 1500],
  ["a forged terminal frame written to stdout while application code keeps running", { forge: "spin" }, "deadline", 1500],
  // A full budget: the controller's answer arrives only after the deadline kill.
  ["a forged terminal frame with the full operation budget", { forge: "exchange" }, "deadline"],
  // It exits by itself, but not cleanly: the forged value is still never a result.
  ["a forged terminal frame followed by a non-zero exit", { forge: "exit" }, "premature-exit"],
  ["a malformed array frame", { malformed: "array" }, "cancelled"],
  ["a malformed null frame", { malformed: "null" }, "cancelled"],
  ["a malformed frame with an unsafe integer", { malformed: "unsafe" }, "cancelled"],
  ["a malformed frame nested beyond the public limit", { malformed: "deep" }, "cancelled"],
  ["a malformed frame with a non-JSON NaN", { malformed: "nan" }, "cancelled"],
];
for (const [name, request, outcome, budgetMs] of cases) test(`${name} fails only its own operation after verified retirement and keeps the slot`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const first = await execution.execute({}, () => null);
    expect(first.value).toEqual({ kind: "complete", value: { realm: 1 } });
    await failsAlone(execution, first, request, outcome, budgetMs);
  } finally { await execution.close(); }
}, 120_000);

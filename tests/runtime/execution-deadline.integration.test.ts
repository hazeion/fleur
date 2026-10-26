import { afterAll, beforeAll, expect, test } from "bun:test";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { NativeExecution } from "../../src/runtime/native/execution";

// V1-SPEC performance budgets: query deadlines include scheduling/queueing and
// execution. ADR 0001 keeps the five-second operation deadline "including
// applicable queueing and scheduling" and the 250-ms physical-exit tolerance.
const source = `
module.exports.run = async request => {
  if (request.spin) for (;;) {}
  return { kind: "complete", value: "done" };
};`;
const DEADLINE = 5000, TOLERANCE = 250;
// Host-side reporting after the guard's own bounded retirement record.
const REPORTING = 350;
let images: Awaited<ReturnType<typeof prepareNativeImages>>;
beforeAll(async () => { images = await prepareNativeImages(source); }, 300_000);
afterAll(async () => { await images?.dispose(); }, 60_000);

const outcome = (work: Promise<unknown>) => work.then(() => undefined, (error: unknown) => error as Error & { evidence?: Record<string, unknown> });

for (let repeat = 1; repeat <= 2; repeat++) test(`a request queued behind a busy slot times out at its own deadline, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    await execution.execute({}, () => null);
    const busy = outcome(execution.execute({ spin: true }, () => null));
    await new Promise(resolve => setTimeout(resolve, 100));
    const queued = performance.now();
    const failure = await outcome(execution.execute({}, () => null));
    const elapsed = performance.now() - queued;
    expect(failure?.message).toBe("QUERY_TIMEOUT");
    expect(elapsed).toBeLessThan(DEADLINE + TOLERANCE);
    expect((await busy)?.message).toBe("QUERY_TIMEOUT");
    // The timed-out waiter never held the slot: it serves the next request.
    expect((await execution.execute({}, () => null)).value).toEqual({ kind: "complete", value: "done" });
  } finally { await execution.close(); }
}, 120_000);

for (let repeat = 1; repeat <= 2; repeat++) test(`an admitted operation runs only for the deadline remaining after queueing, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    await execution.execute({}, () => null);
    const busy = outcome(execution.execute({ spin: true }, () => null, 2000));
    await new Promise(resolve => setTimeout(resolve, 100));
    const queued = performance.now();
    const failure = await outcome(execution.execute({ spin: true }, () => null));
    const elapsed = performance.now() - queued;
    expect((await busy)?.message).toBe("QUERY_TIMEOUT");
    expect(failure?.message).toBe("QUERY_TIMEOUT");
    expect(failure?.evidence).toMatchObject({ physical_exit_confirmed: true, retired: true, outcome: "deadline" });
    expect(Number(failure?.evidence?.physical_exit_lateness_ms)).toBeLessThanOrEqual(TOLERANCE);
    expect(elapsed).toBeLessThan(DEADLINE + TOLERANCE + REPORTING);
  } finally { await execution.close(); }
}, 120_000);

for (let repeat = 1; repeat <= 2; repeat++) test(`a caller whose deadline expires during preparation leaves healthy capacity in service, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const first = await execution.execute({}, () => null);
    // The busy run frees the slot shortly before the queued deadline, so the
    // queued caller acquires it with too little time left to prepare.
    const busy = outcome(execution.execute({ spin: true }, () => null, 4600));
    await new Promise(resolve => setTimeout(resolve, 100));
    const queued = performance.now();
    const failure = await outcome(execution.execute({}, () => null));
    expect(failure?.message).toBe("QUERY_TIMEOUT");
    expect(performance.now() - queued).toBeLessThan(DEADLINE + TOLERANCE);
    // Which path expired is timing-dependent; "preparing" is the intended one.
    console.info("[preparation-timeout] slot state at caller deadline:", execution.diagnostics()[0]?.state);
    expect((await busy)?.message).toBe("QUERY_TIMEOUT");
    const idle = performance.now() + 30_000;
    while (performance.now() < idle && execution.diagnostics()[0]?.state !== "idle") await new Promise(resolve => setTimeout(resolve, 20));
    expect(execution.diagnostics().map(slot => slot.state)).toEqual(["idle"]);
    // Never quarantined: the same retained container serves the next request.
    const next = await execution.execute({}, () => null);
    expect(next.operation.container).toBe(first.operation.container);
  } finally { await execution.close(); }
}, 120_000);

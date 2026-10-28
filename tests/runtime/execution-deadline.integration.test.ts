import { afterAll, beforeAll, expect, test } from "bun:test";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { nativeCommand } from "../../src/runtime/native/command";
import { NativeExecution } from "../../src/runtime/native/execution";

// V1-SPEC performance budgets: query deadlines include scheduling/queueing and
// execution. ADR 0001 keeps the five-second operation deadline "including
// applicable queueing and scheduling" and the 250-ms physical-exit tolerance.
const source = `
module.exports.run = async (request, exchange) => {
  if (request.spin) for (;;) {}
  // Application code reports entry through the trusted host only after admission.
  if (request.announce) await exchange({ entered: true });
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

// #67: a run whose effective budget, min(explicit budget, remaining deadline),
// is shorter than the host's guard arming margin is the caller's timeout. No
// guard starts, no application code runs, and the slot keeps its prepared
// process for the next request.
const ARMING_MARGIN = 500;
for (let repeat = 1; repeat <= 2; repeat++) test(`an explicit budget shorter than guard arming times out before any guard starts and keeps the slot, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const first = await execution.execute({}, () => null);
    for (const budget of [1, 250, ARMING_MARGIN - 1]) {
      let entered = false;
      const failure = await outcome(execution.execute({ announce: true }, () => { entered = true; return null; }, budget));
      expect(failure?.message).toBe("QUERY_TIMEOUT");
      // No guard ran, so there is no retirement evidence to report.
      expect(failure?.evidence).toBeUndefined();
      expect(entered).toBe(false);
      expect(execution.diagnostics()).toEqual([expect.objectContaining({ state: "idle", container: first.operation.container, prepared: true })]);
    }
    const next = await execution.execute({ announce: true }, () => null);
    expect(next.operation.container).toBe(first.operation.container);
    expect(next.value).toEqual({ kind: "complete", value: "done" });
  } finally { await execution.close(); }
}, 120_000);

// ADR 0001: a guard that cannot arm and retire within the deadline plus the
// 250-ms tolerance is uncertainty. On a slow host the slot may therefore be
// quarantined and replaced; it must never let application code run late.
for (let repeat = 1; repeat <= 2; repeat++) test(`a slow guard host whose arming outlives the remaining deadline never runs application code late, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  const docker = (...args: string[]) => nativeCommand(["docker", "--host", images.endpoint, ...args], 15_000);
  try {
    const first = await execution.execute({}, () => null);
    const guard = `fleur-exec-${first.operation.slot}-guard`;
    // Just over the host's arming margin remains, as on a slow host.
    const reservation = await execution.reserve(performance.now() + 5000);
    let failure: (Error & { evidence?: Record<string, unknown> }) | undefined;
    let entered: number | undefined;
    try {
      // Throttle only the trusted guard host so arming takes longer than that,
      // and let the host recover once the deadline has passed.
      await docker("update", "--cpus", "0.05", guard);
      let restored: Promise<string> | undefined;
      try {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, reservation.deadline - performance.now() - ARMING_MARGIN - 100)));
        const timer = setTimeout(() => { restored = docker("update", "--cpus", "1", guard); }, Math.max(0, reservation.deadline - performance.now() + 50));
        await reservation.run({ announce: true }, () => { entered = performance.now(); return null; }).then(() => undefined, (error: unknown) => { failure = error as typeof failure; });
        clearTimeout(timer);
      } finally { await (restored ?? docker("update", "--cpus", "1", guard)); }
    } finally { reservation.release(); }
    // Application code never runs after the deadline.
    if (entered !== undefined) expect(entered).toBeLessThanOrEqual(reservation.deadline);
    expect(failure?.message).toBeOneOf(["QUERY_TIMEOUT", "INTERNAL_FAILURE"]);
    if (failure?.message === "QUERY_TIMEOUT") {
      // A verified retirement inside the tolerance keeps the slot in service.
      expect(failure.evidence).toMatchObject({ physical_exit_confirmed: true, retired: true });
      console.info("[slow-guard] QUERY_TIMEOUT, slot kept:", failure.evidence?.outcome, "kill lateness", failure.evidence?.kill_lateness_ms);
      expect(execution.diagnostics().map(slot => [slot.state, slot.container])).toEqual([["idle", first.operation.container]]);
      expect((await execution.execute({}, () => null)).operation.container).toBe(first.operation.container);
    } else {
      // Otherwise the slot is quarantined, removed and replaced.
      console.info("[slow-guard] quarantined and replaced");
      expect(await docker("ps", "--all", "--quiet", "--filter", `label=dev.fleur.execution-owner=${first.operation.slot}`).then(async ids => {
        const end = performance.now() + 15_000;
        while (ids && performance.now() < end) { await new Promise(resolve => setTimeout(resolve, 100)); ids = await docker("ps", "--all", "--quiet", "--filter", `label=dev.fleur.execution-owner=${first.operation.slot}`); }
        return ids;
      })).toBe("");
      const replaced = performance.now() + 30_000;
      while (performance.now() < replaced && !execution.diagnostics().some(slot => slot.state === "idle")) await new Promise(resolve => setTimeout(resolve, 50));
      const next = await execution.execute({}, () => null);
      expect(next.operation.container).not.toBe(first.operation.container);
      expect(next.value).toEqual({ kind: "complete", value: "done" });
    }
  } finally { await execution.close(); }
}, 120_000);

// #75: the host gives a run its budget against its own deadline. Transit to
// the controller (here a stalled `docker run --interactive` client relaying the
// run frame) must be charged to that budget, never added after the host's
// deadline on top of the 250-ms tolerance.
const TRANSIT_STALL = 1500;
const attachClient = (slot: string): number => {
  const found = Bun.spawnSync(["pgrep", "-f", `run --interactive --name fleur-exec-controller-${slot} `]).stdout.toString().trim().split("\n").filter(Boolean).map(Number);
  expect(found).toHaveLength(1);
  return found[0]!;
};
const resume = (client: number) => { try { process.kill(client, "SIGCONT"); } catch { /* The client already exited; the run reports that itself. */ } };
/** Run while the slot's attach client stops relaying frames for `stallMs`. */
async function stalled(execution: NativeExecution, client: number, stallMs: (deadline: number) => number, command: unknown, exchange: () => null = () => null) {
  const reservation = await execution.reserve(performance.now() + DEADLINE);
  process.kill(client, "SIGSTOP");
  const timer = setTimeout(() => resume(client), stallMs(reservation.deadline));
  try {
    const failure = await outcome(reservation.run(command, exchange));
    return { failure, late: performance.now() - reservation.deadline };
  } finally { clearTimeout(timer); resume(client); reservation.release(); }
}
for (let repeat = 1; repeat <= 2; repeat++) test(`a busy operation whose run frame is delayed in transit is still killed by the host's deadline, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const first = await execution.execute({}, () => null);
    const { failure, late } = await stalled(execution, attachClient(first.operation.slot), () => TRANSIT_STALL, { spin: true });
    // The reply follows the kill, so it bounds the kill time on the host's clock.
    console.info(`[transit] failure reply ${Math.round(late)} ms after the host deadline; guard kill lateness ${failure?.evidence?.kill_lateness_ms} ms, exit lateness ${failure?.evidence?.physical_exit_lateness_ms} ms after its own deadline`);
    expect(failure?.message).toBe("QUERY_TIMEOUT");
    expect(failure?.evidence).toMatchObject({ physical_exit_confirmed: true, retired: true, outcome: "deadline" });
    expect(Number(failure?.evidence?.physical_exit_lateness_ms)).toBeLessThanOrEqual(TOLERANCE);
    expect(late).toBeLessThan(TOLERANCE + REPORTING);
    // A timeout is not uncertainty: the same retained container serves the next request.
    expect((await execution.execute({}, () => null)).operation.container).toBe(first.operation.container);
  } finally { await execution.close(); }
}, 120_000);

// Transit that leaves less than the arming margin is the caller's timeout, as
// a short budget is before the run frame (#67): no guard starts, no
// application code runs, and the slot keeps its prepared process.
for (let repeat = 1; repeat <= 2; repeat++) test(`a run frame delayed until too little of the deadline remains to arm keeps the slot prepared, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const first = await execution.execute({}, () => null);
    let entered = false;
    const announced = () => { entered = true; return null; };
    // The run frame reaches the controller about 200 ms before the host's deadline.
    const { failure } = await stalled(execution, attachClient(first.operation.slot), deadline => Math.max(0, deadline - performance.now() - 200), { announce: true }, announced);
    expect(failure?.message).toBe("QUERY_TIMEOUT");
    // No guard ran, so there is no retirement evidence to report.
    expect(failure?.evidence).toBeUndefined();
    expect(entered).toBe(false);
    expect(execution.diagnostics()).toEqual([expect.objectContaining({ state: "idle", container: first.operation.container, prepared: true })]);
    const next = await execution.execute({ announce: true }, announced);
    expect(entered).toBe(true);
    expect(next.operation.container).toBe(first.operation.container);
  } finally { await execution.close(); }
}, 120_000);

import { afterAll, beforeAll, expect, test } from "bun:test";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { NativeExecution } from "../../src/runtime/native/execution";

// Reviewer regression (Docker required). ReadApplication releases its
// reservation in `finally` after the broker's own 5-second race settles, which
// can happen while the native operation is still running. A slot that is then
// quarantined must still be retired and replaced, and an idle slot must wake
// waiters; otherwise capacity is lost until close().
const source = `module.exports.run = async (request, exchange) => {
  if (request.ask) return { kind: "complete", value: await exchange({ ask: true }) };
  return { kind: "complete", value: { ok: true } };
};`;
let images: Awaited<ReturnType<typeof prepareNativeImages>>;
beforeAll(async () => { images = await prepareNativeImages(source); }, 300_000);
afterAll(async () => { await images?.dispose(); }, 60_000);

test("a reservation released while its operation runs still retires a quarantined slot and restores capacity", async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const reservation = await execution.reserve();
    let answer!: (value: unknown) => void;
    const asked = new Promise<void>(resolve => {
      void reservation.run({ ask: true }, () => { resolve(); return new Promise(done => { answer = done; }); }).catch(() => {});
    });
    await asked;
    // The caller gave up (for example the broker deadline settled first).
    reservation.release();
    // A reply the host cannot frame quarantines the slot after release.
    answer(10n);
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline && execution.diagnostics().some(slot => slot.state === "quarantined")) await new Promise(resolve => setTimeout(resolve, 50));
    expect(execution.diagnostics().filter(slot => slot.state === "quarantined")).toEqual([]);
    // Verified removal is followed by background replacement, which restores
    // capacity without any request having to wait for cold slot creation.
    const replaced = performance.now() + 30_000;
    while (performance.now() < replaced && !execution.diagnostics().some(slot => slot.state === "idle")) await new Promise(resolve => setTimeout(resolve, 50));
    expect(execution.diagnostics().some(slot => slot.state === "idle")).toBe(true);
    const started = performance.now();
    expect((await execution.execute({}, () => null)).value).toEqual({ kind: "complete", value: { ok: true } });
    expect(performance.now() - started).toBeLessThan(10_000);
  } finally { await execution.close().catch(() => {}); }
}, 120_000);

test("a reservation released while its operation runs wakes a queued caller when the slot becomes idle", async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const reservation = await execution.reserve();
    let answer!: (value: unknown) => void;
    const asked = new Promise<void>(resolve => {
      void reservation.run({ ask: true }, () => { resolve(); return new Promise(done => { answer = done; }); }).catch(() => {});
    });
    await asked;
    reservation.release();
    const queued = performance.now();
    const next = execution.execute({}, () => null);
    await new Promise(resolve => setTimeout(resolve, 200));
    answer(null);
    expect((await next).value).toEqual({ kind: "complete", value: { ok: true } });
    // Retirement plus a fresh preparation takes about a second; a missed
    // wake-up would leave the caller asleep until its 30-second queue bound.
    expect(performance.now() - queued).toBeLessThan(10_000);
  } finally { await execution.close().catch(() => {}); }
}, 120_000);

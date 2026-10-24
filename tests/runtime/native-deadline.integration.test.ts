import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { startWorker } from "../../src/runtime/native/host";
import { nativeCommand } from "../../src/runtime/native/command";
let images: Awaited<ReturnType<typeof prepareNativeImages>>;
beforeAll(async () => {
  images = await prepareNativeImages(`module.exports.run = async (request) => { if (request.spin) for (;;) {} return {kind:'complete', value:'healthy'}; };`);
}, 300_000);
afterAll(async () => { await images?.dispose(); });
for (let repeat = 1; repeat <= 2; repeat++) test(`native deadline physically retires a busy worker without affecting its neighbor, repeat ${repeat}`, async () => {
  const busy = await startWorker(images), healthy = await startWorker(images);
  try {
    const outcome = busy.run({ spin: true }, () => null).catch(error => error);
    expect(await healthy.run({}, () => null)).toEqual({ kind: "complete", value: "healthy" });
    expect(await outcome).toBeInstanceOf(Error);
    expect(busy.evidence).toMatchObject({ physical_exit_confirmed: true, outcome: "deadline" });
    expect(Number(busy.evidence?.physical_exit_lateness_ms)).toBeLessThanOrEqual(250);
  } finally { await Promise.all([busy.close(), healthy.close()]); }
}, 30_000);

test("a bound independent guard survives controller loss and persisted cleanup removes its owned resources", async () => {
  const worker = await startWorker(images);
  try {
    const outcome = worker.run({ spin: true }, () => null).catch(error => error);
    let journal: { owner: string; guard: unknown } | undefined;
    const deadline = performance.now()+4000;
    while (performance.now() < deadline) {
      journal = JSON.parse(await readFile(join(worker.recoveryDirectory, "lease.json"), "utf8"));
      if (journal?.guard) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(journal?.guard).toBeTruthy();
    const name = `fleur-read-controller-${journal!.owner}`;
    await nativeCommand(["docker", "--host", images.endpoint, "kill", name]);
    expect(await outcome).toBeInstanceOf(Error);
  } finally { await worker.close(); }
}, 30_000);

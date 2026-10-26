import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceLease } from "../../src/runtime/database/maintenance";
import { ownedPostgres } from "./owned-postgres";

// Spec: maintenance stops new application database operations and drains
// in-flight ones before it begins. Competing maintenance still returns contention.
for (let repeat = 1; repeat <= 2; repeat++) test(`exclusive maintenance drains in-flight admission and refuses new admission while waiting, repeat ${repeat}`, async () => {
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), "fleur-maintenance-drain-"));
  const config = { stateRoot: root };
  const held: MaintenanceLease[] = [];
  try {
    held.push(await MaintenanceLease.acquire(fixture.url, false, config));
    const started = performance.now();
    const maintenance = MaintenanceLease.acquire(fixture.url, true, config);
    await new Promise(resolve => setTimeout(resolve, 300));
    await expect(MaintenanceLease.acquire(fixture.url, false, config)).rejects.toThrow("MAINTENANCE_BUSY");
    await held.shift()!.close();
    const owner = await maintenance;
    held.push(owner);
    expect(performance.now() - started).toBeLessThan(5000);
    await expect(MaintenanceLease.acquire(fixture.url, false, config)).rejects.toThrow("MAINTENANCE_BUSY");
    await held.pop()!.close();
    held.push(await MaintenanceLease.acquire(fixture.url, false, config));
  } finally { for (const lease of held) await lease.close(); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

test("an undrained admission or competing owner returns contention within the bounded wait and resumes admission", async () => {
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), "fleur-maintenance-undrained-"));
  const config = { stateRoot: root };
  const held: MaintenanceLease[] = [];
  try {
    held.push(await MaintenanceLease.acquire(fixture.url, false, config));
    let started = performance.now();
    await expect(MaintenanceLease.acquire(fixture.url, true, config)).rejects.toThrow("MAINTENANCE_BUSY");
    expect(performance.now() - started).toBeLessThan(5500);
    // The abandoned wait no longer blocks application admission.
    held.push(await MaintenanceLease.acquire(fixture.url, false, config));
    for (const lease of held.splice(0)) await lease.close();
    held.push(await MaintenanceLease.acquire(fixture.url, true, config));
    started = performance.now();
    await expect(MaintenanceLease.acquire(fixture.url, true, config)).rejects.toThrow("MAINTENANCE_BUSY");
    // Competing maintenance is refused without draining or queueing behind it.
    expect(performance.now() - started).toBeLessThan(1500);
  } finally { for (const lease of held) await lease.close(); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

test("competing maintenance queued while a drain waits is refused rather than run afterwards", async () => {
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), "fleur-maintenance-queued-"));
  const config = { stateRoot: root };
  const held: MaintenanceLease[] = [];
  try {
    held.push(await MaintenanceLease.acquire(fixture.url, false, config));
    const first = MaintenanceLease.acquire(fixture.url, true, config);
    await new Promise(resolve => setTimeout(resolve, 300));
    await expect(MaintenanceLease.acquire(fixture.url, true, config)).rejects.toThrow("MAINTENANCE_BUSY");
    await held.shift()!.close();
    held.push(await first);
  } finally { for (const lease of held) await lease.close(); await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

import { expect, test } from "bun:test";
import { chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RetainedLease, slotBinding } from "../../src/runtime/native/retained-lease";

// Reviewer checks derived from ADR 0001: durable records distinguish retained
// container ownership from each operation's identity and creation intent, and
// a guard binding must match the recorded slot and process exactly. No Docker.
const images = { worker: `sha256:${"a".repeat(64)}`, controller: `sha256:${"b".repeat(64)}`, endpoint: "unix:///var/run/docker.sock" };
const owner = "00000000-0000-4000-8000-0000000000aa";
const slot = { worker: "c".repeat(64), init: 4100, guard: "d".repeat(64), boot: "11111111-1111-4111-8111-111111111111" };
const operation = "00000000-0000-4000-8000-000000000001";
const journal = async (lease: RetainedLease) => JSON.parse(await readFile(join(lease.recoveryDirectory, "lease.json"), "utf8"));
const guard = (overrides: Record<string, unknown> = {}) => ({ operation, worker: slot.worker, init: slot.init, guard: slot.guard, boot: slot.boot,
  pid: 4200, namespacePid: 7, guardExec: "e".repeat(64), start: "123456", deadline: 99.5, ...overrides });

test("the journal records creation intent, slot ownership and each operation stage durably", async () => {
  const lease = await RetainedLease.create(owner, images);
  try {
    expect(await journal(lease)).toMatchObject({ creationPending: "slot", slot: null, operation: null });
    await lease.bindSlot(slot);
    expect(await journal(lease)).toMatchObject({ creationPending: null, slot, operation: null });
    await lease.beginOperation(operation);
    expect((await journal(lease)).operation).toEqual({ id: operation });
    // A second operation cannot begin while one is recorded.
    await expect(lease.beginOperation("00000000-0000-4000-8000-000000000002")).rejects.toThrow("REQUEST_DENIED");
    await lease.bindProcess(operation, { pid: 4200, namespacePid: 7 });
    await lease.bindGuard(operation, guard());
    const recorded = await journal(lease);
    expect(recorded.operation).toMatchObject({ id: operation, process: { pid: 4200, namespacePid: 7 }, guard: { start: "123456", guardExec: "e".repeat(64) } });
    const recovered = await RetainedLease.recover(lease.recoveryDirectory);
    expect(recovered.slot).toEqual(slot);
    await lease.endOperation(operation);
    expect((await journal(lease)).operation).toBeNull();
  } finally { await rm(lease.recoveryDirectory, { recursive: true, force: true }); }
});

test("process and guard bindings cannot target init, another process, another container or another operation", async () => {
  const lease = await RetainedLease.create(owner, images);
  try {
    await lease.bindSlot(slot);
    await lease.beginOperation(operation);
    await expect(lease.bindProcess(operation, { pid: slot.init, namespacePid: 7 })).rejects.toThrow("PROCESS_IDENTITY_UNCONFIRMED");
    await expect(lease.bindProcess(operation, { pid: 1, namespacePid: 7 })).rejects.toThrow("PROCESS_IDENTITY_UNCONFIRMED");
    await expect(lease.bindProcess("00000000-0000-4000-8000-000000000009", { pid: 4200, namespacePid: 7 })).rejects.toThrow("PROCESS_IDENTITY_UNCONFIRMED");
    await expect(lease.bindGuard(operation, guard())).rejects.toThrow("GUARD_IDENTITY_UNCONFIRMED");
    await lease.bindProcess(operation, { pid: 4200, namespacePid: 7 });
    await expect(lease.bindProcess(operation, { pid: 4300, namespacePid: 8 })).rejects.toThrow("PROCESS_IDENTITY_UNCONFIRMED");
    for (const changed of [{ pid: 4300 }, { namespacePid: 8 }, { worker: "f".repeat(64) }, { guard: "f".repeat(64) }, { init: 4101 }, { boot: "22222222-2222-4222-8222-222222222222" },
      { operation: "00000000-0000-4000-8000-000000000009" }, { start: "12x" }, { guardExec: "short" }, { deadline: Number.NaN }, { extra: true }]) {
      await expect(lease.bindGuard(operation, guard(changed))).rejects.toThrow("GUARD_IDENTITY_UNCONFIRMED");
    }
    await lease.bindGuard(operation, guard());
    // An armed guard binding is immutable: no second binding may retarget it.
    await expect(lease.bindGuard(operation, guard({ deadline: 200 }))).rejects.toThrow("GUARD_IDENTITY_UNCONFIRMED");
    expect((await journal(lease)).operation.guard.deadline).toBe(99.5);
  } finally { await rm(lease.recoveryDirectory, { recursive: true, force: true }); }
});

test("slot identities must be distinct and well-formed", () => {
  expect(() => slotBinding({ ...slot, guard: slot.worker })).toThrow("SLOT_IDENTITY_UNCONFIRMED");
  expect(() => slotBinding({ ...slot, init: 1 })).toThrow("SLOT_IDENTITY_UNCONFIRMED");
  expect(() => slotBinding({ ...slot, extra: 1 })).toThrow("SLOT_IDENTITY_UNCONFIRMED");
});

test("recovery refuses an unprotected journal", async () => {
  const lease = await RetainedLease.create(owner, images);
  try {
    await chmod(join(lease.recoveryDirectory, "lease.json"), 0o644);
    await expect(RetainedLease.recover(lease.recoveryDirectory)).rejects.toThrow("RECOVERY_UNCONFIRMED");
  } finally { await rm(lease.recoveryDirectory, { recursive: true, force: true }); }
});

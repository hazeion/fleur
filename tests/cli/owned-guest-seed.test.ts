import { expect, test } from "bun:test";
import { ownedGuestSeed, attestOwnedGuestBoot, copyOwnedGuestBinding } from "../../scripts/owned-guest-seed.ts";

const nonce = "12345678-1234-4234-8234-123456789abc";

test("NoCloud binds its source-owned root producer to the original guest nonce", async () => {
  const seed = await ownedGuestSeed(nonce);
  expect(seed.write_files.find((file) => file.path === "/etc/fleur-owned-guest")).toEqual({ path: "/etc/fleur-owned-guest", owner: "root:root", permissions: "0444", content: nonce });
  const producer = seed.write_files.find((file) => file.path === "/usr/local/lib/fleur-owned-guest.py");
  expect(producer).toMatchObject({ owner: "root:root", permissions: "0444" });
  expect(seed.runcmd).toEqual([["/usr/bin/python3", "-I", "/usr/local/lib/fleur-owned-guest.py", "--create", nonce]]);
});

for (const invalid of ["", "12345678-1234-1234-1234-123456789abc", nonce.toUpperCase(), nonce + "\n"]) {
  test(`NoCloud refuses noncanonical explicit nonce ${JSON.stringify(invalid)}`, async () => {
    await expect(ownedGuestSeed(invalid)).rejects.toThrow("canonical guest nonce");
  });
}

const custodyReply = { ok: true, transport: { exitCode: 0, signal: null, deadlineFired: false, outputLimitExceeded: false }, localCleanup: { retired: true }, stdout: JSON.stringify({ formatVersion: 1, scope: "owned-guest-custody-validation", ok: true, fixtureCustodyValidated: true, nonce, bootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", uid: 1000, manifestSha256: "a".repeat(64), runtimeSupport: "unverified", runtimeAdmission: false, humanConsentProof: false, nativeCpuPerformanceProof: false }) };

test("post-readiness custody consumes only the original boot remainder", async () => {
  let receivedBudget = 0;
  await attestOwnedGuestBoot({ nonce, deadline: 180000, now: () => 179975,
    query: async (_remote, timeout) => { receivedBudget = timeout; return custodyReply; } });
  expect(receivedBudget).toBe(25);
});

test("completed custody cannot extend the original boot deadline", async () => {
  let clock = 179975;
  const operation = attestOwnedGuestBoot({ nonce, deadline: 180000, now: () => clock,
    query: async () => { clock = 180001; return custodyReply; } });
  await expect(operation).rejects.toMatchObject({ code: "BOOT_TIMEOUT" });
});

test("expired boot custody starts no new transport", async () => {
  let started = false;
  await expect(attestOwnedGuestBoot({ nonce, deadline: 180000, now: () => 180000,
    query: async () => { started = true; return custodyReply; } })).rejects.toMatchObject({ code: "BOOT_TIMEOUT" });
  expect(started).toBe(false);
});

test("guest custody receives only the remaining transport allocation", async () => {
  let command = "";
  await attestOwnedGuestBoot({ nonce, deadline: 180000, now: () => 179975,
    query: async (remote) => { command = remote; return custodyReply; } });
  expect(command).toBe(`python3 -I /usr/local/lib/fleur-owned-guest.py --owned-guest-nonce ${nonce} --budget-seconds 0.025`);
});

test("owned session binding copies immutable original identity claims", () => {
  const input = { nonce, bootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", uid: 1000, manifestSha256: "a".repeat(64) };
  const binding = copyOwnedGuestBinding(input, nonce);
  input.uid = 1001;
  expect(binding.uid).toBe(1000);
  expect(Reflect.set(binding, "uid", 0)).toBe(false);
  expect(binding).toEqual({ nonce, bootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", uid: 1000, manifestSha256: "a".repeat(64) });
});

test("owned binding refuses partial, foreign, coerced or profile fields", () => {
  const valid = { nonce, bootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", uid: 1000, manifestSha256: "a".repeat(64) };
  for (const invalid of [null, [], { nonce }, { ...valid, extra: "29.9.1" }, { ...valid, uid: "1000" }, { ...valid, uid: true }, { ...valid, uid: 2 ** 31 }, { ...valid, bootId: [valid.bootId] }, { ...valid, manifestSha256: [valid.manifestSha256] }, { ...valid, nonce: "b".repeat(32) }, { ...valid, nonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]) {
    expect(() => copyOwnedGuestBinding(invalid, nonce)).toThrow("original owned guest binding");
  }
});

test("valid custody JSON cannot replace retired transport proof", async () => {
  await expect(attestOwnedGuestBoot({ nonce, deadline: 180000, now: () => 100,
    query: async () => ({ ...custodyReply, ok: false, transport: { exitCode: 0, signal: null, deadlineFired: false, outputLimitExceeded: false }, localCleanup: { retired: false } }) })).rejects.toMatchObject({ code: "OWNED_GUEST_CUSTODY_UNVERIFIED" });
});

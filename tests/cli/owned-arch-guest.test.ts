import { expect, test } from "bun:test";
import { copyOwnedGuestOsRelease, ownedGuestSeed } from "../../scripts/owned-guest-seed.ts";

const nonce = "12345678-1234-4234-8234-123456789abc";
const arch = { id: "arch", versionId: null, buildId: "rolling", sha256: "a".repeat(64) } as const;

test("fixed Arch seed invokes only its root producer and retains raw OS identity separately from a release label", async () => {
  const seed = await ownedGuestSeed(nonce, "arch-amd64");
  expect(seed.runcmd).toEqual([["/usr/bin/python3", "-I", "/usr/local/lib/fleur-owned-guest.py", "--create-arch", nonce]]);
  const record = copyOwnedGuestOsRelease(arch);
  expect(record).toEqual(arch);
  expect(Reflect.set(record, "versionId", "rolling")).toBe(false);
});

test("Arch root records refuse invented versions, missing build data, extra labels and other distributions", () => {
  for (const invalid of [{ ...arch, versionId: "rolling" }, { id: arch.id, versionId: null, sha256: arch.sha256 },
    { ...arch, buildId: "stable" }, { ...arch, release: "rolling" }, { ...arch, id: "ubuntu" }]) {
    expect(() => copyOwnedGuestOsRelease(invalid)).toThrow("original owned guest OS record");
  }
  for (const existing of [{ id: "ubuntu", versionId: "24.04", sha256: arch.sha256 }, { id: "ubuntu", versionId: "26.04", sha256: arch.sha256 }, { id: "debian", versionId: "13", sha256: arch.sha256 }] as const) {
    expect(copyOwnedGuestOsRelease(existing)).toEqual(existing);
    expect(() => copyOwnedGuestOsRelease({ ...existing, buildId: "rolling" })).toThrow();
  }
});

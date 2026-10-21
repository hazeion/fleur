import { expect, test } from "bun:test";
import { ownedGuestSeed } from "../../scripts/owned-guest-seed.ts";

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

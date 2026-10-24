import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { copyOwnedGuestOsRelease } from "../../scripts/owned-guest-seed.ts";
const seed = resolve(import.meta.dir, "../../scripts/owned-guest-seed.ts");
const nonce = "12345678-1234-4234-8234-123456789abc";

// Component operation data only; this does not boot or admit a native guest.
test("the fixed Debian13 seed invokes only its source-owned target producer", async () => {
  const child = Bun.spawn([process.execPath, "-e", `import {ownedGuestSeed} from ${JSON.stringify(seed)};console.log(JSON.stringify(await ownedGuestSeed(${JSON.stringify(nonce)},'debian13-amd64')));`], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  const observed = JSON.parse(stdout);
  expect(observed.runcmd).toEqual([["/usr/bin/python3", "-I", "/usr/local/lib/fleur-owned-guest.py", "--create-debian13", nonce]]);
  expect(observed.write_files.map((file: { path: string }) => file.path)).toEqual(["/etc/fleur-owned-guest", "/usr/local/lib/fleur-owned-guest.py"]);
});

test("original Debian13 OS evidence is copied immutably without runtime admission", () => {
  const input = { id: "debian", versionId: "13", sha256: "d".repeat(64) };
  const observed = copyOwnedGuestOsRelease(input);
  input.versionId = "24.04";
  expect(observed).toEqual({ id: "debian", versionId: "13", sha256: "d".repeat(64) });
  expect(Reflect.set(observed, "versionId", "26.04")).toBe(false);
});

test.each([
  { id: "ubuntu", versionId: "13" }, { id: "debian", versionId: "24.04" },
  { id: "debian", versionId: "26.04" }, { id: "debian", versionId: "14" },
])("OS evidence rejects crossed or unapproved tuple $id $versionId", (tuple) => {
  expect(() => copyOwnedGuestOsRelease({ ...tuple, sha256: "d".repeat(64) })).toThrow("original owned guest OS record");
});

test("Debian OS evidence cannot supply incomplete, malformed or additional claims", () => {
  const valid = { id: "debian", versionId: "13", sha256: "d".repeat(64) };
  for (const value of [null, [], { ...valid, sha256: "unknown" }, { ...valid, sha256: [valid.sha256] },
    { ...valid, versionId: 13 }, { ...valid, architecture: "arm64" }, { ...valid, nativeQualified: true }]) {
    expect(() => copyOwnedGuestOsRelease(value)).toThrow("original owned guest OS record");
  }
});

test.each(["debian13-arm64", "debian14-amd64", "debian24-amd64", "../caller.json"])("seed refuses unsupported fixture %s without default fallback", async (fixture) => {
  const child = Bun.spawn([process.execPath, "-e", `import {ownedGuestSeed} from ${JSON.stringify(seed)};console.log(JSON.stringify(await ownedGuestSeed(${JSON.stringify(nonce)},${JSON.stringify(fixture)})));`], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("exact source-owned guest fixture");
});

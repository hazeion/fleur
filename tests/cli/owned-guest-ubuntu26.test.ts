import { expect, test } from "bun:test";
import { resolve } from "node:path";
const seed = resolve(import.meta.dir, "../../scripts/owned-guest-seed.ts");
const nonce = "12345678-1234-4234-8234-123456789abc";
// Public component operation data only: this does not create a root manifest or boot a VM.
test("the fixed Ubuntu26 seed invokes only its source-owned target producer", async () => {
  const child = Bun.spawn([process.execPath, "-e", `import {ownedGuestSeed} from ${JSON.stringify(seed)};console.log(JSON.stringify(await ownedGuestSeed(${JSON.stringify(nonce)},'ubuntu26-amd64')));`], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  const observed = JSON.parse(stdout);
  expect(observed.runcmd).toEqual([["/usr/bin/python3", "-I", "/usr/local/lib/fleur-owned-guest.py", "--create-ubuntu26", nonce]]);
  expect(observed.write_files.map((file: { path: string }) => file.path)).toEqual(["/etc/fleur-owned-guest", "/usr/local/lib/fleur-owned-guest.py"]);
}, 15000);

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Source-owned NoCloud fragment. Its boot manifest grants no runtime admission. */
export async function ownedGuestSeed(nonce: string): Promise<{ write_files: { path: string; owner: string; permissions: string; content: string }[]; runcmd: string[][] }> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce)) throw new Error("An explicit canonical guest nonce is required");
  const producer = await readFile(resolve(import.meta.dir, "../experiments/compatibility/runtime-probe/owned_guest.py"), "utf8");
  if (Buffer.byteLength(producer) > 32768) throw new Error("Source-owned guest producer exceeds its seed bound");
  return { write_files: [
    { path: "/etc/fleur-owned-guest", owner: "root:root", permissions: "0444", content: nonce },
    { path: "/usr/local/lib/fleur-owned-guest.py", owner: "root:root", permissions: "0444", content: producer },
  ], runcmd: [["/usr/bin/python3", "-I", "/usr/local/lib/fleur-owned-guest.py", "--create", nonce]] };
}

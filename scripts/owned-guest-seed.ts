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

/** Host transport receipt only; this does not admit a runtime profile. */
export async function attestOwnedGuestBoot(options: { nonce: string; deadline: number; now?: () => number; query: (remote: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string }> }): Promise<Record<string, unknown>> {
  const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
  const nonce = options.nonce;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce)) fail("OWNED_GUEST_CUSTODY_UNVERIFIED", "Canonical owned nonce required.");
  const now = options.now ?? (() => performance.now());
  const remaining = options.deadline - now();
  if (!Number.isFinite(remaining) || remaining < 1) fail("BOOT_TIMEOUT", "Owned guest custody exceeded the original boot deadline.");
  const timeout = Math.floor(Math.min(10000, remaining));
  const observed = await options.query(`python3 -I /usr/local/lib/fleur-owned-guest.py --owned-guest-nonce ${nonce} --budget-seconds ${timeout / 1000}`, timeout);
  const completed = now();
  if (!Number.isFinite(completed) || completed >= options.deadline) fail("BOOT_TIMEOUT", "Owned guest custody exceeded the original boot deadline.");
  const custody = JSON.parse(observed.stdout);
  if (observed.exitCode !== 0 || custody.formatVersion !== 1 || custody.scope !== "owned-guest-custody-validation" || custody.ok !== true || custody.fixtureCustodyValidated !== true || custody.nonce !== nonce || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(custody.bootId) || !Number.isSafeInteger(custody.uid) || custody.uid <= 0 || !/^[a-f0-9]{64}$/.test(custody.manifestSha256) || custody.runtimeSupport !== "unverified" || custody.runtimeAdmission !== false || custody.humanConsentProof !== false || custody.nativeCpuPerformanceProof !== false) fail("OWNED_GUEST_CUSTODY_UNVERIFIED", "Pinned guest transport did not establish its explicit boot manifest binding.");
  return custody;
}

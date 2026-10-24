import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface OwnedGuestBinding { nonce: string; bootId: string; uid: number; manifestSha256: string }

export type OwnedGuestOsRelease = { readonly id: "ubuntu"; readonly versionId: "24.04" | "26.04"; readonly sha256: string }
  | { readonly id: "debian"; readonly versionId: "13"; readonly sha256: string }
  | { readonly id: "arch"; readonly versionId: null; readonly buildId: "rolling"; readonly sha256: string };

/** Original root-attested OS data stays separate from the four-field binding. */
export function copyOwnedGuestOsRelease(value: unknown): Readonly<OwnedGuestOsRelease> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Complete canonical original owned guest OS record required.");
  const { id, versionId, sha256, buildId } = value as Record<string, unknown>;
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Complete canonical original owned guest OS record required.");
  if (id === "arch" && versionId === null && buildId === "rolling" && Object.keys(value).sort().join(",") === "buildId,id,sha256,versionId") return Object.freeze({ id, versionId, sha256, buildId });
  if (Object.keys(value).sort().join(",") !== "id,sha256,versionId") throw new Error("Complete canonical original owned guest OS record required.");
  if (id === "ubuntu" && (versionId === "24.04" || versionId === "26.04")) return Object.freeze({ id, versionId, sha256 });
  if (id === "debian" && versionId === "13") return Object.freeze({ id, versionId, sha256 });
  throw new Error("Complete canonical original owned guest OS record required.");
}

/** A copied data binding is not a runtime-control capability. */
export function copyOwnedGuestBinding(value: unknown, expectedNonce: string): Readonly<OwnedGuestBinding> {
  const invalid = (): never => { throw Object.assign(new Error("Complete canonical original owned guest binding required."), { code: "ARGUMENT_INVALID" }); };
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["bootId", "manifestSha256", "nonce", "uid"])) return invalid();
  const { nonce, bootId, uid, manifestSha256 } = value as Record<string, unknown>;
  if (typeof nonce !== "string" || nonce !== expectedNonce || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce)
      || typeof bootId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(bootId)
      || typeof uid !== "number" || !Number.isSafeInteger(uid) || uid <= 0 || uid >= 2 ** 31
      || typeof manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifestSha256)) return invalid();
  return Object.freeze({ nonce, bootId, uid, manifestSha256 });
}

export type OwnedGuestFixture = "ubuntu24-amd64" | "ubuntu26-amd64" | "debian13-amd64" | "arch-amd64";

/** Source-owned NoCloud fragment. Its boot manifest grants no runtime admission. */
export async function ownedGuestSeed(nonce: string, fixture: OwnedGuestFixture = "ubuntu24-amd64"): Promise<{ write_files: { path: string; owner: string; permissions: string; content: string }[]; runcmd: string[][] }> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce)) throw new Error("An explicit canonical guest nonce is required");
  if (fixture !== "ubuntu24-amd64" && fixture !== "ubuntu26-amd64" && fixture !== "debian13-amd64" && fixture !== "arch-amd64") throw new Error("An exact source-owned guest fixture is required");
  const producer = await readFile(resolve(import.meta.dir, "../experiments/compatibility/runtime-probe/owned_guest.py"), "utf8");
  if (Buffer.byteLength(producer) > 32768) throw new Error("Source-owned guest producer exceeds its seed bound");
  return { write_files: [
    { path: "/etc/fleur-owned-guest", owner: "root:root", permissions: "0444", content: nonce },
    { path: "/usr/local/lib/fleur-owned-guest.py", owner: "root:root", permissions: "0444", content: producer },
  ], runcmd: [["/usr/bin/python3", "-I", "/usr/local/lib/fleur-owned-guest.py", fixture === "ubuntu24-amd64" ? "--create" : fixture === "ubuntu26-amd64" ? "--create-ubuntu26" : fixture === "debian13-amd64" ? "--create-debian13" : "--create-arch", nonce]] };
}

export interface CustodyTransportReply { ok: boolean; stdout: string; transport: { exitCode: number | null; signal: string | null; deadlineFired: boolean; outputLimitExceeded: boolean }; localCleanup: { retired: boolean; error?: string }; error?: unknown }

/** Host transport receipt only; this does not admit a runtime profile. */
export async function attestOwnedGuestBoot(options: { nonce: string; deadline: number; now?: () => number; query: (remote: string, timeoutMs: number) => Promise<CustodyTransportReply> }): Promise<Record<string, unknown>> {
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
  if (observed.ok !== true || observed.transport.exitCode !== 0 || observed.transport.signal !== null || observed.transport.deadlineFired !== false || observed.transport.outputLimitExceeded !== false || observed.localCleanup.retired !== true || observed.localCleanup.error !== undefined || observed.error !== undefined) fail("OWNED_GUEST_CUSTODY_UNVERIFIED", "Owned custody requires completed and retired pinned transport proof.");
  const custody = JSON.parse(observed.stdout);
  if (custody.formatVersion !== 1 || custody.scope !== "owned-guest-custody-validation" || custody.ok !== true || custody.fixtureCustodyValidated !== true || custody.nonce !== nonce || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(custody.bootId) || !Number.isSafeInteger(custody.uid) || custody.uid <= 0 || !/^[a-f0-9]{64}$/.test(custody.manifestSha256) || custody.runtimeSupport !== "unverified" || custody.runtimeAdmission !== false || custody.humanConsentProof !== false || custody.nativeCpuPerformanceProof !== false) fail("OWNED_GUEST_CUSTODY_UNVERIFIED", "Pinned guest transport did not establish its explicit boot manifest binding.");
  copyOwnedGuestBinding({ nonce: custody.nonce, bootId: custody.bootId, uid: custody.uid, manifestSha256: custody.manifestSha256 }, nonce);
  return custody;
}

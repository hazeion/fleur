import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { stateDirectory } from "./grants.ts";
import type { HostIdentity, SetupHost } from "./commands.ts";

/** Presence or unreadable state blocks readiness, including malformed and dangling records. */
export async function hasPendingPackageTransaction(host: SetupHost, identity: HostIdentity): Promise<boolean> {
  const name = identity.distribution === "arch" ? "arch-transaction-pending.json"
    : ["ubuntu", "debian"].includes(identity.distribution ?? "") ? "apt-transaction-pending.json" : undefined;
  if (!name) return false;
  try { await lstat(join(stateDirectory(host), name)); return true; }
  catch (error) { return (error as { code?: string }).code !== "ENOENT"; }
}

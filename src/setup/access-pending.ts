import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { stateDirectory } from "./grants.ts";
import type { SetupHost } from "./commands.ts";
export function accessPendingPath(host: SetupHost): string { return join(stateDirectory(host), "linux-docker-access-pending.json"); }
/** Unreadable or malformed pending state never permits a daemon probe. */
export async function hasPendingLinuxAccess(host: SetupHost): Promise<boolean> {
  try { await lstat(accessPendingPath(host)); return true; }
  catch (error) { return (error as { code?: string }).code !== "ENOENT"; }
}

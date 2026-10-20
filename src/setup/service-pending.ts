import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { stateDirectory } from "./grants.ts";
import type { SetupHost } from "./commands.ts";
export function archServicePendingPath(host: SetupHost): string { return join(stateDirectory(host), "arch-service-start-pending.json"); }
/** Any existing or unreadable pending record is uncertainty; malformed records never imply absence. */
export async function hasPendingArchService(host: SetupHost): Promise<boolean> {
  try { await lstat(archServicePendingPath(host)); return true; }
  catch (error) { return (error as { code?: string }).code !== "ENOENT"; }
}

export function aptServicePendingPath(host: SetupHost): string { return join(stateDirectory(host), "apt-service-start-pending.json"); }
export async function hasPendingAptService(host: SetupHost): Promise<boolean> {
  try { await lstat(aptServicePendingPath(host)); return true; }
  catch (error) { return (error as { code?: string }).code !== "ENOENT"; }
}

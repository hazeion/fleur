import { withSetupLock, SetupBusy, syncStateDirectory } from "./lock.ts";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { failure, success, type CliOutcome } from "../cli/result.ts";
import type { CommandInput } from "../cli/catalog.ts";
import type { SetupHost } from "./commands.ts";
export interface Grant {
  readonly id: string;
  readonly action: string;
  readonly method: string;
  readonly target: string;
  readonly planChecksum: string;
  readonly machine: string;
  readonly user: number;
  readonly mode: "once" | "remembered";
  readonly revoked: boolean;
}
export function stateDirectory(host: SetupHost): string { return host.stateDirectory ?? join(homedir(), ".local", "state", "fleur", "setup"); }
function isGrant(value: unknown): value is Grant {
  if (value === null || typeof value !== "object") return false;
  const grant = value as Record<string, unknown>;
  return typeof grant.id === "string" && /^[a-f0-9-]{36}$/.test(grant.id) && ["install", "service-start", "service-enable", "docker-access", "configuration", "image-acquire"].includes(String(grant.action)) && ["docker-desktop-official-dmg", "docker-official-apt", "arch-official-pacman", "docker-digest-pull"].includes(String(grant.method)) && typeof grant.target === "string" && grant.target.length > 0 && grant.target.length <= 512 && [...grant.target].every((character) => character.charCodeAt(0) >= 32) && typeof grant.planChecksum === "string" && /^[a-f0-9]{64}$/.test(grant.planChecksum) && typeof grant.machine === "string" && /^[a-f0-9]{64}$/.test(grant.machine) && grant.user === process.getuid?.() && ["once", "remembered"].includes(String(grant.mode)) && typeof grant.revoked === "boolean";
}
export async function readGrants(host: SetupHost): Promise<readonly Grant[]> {
  const directory = stateDirectory(host);
  let info;
  try { info = await lstat(directory); } catch (error) { if ((error as { code?: string }).code === "ENOENT") return []; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Unsafe setup state directory");
  let file;
  try { file = await open(join(directory, "grants.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { if ((error as { code?: string }).code === "ENOENT") return []; throw error; }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.size > 65536) throw new Error("Unsafe setup grant file");
    // Bound bytes even if a regular file grows after its initial stat.
    const bytes = Buffer.alloc(65537);
    let used = 0;
    while (used < bytes.length) {
      const result = await file.read(bytes, used, bytes.length - used, used);
      if (result.bytesRead === 0) break;
      used += result.bytesRead;
    }
    if (used > 65536) throw new Error("Grant file exceeded the bounded read");
    const value: unknown = JSON.parse(bytes.subarray(0, used).toString("utf8"));
    if (value === null || typeof value !== "object") throw new Error("Invalid grant store");
    const store = value as Record<string, unknown>;
    if (store.formatVersion !== 1 || !Array.isArray(store.grants) || store.grants.length > 100 || !store.grants.every(isGrant) || new Set(store.grants.map((grant) => grant.id)).size !== store.grants.length) throw new Error("Invalid grant store");
    return store.grants;
  } finally { await file.close(); }
}
export async function listGrants(input: CommandInput, host: SetupHost): Promise<CliOutcome> {
  if (input.args.length) return failure("setup grants list", 2, { code: "ARGUMENT_INVALID", message: "Grant inspection takes no positional arguments.", actions: [] });
  try { return success("setup grants list", { grants: (await readGrants(host)).map(({ id, action, method, target, mode, revoked }) => ({ id, action, method, target, mode, revoked })) }); }
  catch { return failure("setup grants list", 5, { code: "RECOVERY_REQUIRED", message: "The private grant store is malformed or unsafe; no authority was used.", actions: [] }); }
}

export async function revokeGrant(input: CommandInput, host: SetupHost): Promise<CliOutcome> {
  const id = input.args[0];
  if (input.args.length !== 1 || !id || !/^[a-f0-9-]{36}$/.test(id)) return failure("setup grants revoke", 2, { code: "ARGUMENT_INVALID", message: "Specify exactly one setup grant ID.", actions: [] });
  try {
    return await withSetupLock(stateDirectory(host), async () => {
      const grants = await readGrants(host);
      if (!grants.some((grant) => grant.id === id)) return failure("setup grants revoke", 1, { code: "ARGUMENT_INVALID", message: "The setup grant does not exist.", actions: [{ command: "fleur setup grants list", description: "Inspect available grant IDs." }] });
      await writeGrants(host, grants.map((grant) => grant.id === id ? { ...grant, revoked: true } : grant));
      return success("setup grants revoke", { id, revoked: true });
    }, host.syncDirectory);
  } catch (error) { return failure("setup grants revoke", 5, { code: error instanceof SetupBusy ? "MAINTENANCE_BUSY" : "RECOVERY_REQUIRED", message: "Grant revocation is blocked by concurrent setup or unsafe state; no machine action was performed.", actions: [] }); }
}

/** Caller holds the setup lock across validation, consumption and the external action. */
export async function writeGrants(host: SetupHost, grants: readonly Grant[]): Promise<void> {
  const temporary = join(stateDirectory(host), `grants-${crypto.randomUUID()}.tmp`);
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify({ formatVersion: 1, grants }) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, join(stateDirectory(host), "grants.json"));
    // A rename is not durable authority until its directory entry is flushed.
    await (host.syncDirectory ?? syncStateDirectory)(stateDirectory(host));
  } finally { await unlink(temporary).catch(() => {}); }
}

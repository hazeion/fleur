import { lstat, readdir, realpath } from "node:fs/promises";
import { recoverDevelopmentImage } from "./images";
import { join } from "node:path";
import { nativeCommand } from "../native/command";
import { selectedEndpoint } from "../native/endpoint";
import { NativeLease } from "../native/lease";
import { RetainedLease } from "../native/retained-lease";
import type { Binding } from "./state";

/** Recovery runs after creation closes or with the dead owner's kernel lock acquired. Retain every uncertain journal. */
export async function recoverExecution(bound: Binding): Promise<void> {
  const root = join(bound.directory, "native");
  const info = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || await realpath(root) !== root) throw new Error("RECOVERY_REQUIRED");
  const entries = await readdir(root);
  if (!entries.length) return;
  for (const name of entries) {
    if (name.startsWith("fleur-retained-lease-")) await (await RetainedLease.recover(join(root, name))).cleanup();
    else if (name.startsWith("fleur-native-lease-")) await (await NativeLease.recover(join(root, name))).cleanup();
  }
  for (const name of entries) if (/^fleur-image-[a-f0-9-]{36}\.json$/.test(name)) await recoverDevelopmentImage(bound, name);
  if ((await readdir(root).catch(() => [])).length) throw new Error("RECOVERY_REQUIRED");
  const endpoint = await selectedEndpoint();
  const remaining = await nativeCommand(["docker", "--host", endpoint, "image", "ls", "--quiet", "--no-trunc", "--filter", `label=dev.fleur.development-binding=${bound.id}`]);
  // Labels discover residual resources; only a private creation journal authorizes their removal.
  if (remaining) throw new Error("RECOVERY_REQUIRED");
}

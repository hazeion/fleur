import { lstat, rm, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { privateJson } from "../database/maintenance-authority";
import { prepareNativeImages } from "../native/build";
import { nativeCommand } from "../native/command";
import { selectedEndpoint, validateEndpoint } from "../native/endpoint";
import { save, type Binding } from "./state";

const hex = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const schema = z.strictObject({ formatVersion: z.literal(1), binding: z.string().regex(/^[a-f0-9]{64}$/), owner: z.string().uuid(), endpoint: z.string(), directory: z.string().regex(/^fleur-read-build-[A-Za-z0-9]+$/), stage: z.enum(["controller", "worker", "complete"]), controller: hex.nullable(), worker: hex.nullable() });
const name = (owner: string) => `fleur-image-${owner}.json`;
/** Image creation intent and immutable IDs live outside the disposable build context. */
export function prepareDevelopmentImages(application: string, bound: Binding) {
  const root = join(bound.directory, "native");
  return prepareNativeImages(application, {
    binding: bound.id,
    async record(record) {
      if (resolve(record.directory, "..") !== root) throw new Error("RECOVERY_REQUIRED");
      await save(root, name(record.owner), schema.parse({ ...record, formatVersion: 1, binding: bound.id, directory: basename(record.directory) }));
    },
    async release(owner) {
      const path = join(root, name(owner));
      const record = schema.parse(await privateJson(path));
      if (record.owner !== owner || record.binding !== bound.id) throw new Error("RECOVERY_REQUIRED");
      await unlink(path);
    },
  });
}
/** Called after native process/container retirement, under the binding's lifecycle owner. */
export async function recoverDevelopmentImage(bound: Binding, file: string): Promise<void> {
  const root = join(bound.directory, "native"), record = schema.parse(await privateJson(join(root, file)));
  if (record.binding !== bound.id || file !== name(record.owner) || record.stage !== "complete" || !record.controller || !record.worker || record.endpoint !== await selectedEndpoint()) throw new Error("RECOVERY_REQUIRED");
  validateEndpoint(record.endpoint);
  const command = (args: string[]) => nativeCommand(["docker", "--host", record.endpoint, ...args]);
  for (const role of ["worker", "controller"] as const) {
    const tag = `fleur-read-build-${record.owner}-${role}`;
    const found = await command(["image", "ls", "--quiet", "--no-trunc", "--filter", `reference=${tag}`]);
    if (!found) continue;
    const image = JSON.parse(await command(["image", "inspect", tag, "--format", "{{json .}}"]));
    if (found !== record[role] || image.Id !== found || image.Config?.Labels?.["dev.fleur.read-image-owner"] !== record.owner || image.Config?.Labels?.["dev.fleur.development-binding"] !== bound.id || !image.RepoTags?.includes(tag+":latest") || await command(["ps", "--all", "--quiet", "--filter", `ancestor=${found}`])) throw new Error("RECOVERY_REQUIRED");
    await command(["image", "rm", tag]);
    if (await command(["image", "ls", "--quiet", "--no-trunc", "--filter", `reference=${tag}`])) throw new Error("RECOVERY_REQUIRED");
  }
  const directory = join(root, record.directory);
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("RECOVERY_REQUIRED");
    await rm(directory, { recursive: true });
  }
  await unlink(join(root, file));
}

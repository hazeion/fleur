import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { privateJson } from "../database/maintenance-authority";
import { startIdentity } from "../development/state";
import { productionDirectory, projectKey } from "./artifact";

const registration = z.strictObject({ formatVersion: z.literal(1), artifact: z.string(), pid: z.number().int().positive(), start: z.string(), url: z.string(), state: z.enum(["starting", "ready", "stopped"]), fingerprint: z.string().nullable() });
export type ProductionRegistration = z.infer<typeof registration>;
/** A live production start for this project on this machine. Stale or stopped records report nothing. */
export async function registeredProduction(project: string): Promise<ProductionRegistration & { readonly state: "starting" | "ready" } | null> {
  try {
    const root = await realpath(project);
    const { projectId } = z.object({ projectId: z.string().optional() }).parse(JSON.parse(await readFile(join(root, "fleur.json"), "utf8")));
    const record = registration.parse(await privateJson(join(productionDirectory(homedir(), projectKey(projectId, root)), "instance.json")));
    if (record.state === "stopped" || await startIdentity(record.pid) !== record.start) return null;
    return { ...record, state: record.state };
  } catch { return null; }
}

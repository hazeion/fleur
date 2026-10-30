import { join } from "node:path";
import { binding, readState } from "./state";
import { DevelopmentPostgres } from "./postgres";

/** Private invocation context. Never mutates process.env or exposes credentials to application modules. */
export async function databaseEnvironment(project: string): Promise<Record<string, string | undefined>> {
  let bound;
  try { bound = await binding(project, false); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return process.env; throw new Error("RECOVERY_REQUIRED"); }
  const state = await readState(bound);
  if (!state) return process.env;
  const postgres = await DevelopmentPostgres.read(bound);
  if (!postgres) throw new Error("DATABASE_UNAVAILABLE");
  const url = await postgres.url(), controlUrl = await postgres.url("postgres");
  const tools = await postgres.tools();
  return { ...process.env, FLEUR_PRIVATE_DATABASE_URL: url, FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL: url, FLEUR_PRIVATE_CONTROL_DATABASE_URL: controlUrl, FLEUR_PRIVATE_STATE_ROOT: join(bound.directory, "maintenance"), FLEUR_PRIVATE_PG_TOOLS: tools };
}

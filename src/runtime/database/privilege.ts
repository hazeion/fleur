import type { SQL } from "bun";

/**
 * Stable capability categories that DATABASE_PRIVILEGE_INSUFFICIENT names. The first four form the documented
 * minimum-privilege profile for read-only operations; the rest are the additional authority that backup, migration
 * apply, seed, restore and reset need. Descriptions never name a role, host, port or URL.
 */
export const capabilities = {
  "database connect": "CONNECT on the application and control databases",
  "identity inspection": "EXECUTE on pg_control_system() in the application and control databases",
  "maintenance locks": "EXECUTE on the advisory lock functions in the control database",
  "schema read": "USAGE on the schemas and SELECT on the tables and sequences that the command reads",
  "role and database creation": "superuser, or CREATEROLE and CREATEDB with createrole_self_grant including set and inherit, to create, verify and remove the disposable backup verification role and database",
  "schema write": "CREATE on the application database and its public and fleur_internal schemas, and ownership of their tables and functions",
  "database replacement": "ownership of the application database and its schemas, to replace its contents or drop and recreate it",
} as const;
export type Capability = keyof typeof capabilities;
/** Capabilities the documented minimum-privilege profile grants. */
export const profileCapabilities: readonly Capability[] = ["database connect", "identity inspection", "maintenance locks", "schema read"];

/** The configured credential lacks `capability`. Thrown before the command changes anything. */
export class PrivilegeInsufficient extends Error {
  readonly capability: Capability;
  constructor(capability: Capability) { super("DATABASE_PRIVILEGE_INSUFFICIENT"); this.capability = capability; }
}
/** PostgreSQL's insufficient_privilege refusal (SQLSTATE 42501), including a refused CONNECT. */
function refused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return code === "ERR_POSTGRES_SERVER_ERROR" && errno === "42501";
}
/** Runs one step that needs `capability`, reporting PostgreSQL's privilege refusal as that capability's shortfall. */
export async function privileged<T>(capability: Capability, step: () => Promise<T>): Promise<T> {
  try { return await step(); }
  catch (error) { throw refused(error) ? new PrivilegeInsufficient(capability) : error; }
}
/** The shortfall behind a failure, including one that a maintenance lease reported as PREREQUISITE_UNAVAILABLE. */
export function privilegeShortfall(error: unknown): PrivilegeInsufficient | undefined {
  if (error instanceof PrivilegeInsufficient) return error;
  if (error instanceof Error && error.message === "PREREQUISITE_UNAVAILABLE" && error.cause instanceof PrivilegeInsufficient) return error.cause;
  return undefined;
}

type Connection = Pick<SQL, "unsafe">;
const userSchemas = "n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'";
const fleurSchemas = "n.nspname IN ('public','fleur_internal')";
/** Role attributes and the self-grant setting that the disposable verification role and database need. */
const creation = "SELECT r.rolsuper OR (r.rolcreaterole AND r.rolcreatedb AND string_to_array(replace(lower(current_setting('createrole_self_grant')),' ',''),',') @> ARRAY['set','inherit']) AS granted FROM pg_roles r WHERE r.rolname=current_user";
/** Everything a backup dumps and an integrity digest reads: every user schema, table, materialized view and sequence. */
const read = `SELECT NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE ${userSchemas} AND NOT has_schema_privilege(n.oid,'USAGE'))
  AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userSchemas} AND ((c.relkind IN ('r','p','m') AND NOT has_table_privilege(c.oid,'SELECT')) OR (c.relkind='S' AND NOT has_sequence_privilege(c.oid,'SELECT')))) AS granted`;
/** Creating Fleur's schema objects and altering or replacing the existing ones. */
const write = `SELECT has_database_privilege(current_database(),'CREATE')
  AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE ${fleurSchemas} AND NOT (has_schema_privilege(n.oid,'CREATE') AND has_schema_privilege(n.oid,'USAGE')))
  AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${fleurSchemas} AND NOT pg_has_role(c.relowner,'USAGE'))
  AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${fleurSchemas} AND NOT pg_has_role(p.proowner,'USAGE')) AS granted`;

/** Dropping and recreating the database, or removing its schemas before a restore. */
const replace = `SELECT pg_has_role((SELECT d.datdba FROM pg_database d WHERE d.datname=current_database()),'USAGE')
  AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE ${userSchemas} AND NOT pg_has_role(n.nspowner,'USAGE')) AS granted`;

/**
 * Preflight for maintenance that changes the target: verifies, through PostgreSQL's own privilege functions, each
 * capability the command needs, in the order given, before any marker, grant, backup or schema change exists. Role
 * and database creation is read on the control connection; schema authority on the target connection.
 */
export async function requireAuthority(control: Connection, target: Connection, needs: readonly ("role and database creation" | "database replacement" | "schema write" | "schema read")[]): Promise<void> {
  for (const need of needs) {
    const rows = await (need === "role and database creation" ? control.unsafe(creation) : target.unsafe(need === "schema write" ? write : need === "database replacement" ? replace : read));
    if (rows[0]?.granted !== true) throw new PrivilegeInsufficient(need);
  }
}

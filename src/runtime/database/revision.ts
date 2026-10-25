export interface DatabaseRevision { readonly epoch: string; readonly revision: string; }
type Execute = (sql: string, values?: unknown[]) => Promise<unknown>;

/** Called under a managed transaction and the shared maintenance fence. */
export async function ensureRevision(execute: Execute): Promise<void> {
  await execute("SELECT pg_advisory_xact_lock(713406329821::bigint)");
  await execute("CREATE SCHEMA IF NOT EXISTS fleur_internal");
  await execute("CREATE TABLE IF NOT EXISTS fleur_internal.revision(singleton boolean PRIMARY KEY CHECK(singleton), revision bigint NOT NULL CHECK(revision>=0))");
  await execute("INSERT INTO fleur_internal.revision VALUES(true,0) ON CONFLICT DO NOTHING");
}

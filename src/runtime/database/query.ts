import { inspectionPageBytes, inspectionRowBytes } from "./inspection";
import { SQL } from "bun";
import { join } from "node:path";
import { binding } from "../development/state";
import { DevelopmentPostgres } from "../development/postgres";
import { provisionAgentQueryRole, agentQueryRole } from "./agent-query-role";
import { MaintenanceLease, type MaintenanceConfiguration } from "./maintenance";
import { readMigrationStatus } from "./migration-status";
import { maintenanceSummary, unavailability, withInspection } from "./target";
import { PostgresQueryError, QueryWire } from "./query-wire";
import { PrivilegeInsufficient } from "./privilege";

function redactor(secrets: readonly string[]) {
  return (value: string) => {
    let text = value;
    for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[redacted]");
    return text.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "[redacted]");
  };
}
export class QueryRejected extends Error {
  readonly diagnostic: { readonly [key: string]: string };
  constructor(error: PostgresQueryError, secrets: readonly string[]) {
    const redact = redactor(secrets);
    super(redact(error.message));
    this.diagnostic = Object.fromEntries([["sqlstate", error.fields.C], ["message", error.fields.M], ["position", error.fields.P], ["detail", error.fields.D], ["hint", error.fields.H]].flatMap(([key, value]) => value === undefined ? [] : [[key!, redact(value).slice(0,4096)]]));
  }
}
export interface QueryOptions { readonly sql: string; readonly params: readonly string[]; readonly limit: number; readonly timeoutMs: number }

/** Public operation selects only Docker-owned development storage, never environment URLs or production configuration. */
export async function developmentQuery(project: string, options: QueryOptions) {
  let postgres: DevelopmentPostgres | null;
  let directory: string;
  try { const bound = await binding(project, false); directory = bound.directory; postgres = await DevelopmentPostgres.read(bound); }
  catch { throw new Error("DATABASE_UNAVAILABLE"); }
  if (!postgres) throw new Error("DATABASE_UNAVAILABLE");
  return postgres.query(project, options, { stateRoot: join(directory, "maintenance") });
}

/** Trusted core, called only after the resource verified Docker, cluster and application identity. */
export async function queryDevelopmentDatabase(url: string, password: string, project: string, options: QueryOptions, config: MaintenanceConfiguration) {
  if (Buffer.byteLength(options.sql) > 65536 || !options.sql.trim() || options.sql.includes("\0") || options.params.length > 1000 || options.params.some(value => value.includes("\0")) || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500 || options.timeoutMs <= 0 || options.timeoutMs > 30000) throw new Error("ARGUMENT_INVALID");
  const started = performance.now(), remaining = () => Math.max(1, options.timeoutMs - (performance.now() - started));
  const lease = await MaintenanceLease.acquire(url, false, { ...config, timeoutMs: remaining() }, true);
  let wire: QueryWire | undefined, admin: SQL | undefined;
  let expired = false;
  let expire: (error: Error) => void = () => {};
  const expiry = new Promise<never>((_, reject) => { expire = reject; }); expiry.catch(() => {});
  const closeQuery = async (terminate: boolean) => {
    // Destroying a socket alone does not interrupt pg_sleep or a CPU-bound statement.
    const session = wire;
    if (terminate && session?.backend !== undefined) await lease.sql.unsafe("SELECT pg_terminate_backend($1::integer,1000)", [session.backend]);
    if (!terminate) await session?.query("ROLLBACK").catch(() => {});
    session?.close();
  };
  const timer = setTimeout(() => { expired = true; wire?.close(); expire(new Error("QUERY_TIMEOUT")); }, remaining());
  const operation = (async () => {
    const marker = await lease.marker();
    if (maintenanceSummary(lease.busy, marker).state !== "idle") throw new Error("MAINTENANCE_BUSY");
    await lease.assertSession();
    admin = new SQL(url, { max: 1, connectionTimeout: 2 });
    await provisionAgentQueryRole(lease.sql, password, admin, started + options.timeoutMs);
    if (expired) throw new Error("QUERY_TIMEOUT");
    const report = await withInspection(url, "development", { ...config, timeoutMs: remaining() }, session => readMigrationStatus(session, project));
    const login = new URL(url); login.username = agentQueryRole; login.password = password;
    wire = await QueryWire.open(login, session => { wire = session; if (expired) session.close(); });
    if (expired) throw new Error("QUERY_TIMEOUT");
    await wire.query("BEGIN READ ONLY");
    await wire.query(`SET LOCAL statement_timeout='${Math.ceil(remaining())}ms'`);
    await wire.query("SET LOCAL lock_timeout='1s'");
    await wire.query("SET LOCAL row_security=off");
    await wire.query("SET LOCAL search_path=pg_catalog,public");
    await wire.query("SET LOCAL timezone='UTC'");
    await wire.query("SET LOCAL datestyle='ISO,YMD'");
    // Newline prevents a trailing line comment from swallowing the wrapper. Extended protocol rejects escape attempts
    // that turn this into multiple statements. No application SQL is ever sent using the administrative credential.
    const wrapped = `SELECT * FROM (\n${options.sql}\n) AS fleur_query LIMIT $${options.params.length + 1}::bigint`;
    const result = await wire.query(wrapped, [...options.params, String(options.limit + 1)], inspectionRowBytes);
    const endpoint = new URL(url);
    const redact = redactor([url, password, decodeURIComponent(endpoint.password), decodeURIComponent(endpoint.username), agentQueryRole, endpoint.hostname, endpoint.port, lease.target.address, String(lease.target.port)]);
    const columns: { name: string; type: string }[] = [];
    for (const column of result.columns) {
      const type = (await admin.unsafe("SELECT format_type($1::oid,$2::integer) AS name", [column.oid, column.modifier]))[0].name;
      columns.push({ name: redact(column.name), type: redact(String(type)) });
    }
    const rows = result.rows.slice(0, options.limit).map(row => row.map(value => value === null ? null : redact(value))), truncated = result.truncated || result.rows.length > options.limit;
    const data = { columns, rows, truncated, migrations: report.summary };
    // Reserve the same result cap as db inspect, including metadata and migration summary.
    while (rows.length && Buffer.byteLength(JSON.stringify(data)) > inspectionPageBytes) { rows.pop(); data.truncated = true; }
    if (Buffer.byteLength(JSON.stringify(data)) > inspectionPageBytes) throw new Error("RESULT_TOO_LARGE");
    return data;
  })();
  try { return await Promise.race([operation, expiry]); }
  catch (error) {
    if (expired || error instanceof PostgresQueryError && error.fields.C === "57014" || error instanceof SQL.PostgresError && error.errno === "57014") { expired = true; throw new Error("QUERY_TIMEOUT"); }
    if (error instanceof PostgresQueryError) {
      const endpoint = new URL(url);
      throw new QueryRejected(error, [url, password, decodeURIComponent(endpoint.password), decodeURIComponent(endpoint.username), agentQueryRole, endpoint.hostname, endpoint.port, lease.target.address, String(lease.target.port)]);
    }
    if (error instanceof PrivilegeInsufficient) throw error;
    if (unavailability(error)) throw new Error("DATABASE_UNAVAILABLE");
    throw error;
  } finally {
    clearTimeout(timer);
    try { await closeQuery(expired); } finally { await admin?.close({ timeout: 0 }); await lease.close(); }
    // Setup in flight must observe expiry before opening a new agent session.
    operation.catch(() => {});
  }
}

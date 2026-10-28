import { SQL } from "bun";
import { z } from "zod";
import { MaintenanceLease, databaseUrl, digest, leaseDeadline, type MaintenanceConfiguration, type MaintenanceMarker } from "./maintenance";

export type TargetKind = "development" | "production";
/** How a target is identified in output. Host, port, user and URL never appear. */
export type TargetSummary = { readonly kind: TargetKind; readonly database: string; readonly serverVersion: string | null; readonly fingerprint: string | null };

function sameUrl(left: string, right: string): boolean {
  try { return new URL(left).toString() === new URL(right).toString(); } catch { return false; }
}
/**
 * Both targets read the explicit private configuration that the runtime broker and `start` use. A development binding
 * supplied by the trusted lifecycle environment is never a production target, and a configuration that differs from
 * that binding is not the development target. Throws CONFIGURATION_MISSING.
 */
export function selectTarget(production: boolean, environment: Record<string, string | undefined> = process.env): { readonly url: string; readonly kind: TargetKind; readonly database: string } {
  const url = environment.FLEUR_PRIVATE_DATABASE_URL;
  if (!url) throw new Error("CONFIGURATION_MISSING");
  let database: string;
  try { database = databaseUrl(url).pathname.slice(1); } catch { throw new Error("CONFIGURATION_MISSING"); }
  const development = environment.FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL;
  const bound = development !== undefined && sameUrl(development, url);
  if (production ? bound : development !== undefined && !bound) throw new Error("CONFIGURATION_MISSING");
  return { url, kind: production ? "production" : "development", database };
}

export type Unavailability = "refused" | "timeout" | "rejected";
export type MaintenanceState = "idle" | "active" | "recovery required";
export type MaintenanceSummary = { readonly state: MaintenanceState; readonly stage: MaintenanceMarker["stage"] | null };
/** Active while another owner holds maintenance; an unfinished recorded stage without an owner needs recovery. */
export function maintenanceSummary(busy: boolean, marker: MaintenanceMarker | null): MaintenanceSummary {
  const stage = marker?.stage ?? null;
  return { state: busy ? "active" : stage !== null && stage !== "committed" && stage !== "rollback verified" ? "recovery required" : "idle", stage };
}
/**
 * Thrown when a database Fleur needs cannot be reached, refuses the connection or does not answer in time. When the
 * control database answered, `maintenance` carries its maintenance state, for example while a restore or reset has
 * replaced the target.
 */
export class DatabaseUnavailable extends Error {
  readonly failure: Unavailability;
  readonly maintenance: MaintenanceSummary | null;
  constructor(failure: Unavailability, maintenance: MaintenanceSummary | null = null) { super("DATABASE_UNAVAILABLE"); this.failure = failure; this.maintenance = maintenance; }
}
const connectionCodes = /^ERR_POSTGRES_(CONNECTION_CLOSED|CONNECTION_FAILED|TLS_|AUTHENTICATION_FAILED|SASL_|UNKNOWN_AUTHENTICATION|UNSUPPORTED_AUTHENTICATION|INVALID_SERVER_(KEY|SIGNATURE))/;
/** Connection failure, authentication rejection, missing database, shutdown, connection exhaustion or a statement timeout. */
export function unavailability(error: unknown): Unavailability | undefined {
  const cause = error instanceof Error && error.message === "PREREQUISITE_UNAVAILABLE" ? error.cause : error;
  if (cause === leaseDeadline) return "timeout";
  if (!cause || typeof cause !== "object") return undefined;
  const { code, errno } = cause as { code?: unknown; errno?: unknown };
  if (code === "ERR_POSTGRES_CONNECTION_REFUSED" || code === "ECONNREFUSED") return "refused";
  if (code === "ERR_POSTGRES_CONNECTION_TIMEOUT" || code === "ERR_POSTGRES_IDLE_TIMEOUT" || code === "ERR_POSTGRES_LIFETIME_TIMEOUT" || code === "ETIMEDOUT" || (code === "ERR_POSTGRES_SERVER_ERROR" && errno === "57014")) return "timeout";
  if (typeof code === "string" && (connectionCodes.test(code) || /^E(CONNRESET|HOSTUNREACH|NETUNREACH|PIPE|ADDRNOTAVAIL)$/.test(code))) return "rejected";
  if (code === "ERR_POSTGRES_SERVER_ERROR" && typeof errno === "string" && /^(08...|28...|3D000|57P0[123]|53300)$/.test(errno)) return "rejected";
  return undefined;
}

export interface InspectionSession {
  /** Target connection inside a host-opened REPEATABLE READ READ ONLY transaction with `search_path=pg_catalog`. */
  readonly sql: SQL;
  readonly lease: MaintenanceLease;
  readonly marker: MaintenanceMarker | null;
  readonly target: TargetSummary;
}
const identity = z.strictObject({ cluster: z.string(), database: z.string(), oid: z.string(), address: z.string(), port: z.number().int(), version: z.string().min(1).max(64), backend: z.number().int() });
/**
 * Opens Fleur's read-only inspection of a verified target, runs `use` and always releases it. Maintenance and drift do
 * not block it. `config.timeoutMs` bounds the whole inspection: at the deadline it fails with DATABASE_UNAVAILABLE
 * ("timeout"), cancels the target statement in progress and closes its connections. Closing a Bun SQL connection does
 * not interrupt a running statement, so the cancellation, with a 5 s statement timeout behind it, ends that work.
 */
export async function withInspection<T>(url: string, kind: TargetKind, config: MaintenanceConfiguration, use: (session: InspectionSession) => Promise<T>): Promise<T> {
  const deadline = Math.max(1, config.timeoutMs ?? 60000);
  let expired = false, lease: MaintenanceLease | undefined, sql: SQL | undefined, backend: number | undefined, acquired: MaintenanceLease | undefined;
  let expire: (error: Error) => void = () => {};
  const expiry = new Promise<never>((_, reject) => { expire = reject; });
  expiry.catch(() => {});
  const release = (cancel: boolean) => {
    const [target, control] = [sql, lease];
    sql = undefined; lease = undefined;
    const cancelled = cancel && control && backend !== undefined ? control.sql.unsafe("SELECT pg_cancel_backend($1::integer)", [backend]).catch(() => {}) : Promise.resolve();
    return cancelled.then(async () => {
      await target?.unsafe("ROLLBACK").catch(() => {});
      await target?.close({ timeout: 0 }).catch(() => {});
      await control?.close().catch(() => {});
    });
  };
  const timer = setTimeout(() => { expired = true; void release(true); expire(new DatabaseUnavailable("timeout")); }, deadline);
  const inspection = (async () => {
    const control = await MaintenanceLease.acquire(url, false, { ...config, timeoutMs: deadline }, true);
    if (expired) { await control.close(); throw new DatabaseUnavailable("timeout"); }
    lease = acquired = control;
    const connection = sql = new SQL(url, { max: 1, connectionTimeout: 2 });
    await connection.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await connection.unsafe("SET LOCAL statement_timeout='5s'");
    await connection.unsafe("SET LOCAL search_path=pg_catalog");
    const actual = identity.parse((await connection.unsafe("SELECT system_identifier::text AS cluster, current_database()::text AS database, d.oid::text AS oid, coalesce(inet_server_addr()::text,'') AS address, inet_server_port() AS port, split_part(current_setting('server_version'),' ',1) AS version, pg_backend_pid() AS backend FROM pg_control_system(), pg_database d WHERE d.datname=current_database()"))[0]);
    backend = actual.backend;
    const expected = control.target;
    // The target session must reach the same cluster, database and endpoint that the control session verified.
    if (actual.cluster !== expected.cluster || actual.database !== expected.database || actual.oid !== expected.oid || actual.address !== expected.address || actual.port !== expected.port) throw new Error("CONFIGURATION_MISSING");
    const marker = await control.marker();
    const target = { kind, database: actual.database, serverVersion: actual.version, fingerprint: digest(`fleur:target:v1:${actual.cluster}:${actual.database}`).slice(0, 32) };
    return await use({ sql: connection, lease: control, marker, target });
  })();
  try {
    const result = await Promise.race([inspection, expiry]);
    // A result assembled while the deadline closed the connections may rest on interrupted reads.
    if (expired) throw new DatabaseUnavailable("timeout");
    return result;
  } catch (error) {
    if (expired || error instanceof DatabaseUnavailable) throw expired ? new DatabaseUnavailable("timeout") : error;
    const failure = unavailability(error);
    if (!failure) throw error;
    // The control database answered: keep its maintenance state, which explains a replaced or missing target.
    const marker = acquired ? await acquired.marker().catch(() => undefined) : undefined;
    throw new DatabaseUnavailable(failure, acquired && marker !== undefined ? maintenanceSummary(acquired.busy, marker) : null);
  } finally {
    clearTimeout(timer);
    inspection.catch(() => {});
    if (!expired) await release(false);
  }
}

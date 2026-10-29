import { SQL } from "bun";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Seed } from "../../database";
import type { ExitCode, RecoveryAction } from "../../cli/result";
import { orderSeeds } from "../seed-declarations";
import { tableDefinitions } from "../declarations";
import { privilegeFailure } from "./commands";
import { databaseHealth, readinessReasons, type DatabaseHealth, type ReadinessReason } from "./health";
import { publishFile, quote } from "./inspection";
import { MaintenanceLease, databaseUrl, digest, syncDirectory, type MaintenanceConfiguration } from "./maintenance";
import { privateJson } from "./maintenance-authority";
import { readMigrations } from "./migration-plan";
import { assertMigrationState, catalogFingerprint, emptyApplicationSchema } from "./migration-state";
import type { MigrationSummary } from "./migration-status";
import { privileged, privilegeShortfall, requireAuthority } from "./privilege";
import { canonical, reconcileSeeds } from "./seeds";
import { unavailability } from "./target";

/**
 * The development database of one storage binding, supplied by the trusted development lifecycle. `binding` is the
 * opaque storage-binding identity derived from repository project metadata and machine-local checkout identity; it is
 * machine state, never tracked configuration. Production `start` and test databases never supply one.
 */
export interface DevelopmentDatabase { readonly url: string; readonly binding: string }

/**
 * The durable private creation record that proves a development database new. Fleur writes it, bound to the cluster,
 * database name, owner and storage binding, before creating the database, and binds the database OID once created.
 * Stages: `creating` (database not yet proven created by Fleur), `new`, `initializing` (initialization transaction
 * `transaction` was about to commit) and `retired` (never new again).
 */
const recordSchema = z.strictObject({
  formatVersion: z.literal(1),
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  cluster: z.string().regex(/^\d+$/),
  database: z.string().min(1).max(63),
  owner: z.string().min(1),
  oid: z.string().regex(/^\d+$/).nullable(),
  stage: z.enum(["creating", "new", "initializing", "retired"]),
  transaction: z.string().regex(/^\d+$/).nullable(),
});
type CreationRecord = z.infer<typeof recordSchema>;
const recordFile = "development-creation.json";
const bindingDigest = (binding: string) => digest(`fleur:development-binding:v1:${binding}`);
async function readRecord(lease: MaintenanceLease): Promise<CreationRecord | null> {
  let value: unknown;
  try { value = await privateJson(join(lease.directory, recordFile)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("RECOVERY_REQUIRED"); }
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new Error("RECOVERY_REQUIRED");
  return parsed.data;
}
/** Replaces the record atomically and durably, only while this lease still holds exclusive maintenance. */
async function writeRecord(lease: MaintenanceLease, record: CreationRecord): Promise<void> {
  await lease.assertSession();
  const path = join(lease.directory, recordFile), temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await publishFile(temporary, JSON.stringify(recordSchema.parse(record)) + "\n");
  await lease.assertSession();
  await rename(temporary, path);
  await syncDirectory(lease.directory);
}
/** Retries while another startup or maintenance owner holds the database, until the deadline. */
async function uncontended<T>(deadline: number, step: () => Promise<T>): Promise<T> {
  for (;;) {
    try { return await step(); }
    catch (error) {
      if (!(error instanceof Error && error.message === "MAINTENANCE_BUSY") || performance.now() + 250 >= deadline) throw error;
      await Bun.sleep(100 + Math.random() * 150);
    }
  }
}

/**
 * Creates the binding's development database when it does not exist, writing the creation record first. An existing
 * database, including an adopted volume's, is left untouched and never becomes new. When a database that may have
 * been initialized has disappeared, its empty replacement is never new, and readiness reports what Fleur's records
 * expected of it.
 */
export async function createDevelopmentDatabase(database: DevelopmentDatabase, config: MaintenanceConfiguration = {}): Promise<{ readonly created: boolean }> {
  const name = databaseUrl(database.url).pathname.slice(1);
  const lease = await MaintenanceLease.acquire(database.url, true, config, true);
  try {
    if (lease.busy) throw new Error("MAINTENANCE_BUSY");
    const marker = await lease.marker();
    if (marker && !["committed", "rollback verified"].includes(marker.stage)) throw new Error("RECOVERY_REQUIRED");
    if ((await lease.sql.unsafe("SELECT 1 FROM pg_database WHERE datname=$1", [name])).length) return { created: false };
    const record = await readRecord(lease);
    // Only a record that was never initialized, or never finished creating, lets the replacement be new.
    const used = record !== null && (record.stage === "initializing" || record.stage === "retired");
    const owner = String((await lease.sql.unsafe("SELECT current_user::text AS owner"))[0].owner);
    const base = { formatVersion: 1 as const, binding: bindingDigest(database.binding), cluster: lease.target.cluster, database: name, owner, transaction: null };
    await writeRecord(lease, used ? { ...record, stage: "retired" } : { ...base, oid: null, stage: "creating" });
    await lease.assertSession();
    await privileged("role and database creation", () => lease.sql.unsafe(`CREATE DATABASE ${quote(name)} OWNER ${quote(owner)} TEMPLATE template0`));
    const created = await lease.sql.unsafe("SELECT oid::text AS oid, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1", [name]);
    if (created.length !== 1 || created[0].owner !== owner) throw new Error("RECOVERY_REQUIRED");
    await writeRecord(lease, used ? { ...record, oid: String(created[0].oid), stage: "retired" } : { ...base, oid: String(created[0].oid), stage: "new" });
    return { created: true };
  } finally { await lease.close(); }
}

/** Cause of RECOVERY_REQUIRED when the initialization commit's outcome could not be read back. */
const uncertainCommit = Symbol("uncertain initialization commit");
/** PostgreSQL's record of a transaction: committed, aborted, in progress, or null when no longer known. */
async function transactionStatus(lease: MaintenanceLease, xid: string): Promise<unknown> {
  return lease.sql.unsafe("SELECT pg_xact_status($1::xid8) AS status", [xid]).then(rows => rows[0]?.status, () => null);
}

export type InitializationStatus = "initialized" | "new" | "existing" | "failed";
export interface Initialization { readonly status: Exclude<InitializationStatus, "failed">; readonly migrationsApplied: readonly string[]; readonly seedRowsApplied: number }
const existing: Initialization = { status: "existing", migrationsApplied: [], seedRowsApplied: 0 };

/**
 * Initializes a new development database: the whole plan-validated committed migration chain, including removals,
 * then the declared seeds, commit in one transaction under the maintenance lock, with no backup or approval. The
 * expected catalog is recorded in the migration history and the maintenance record for drift detection.
 *
 * Newness is proved under the lock: this binding's creation record matches the database's cluster, name, OID and
 * owner, and the catalog holds no application objects and no Fleur metadata. Any other database is `existing` and
 * keeps the explicit flow. An empty chain leaves the database `new`. Failure rolls back and leaves the database new,
 * so a later startup may retry. Only a development startup calls this; reload never does.
 */
export async function initializeDevelopmentDatabase(database: DevelopmentDatabase, project: string, declarations: readonly Seed[], config: MaintenanceConfiguration = {}): Promise<Initialization> {
  const deadline = performance.now() + (config.timeoutMs ?? 60000);
  return uncontended(deadline, () => initializeOnce(database, project, declarations, config, deadline));
}
async function initializeOnce(database: DevelopmentDatabase, project: string, declarations: readonly Seed[], config: MaintenanceConfiguration, deadline: number): Promise<Initialization> {
  const remaining = () => Math.max(1, deadline - performance.now());
  const binding = bindingDigest(database.binding);
  // Without a candidate record nothing can be new: answer without taking or draining maintenance.
  const probe = await MaintenanceLease.acquire(database.url, false, { ...config, timeoutMs: remaining() }, true);
  let candidate: CreationRecord | null;
  try { candidate = await readRecord(probe); } finally { await probe.close(); }
  if (!candidate || candidate.binding !== binding || candidate.stage === "creating" || candidate.stage === "retired") return existing;
  const plans = await readMigrations(project);
  if (plans.some(plan => plan.incompatibilities.length || plan.backfills.length)) throw new Error("MIGRATION_INCOMPATIBLE");
  const seeds = orderSeeds(declarations);
  const lease = await MaintenanceLease.acquire(database.url, true, { ...config, timeoutMs: remaining() });
  const sql = new SQL(database.url, { max: 1, connectionTimeout: 2, idleTimeout: 0, maxLifetime: 0 });
  const timer = setTimeout(() => { void sql.close({ timeout: 0 }).catch(() => {}); void lease.close().catch(() => {}); }, remaining());
  let record: CreationRecord | null = null, transaction = false, commitAttempted = false, xid: string | null = null;
  try {
    const fence = await privileged("maintenance locks", () => sql.unsafe("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [lease.key]));
    if (!fence[0]?.acquired) throw new Error("MAINTENANCE_BUSY");
    record = await readRecord(lease);
    const target = lease.target;
    if (!record || record.binding !== binding || record.cluster !== target.cluster || record.database !== target.database || record.oid !== target.oid || record.owner !== target.owner || record.stage === "creating" || record.stage === "retired") return existing;
    if (record.stage === "initializing") {
      // An earlier initialization was about to commit: its transaction status decides, never the catalog alone.
      const status = await transactionStatus(lease, record.transaction!);
      if (status === "committed") { await writeRecord(lease, { ...record, stage: "retired" }); return existing; }
      if (status === "in progress") throw new Error("MAINTENANCE_BUSY");
      if (status !== "aborted") return existing;
      record = { ...record, stage: "new", transaction: null };
      await writeRecord(lease, record);
    }
    const metadata = await privileged("schema read", () => sql.unsafe("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='fleur_internal') AS present"));
    if (metadata[0]?.present !== false || !await privileged("schema read", () => emptyApplicationSchema(sql))) {
      // Something other than initialization changed this database: it is never new again, even if later emptied.
      await writeRecord(lease, { ...record, stage: "retired" });
      return existing;
    }
    if (!plans.length) return { status: "new", migrationsApplied: [], seedRowsApplied: 0 };
    await requireAuthority(lease.sql, sql, ["schema write", "schema read"]);
    await sql.unsafe("BEGIN ISOLATION LEVEL READ COMMITTED"); transaction = true;
    await sql.unsafe("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='3s'; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'");
    await sql.unsafe("CREATE SCHEMA fleur_internal; CREATE TABLE fleur_internal.migrations(position integer PRIMARY KEY,id text NOT NULL UNIQUE,checksum text NOT NULL UNIQUE,parent_checksum text,catalog text NOT NULL,snapshot text NOT NULL)");
    for (const plan of plans) {
      for (const statement of plan.statements) { await lease.assertSession(); await sql.unsafe(statement); }
      await sql.unsafe("INSERT INTO fleur_internal.migrations VALUES($1,$2,$3,$4,$5,$6)", [Number(plan.id), plan.id, plan.checksum, plan.parentChecksum, await catalogFingerprint(sql), JSON.stringify(plan.snapshot)]);
    }
    // Seeds may only use tables exactly as the committed chain creates them.
    await assertMigrationState(sql, [...new Set(seeds.map(seed => seed.table))]);
    const seeded = seeds.length ? (await reconcileSeeds(sql, seeds)).result : { inserted: 0, updated: 0 };
    const catalog = await catalogFingerprint(sql);
    xid = String((await sql.unsafe("SELECT pg_current_xact_id()::text AS xid"))[0].xid);
    if (JSON.stringify(await readMigrations(project)) !== JSON.stringify(plans)) throw new Error("MIGRATION_EDITED");
    await writeRecord(lease, { ...record, stage: "initializing", transaction: xid });
    await lease.assertSession(); commitAttempted = true; transaction = false;
    try { await sql.unsafe("COMMIT"); }
    catch (error) { if (await transactionStatus(lease, xid) !== "committed") throw error; }
    // The initialization committed. The bookkeeping below cannot undo it: a record left `initializing` is retired by
    // the next startup from the transaction's status, and the history rows already hold the expected catalog.
    const history = plans.map(plan => plan.checksum);
    try {
      await writeRecord(lease, { ...record, stage: "retired", transaction: xid });
      const previous = await lease.marker();
      await lease.persist({ formatVersion: 1, target: lease.target, stage: "committed", planChecksum: digest(canonical({ operation: "initialization", migrations: history, seeds: seeds.map(seed => ({ key: seed.key, table: tableDefinitions.get(seed.table)!.name, rows: seed.rows, dependsOn: seed.dependsOn?.map(parent => parent.key) ?? [] })) })), backup: previous?.backup ?? null, schemaState: { catalog, history }, epoch: crypto.randomUUID() });
    } catch { /* Readiness, probed next from the database itself, reports any resulting difference. */ }
    return { status: "initialized", migrationsApplied: plans.map(plan => plan.id), seedRowsApplied: seeded.inserted + seeded.updated };
  } catch (error) {
    if (transaction) await sql.unsafe("ROLLBACK").catch(() => {});
    if (record && xid !== null) {
      // The record names the transaction only once it was about to commit; restore `new` only on a proven rollback.
      if (!commitAttempted || await transactionStatus(lease, xid) === "aborted") await writeRecord(lease, { ...record, stage: "new", transaction: null }).catch(() => {});
      else throw new Error("RECOVERY_REQUIRED", { cause: uncertainCommit });
    }
    const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
    if (["23503", "23505"].includes(String(errno)) || ["23503", "23505"].includes(String(code))) throw new Error("SEED_CONFLICT");
    throw error;
  } finally { clearTimeout(timer); await sql.close({ timeout: 0 }); await lease.close(); }
}

export interface StartupFailure { readonly code: string; readonly message: string; readonly exitCode: Exclude<ExitCode, 0>; readonly action: RecoveryAction }
export interface DevelopmentDatabaseStartup {
  /** `ready` only when the database is reachable, compatible and free of maintenance. A failure is never ready. */
  readonly state: "ready" | "maintenance" | "failed";
  readonly ready: boolean;
  /** What startup did: migrations applied and seed rows applied, with the resulting migration status. */
  readonly initialization: { readonly status: InitializationStatus; readonly migrationsApplied: readonly string[]; readonly seedRowsApplied: number; readonly migrations: MigrationSummary | null };
  readonly reasons: readonly { readonly code: ReadinessReason; readonly message: string; readonly action: RecoveryAction }[];
  readonly database: DatabaseHealth | null;
  readonly error: StartupFailure | null;
}
const retry: RecoveryAction = { command: "fleur dev", description: "Correct the cause, then start fleur dev again. Nothing was committed, so a new development database stays new and startup retries initialization." };
const failures: Record<string, Omit<StartupFailure, "code">> = {
  MIGRATION_EDITED: { exitCode: 5, message: "A committed migration file differs from the reviewed chain.", action: { command: "fleur db migration plan", description: "Restore the committed migration files, then start fleur dev again." } },
  MIGRATION_INCOMPATIBLE: { exitCode: 1, message: "A committed migration needs an explicit backfill or an unsupported change.", action: { command: "fleur db migration plan", description: "Resolve the refused plan in its declarations, then start fleur dev again." } },
  MIGRATIONS_PENDING: { exitCode: 5, message: "The declared seeds use tables that the committed migrations do not create.", action: { command: "fleur db migration generate", description: "Generate and review a migration for the seeded tables, or correct the seeds, then start fleur dev again." } },
  SEED_INVALID: { exitCode: 1, message: "The declared seeds are invalid or their dependencies cannot be ordered.", action: retry },
  SEED_CONFLICT: { exitCode: 5, message: "The declared seeds conflict with each other or with a table constraint.", action: retry },
  SCHEMA_DRIFT: { exitCode: 5, message: "The database schema or migration history differs from Fleur's record.", action: readinessReasons.SCHEMA_DRIFT.action },
  MAINTENANCE_BUSY: { exitCode: 5, message: "Another maintenance operation held the database until the startup deadline.", action: readinessReasons.MAINTENANCE_ACTIVE.action },
  RECOVERY_REQUIRED: { exitCode: 5, message: "The development database needs explicit recovery before startup can continue.", action: readinessReasons.RECOVERY_REQUIRED.action },
  CONFIGURATION_MISSING: { exitCode: 4, message: "The development database configuration does not identify one PostgreSQL target.", action: { command: "fleur status", description: "Correct the private development database configuration, then start fleur dev again." } },
  PREREQUISITE_UNAVAILABLE: { exitCode: 4, message: readinessReasons.PREREQUISITE_UNAVAILABLE.message, action: readinessReasons.PREREQUISITE_UNAVAILABLE.action },
  DATABASE_UNAVAILABLE: { exitCode: 4, message: readinessReasons.DATABASE_UNAVAILABLE.message, action: readinessReasons.DATABASE_UNAVAILABLE.action },
  SOURCE_REJECTED: { exitCode: 1, message: "The committed migration files could not be read.", action: { command: "fleur db migration plan", description: "Inspect the committed migration files." } },
  INTERNAL_FAILURE: { exitCode: 1, message: "Development database startup failed unexpectedly.", action: { command: "fleur db recover --inspect", description: "Inspect the maintenance state before starting fleur dev again." } },
};
function startupFailure(error: unknown): StartupFailure {
  const shortfall = privilegeShortfall(error);
  if (shortfall) {
    const { error: reported } = privilegeFailure("dev", shortfall).result;
    return { code: reported!.code, message: reported!.message, exitCode: 4, action: reported!.actions[0]! };
  }
  if (error instanceof Error && error.cause === uncertainCommit) return { code: "RECOVERY_REQUIRED", exitCode: 5, message: "The outcome of the initialization commit could not be confirmed.", action: { command: "fleur dev", description: "Start fleur dev again. Startup reads the commit's outcome from PostgreSQL, records it and never applies the migrations or seeds twice." } };
  const code = unavailability(error) ? "DATABASE_UNAVAILABLE" : error instanceof Error && Object.hasOwn(failures, error.message) ? error.message : "INTERNAL_FAILURE";
  return { code, ...failures[code]! };
}

/**
 * The database step of a `fleur dev` startup: create the binding's database when absent, initialize it when it is a
 * new development database, then report readiness through the same health probe as `status`. Every failure is
 * reported with its code, exit category and one action, and the result is then never ready. Reload never calls this.
 */
export async function startDevelopmentDatabase(database: DevelopmentDatabase, project: string, seeds: readonly Seed[], config: MaintenanceConfiguration = {}): Promise<DevelopmentDatabaseStartup> {
  const deadline = performance.now() + (config.timeoutMs ?? 60000);
  let initialization: Initialization | null = null, error: StartupFailure | null = null;
  try {
    await uncontended(deadline, () => createDevelopmentDatabase(database, { ...config, timeoutMs: Math.max(1, deadline - performance.now()) }));
    initialization = await initializeDevelopmentDatabase(database, project, seeds, { ...config, timeoutMs: Math.max(1, deadline - performance.now()) });
  } catch (caught) { error = startupFailure(caught); }
  let health: Awaited<ReturnType<typeof databaseHealth>> | null = null;
  try {
    // Active maintenance, such as a racing startup's brief check, is waited out until the startup deadline.
    for (;;) {
      health = await databaseHealth(database.url, { kind: "development", database: databaseUrl(database.url).pathname.slice(1) }, project, { ...config, timeoutMs: Math.min(5000, Math.max(1, deadline - performance.now())) });
      if (!health.reasons.includes("MAINTENANCE_ACTIVE") || performance.now() + 250 >= deadline) break;
      await Bun.sleep(100 + Math.random() * 150);
    }
  } catch (caught) { error ??= startupFailure(caught); }
  const reasons = (health?.reasons ?? []).map(code => ({ code, ...readinessReasons[code] }));
  const maintenance = reasons.some(reason => reason.code === "MAINTENANCE_ACTIVE" || reason.code === "RECOVERY_REQUIRED");
  const state = error ? error.code === "MAINTENANCE_BUSY" ? "maintenance" : "failed" : !health || reasons.length ? maintenance ? "maintenance" : "failed" : "ready";
  return {
    state, ready: state === "ready",
    initialization: { status: initialization?.status ?? "failed", migrationsApplied: initialization?.migrationsApplied ?? [], seedRowsApplied: initialization?.seedRowsApplied ?? 0, migrations: health?.database.migrations ?? null },
    reasons, database: health?.database ?? null, error,
  };
}

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
/** Human output for the database step of `fleur dev`; the JSON output is the startup report itself. */
export function describeDevelopmentStartup(report: DevelopmentDatabaseStartup): string {
  const { initialization } = report, lines: string[] = [];
  if (initialization.status === "initialized") lines.push(`Initialized the new development database in one transaction: applied ${counted(initialization.migrationsApplied.length, "migration")} (${initialization.migrationsApplied.join(", ")}) and ${counted(initialization.seedRowsApplied, "seed row")}.`);
  else if (initialization.status === "new") lines.push("The development database is new and stays uninitialized: there are no committed migrations yet.");
  else if (initialization.status === "failed") lines.push("Database startup did not complete.");
  else lines.push("This database is not new: startup applied no migrations or seeds. Later changes use fleur db migration apply and fleur db seed.");
  const migrations = initialization.migrations;
  if (migrations) lines.push(`Migrations: ${migrations.applied.length} applied, ${migrations.pending.length} pending, ${migrations.drift ? "drift detected" : "no drift"}.`);
  if (report.error) lines.push(`${report.error.code}: ${report.error.message}`, `Next: ${report.error.action.command}. ${report.error.action.description}`);
  for (const reason of report.reasons) lines.push(`${reason.code}: ${reason.message}`, `Next: ${reason.action.command}. ${reason.action.description}`);
  lines.push(`Database ${report.state}.`);
  return lines.join("\n") + "\n";
}

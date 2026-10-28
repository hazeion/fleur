import { SQL } from "bun";
import { join } from "node:path";
import type { Seed } from "../../database";
import { describeSeeds } from "../seed-wire";
import { MaintenanceLease, databaseUrl, digest, type MaintenanceMarker } from "./maintenance";
import { authorizeMaintenance, type MaintenanceAuthority } from "./maintenance-authority";
import { backupDatabase, type BackupConfiguration } from "./backup";
import { assertMigrationState, catalogFingerprint } from "./migration-state";
import { readMigrations } from "./migration-plan";
import { dataIntegrity } from "./integrity";
import { quote } from "./inspection";
import { seedDatabase } from "./seeds";
import { privileged, requireAuthority } from "./privilege";

export interface ResetConfiguration extends BackupConfiguration, MaintenanceAuthority {
  /** Trusted lifecycle binding. Production configuration never supplies this value. */
  readonly developmentUrl?: string;
  readonly seed?: boolean;
}
export async function resetDatabase(url: string, project: string, seeds: readonly Seed[], config: ResetConfiguration = {}) {
  if (!config.developmentUrl || databaseUrl(config.developmentUrl).toString() !== databaseUrl(url).toString()) throw new Error("REQUEST_DENIED");
  const started = performance.now(), remaining = () => { const value = (config.timeoutMs ?? 60000) - (performance.now() - started); if (value <= 0) throw new Error("RECOVERY_REQUIRED"); return value; };
  const plans = await readMigrations(project), seedPlan = config.seed ? describeSeeds(seeds) : [];
  if (plans.some(plan => plan.incompatibilities.length || plan.backfills.length)) throw new Error("MIGRATION_INCOMPATIBLE");
  const lease = await MaintenanceLease.acquire(url, true, { ...config, timeoutMs: remaining() });
  let sql = new SQL(url, { max: 1, connectionTimeout: 2, idleTimeout: 0, maxLifetime: 0 });
  const timer = setTimeout(() => { void sql.close({ timeout: 0 }).catch(() => {}); void lease.close().catch(() => {}); }, remaining());
  let marker: MaintenanceMarker | undefined, replacing = false;
  try {
    const history = await assertMigrationState(sql);
    if (history.some((row, index) => row.checksum !== plans[index]?.checksum)) throw new Error("MIGRATION_EDITED");
    const fence = await privileged("maintenance locks", () => sql.unsafe("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [lease.key]));
    if (!fence[0]?.acquired) throw new Error("MAINTENANCE_BUSY");
    // Before approval, backup or any marker: reset verifies a backup, then drops, recreates and migrates the database.
    await requireAuthority(lease.sql, sql, ["role and database creation", "database replacement", "schema write", "schema read"]);
    const intent = { operation: "reset" as const, beforeSchema: await catalogFingerprint(sql), beforeData: await dataIntegrity(sql), beforeHistory: history.map(row => row.checksum), afterSchema: null as string | null, afterData: null as string | null, afterHistory: plans.map(plan => plan.checksum) };
    const planChecksum = digest(JSON.stringify({ operation: "reset", target: lease.target, migrations: plans.map(plan => plan.checksum), seeds: seedPlan, intent }));
    await authorizeMaintenance(lease, { action: "reset", target: lease.target, checksum: planChecksum, replacesCurrentData: true }, config);
    const unchangedPlan = async () => { if (JSON.stringify(await readMigrations(project)) !== JSON.stringify(plans) || config.seed && JSON.stringify(describeSeeds(seeds)) !== JSON.stringify(seedPlan)) throw new Error("MIGRATION_EDITED"); };
    await unchangedPlan();
    if (await catalogFingerprint(sql) !== intent.beforeSchema || await dataIntegrity(sql) !== intent.beforeData) throw new Error("AUTHORITY_REQUIRED");
    const backup = await backupDatabase(url, join(lease.directory, `before-reset-${crypto.randomUUID()}.dump`), { ...config, timeoutMs: remaining() }, { lease, source: sql, planChecksum, intent });
    marker = await lease.marker() ?? undefined;
    if (!marker || marker.stage !== "backup verified") throw new Error("RECOVERY_REQUIRED");
    await unchangedPlan();
    if (await catalogFingerprint(sql) !== intent.beforeSchema || await dataIntegrity(sql) !== intent.beforeData) throw new Error("AUTHORITY_REQUIRED");
    await lease.assertSession();
    const current = await lease.sql.unsafe("SELECT oid::text AS oid,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1", [lease.target.database]);
    if (current[0]?.oid !== lease.target.oid || current[0]?.owner !== lease.target.owner) throw new Error("RECOVERY_REQUIRED");
    marker = { ...marker, replacement: { target: lease.target, backup: backup.destination, sha256: backup.sha256 }, stage: "applying" }; await lease.persist(marker); replacing = true;
    await sql.close({ timeout: 0 });
    // No replacement lock lives in the database being dropped. The control lease remains held.
    await lease.sql.unsafe(`DROP DATABASE ${quote(lease.target.database)} WITH (FORCE)`);
    await lease.assertSession();
    await lease.sql.unsafe(`CREATE DATABASE ${quote(lease.target.database)} OWNER ${quote(lease.target.owner)} TEMPLATE template0`);
    await lease.refreshReplacedTarget();
    marker = { ...marker, target: lease.target }; await lease.persist(marker);
    sql = new SQL(url, { max: 1, connectionTimeout: 2, idleTimeout: 0, maxLifetime: 0 });
    await sql.unsafe("BEGIN ISOLATION LEVEL READ COMMITTED");
    await sql.unsafe("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='3s'");
    await sql.unsafe("CREATE SCHEMA fleur_internal; CREATE TABLE fleur_internal.migrations(position integer PRIMARY KEY,id text NOT NULL UNIQUE,checksum text NOT NULL UNIQUE,parent_checksum text,catalog text NOT NULL,snapshot text NOT NULL)");
    for (const plan of plans) {
      for (const statement of plan.statements) { await lease.assertSession(); await sql.unsafe(statement); }
      await sql.unsafe("INSERT INTO fleur_internal.migrations VALUES($1,$2,$3,$4,$5,$6)", [Number(plan.id), plan.id, plan.checksum, plan.parentChecksum, await catalogFingerprint(sql), JSON.stringify(plan.snapshot)]);
    }
    await unchangedPlan(); await lease.assertSession(); await sql.unsafe("COMMIT");
    await assertMigrationState(sql);
    const seeded = config.seed ? await seedDatabase(url, project, seeds, { ...config, timeoutMs: remaining() }, { lease, sql }) : null;
    const catalog = await catalogFingerprint(sql), afterHistory = plans.map(plan => plan.checksum);
    marker = { ...marker, intent: { ...intent, afterSchema: catalog, afterData: await dataIntegrity(sql) }, stage: "committed", schemaState: { catalog, history: afterHistory }, epoch: crypto.randomUUID() };
    await lease.persist(marker);
    return { reset: true, backup, seeded };
  } catch (error) {
    if (marker) {
      let unchanged = false;
      if (!replacing) try { unchanged = await catalogFingerprint(sql) === marker.intent?.beforeSchema && await dataIntegrity(sql) === marker.intent?.beforeData; } catch { /* Preserve uncertainty. */ }
      await lease.persist({ ...marker, stage: unchanged ? "rollback verified" : "recovery required", ...(unchanged ? { schemaState: { catalog: marker.intent!.beforeSchema, history: marker.intent!.beforeHistory } } : {}) }).catch(() => {});
    }
    throw error;
  } finally { clearTimeout(timer); await sql.close({ timeout: 0 }); await lease.close(); }
}

import { SQL } from "bun";
import { MaintenanceLease, digest, type MaintenanceMarker } from "./maintenance";
import { authorizeMaintenance, type MaintenanceAuthority } from "./maintenance-authority";
import { verifyRetainedArchive, type BackupManifest } from "./restore-verification";
import { catalogFingerprint, migrationHistory } from "./migration-state";
import { dataIntegrity } from "./integrity";
import { quote } from "./inspection";
import { pgTool } from "./pg-tools";
import type { BackupConfiguration } from "./backup";

/** Reconstruct an absent target only from the exact durable reset/backup binding. */
export async function restoreMissingReset(url: string, frozen: string, archive: string, manifest: BackupManifest, lease: MaintenanceLease, previous: MaintenanceMarker, config: BackupConfiguration & MaintenanceAuthority) {
  const started = performance.now(), remaining = () => { const value = (config.timeoutMs ?? 60000) - (performance.now() - started); if (value <= 0) throw new Error("RECOVERY_REQUIRED"); return value; };
  const checksum = digest(JSON.stringify({ operation: "restore-missing-reset", target: lease.target, previous, archive: manifest.sha256 }));
  await authorizeMaintenance(lease, { action: "restore", target: { ...lease.target, owner: manifest.target.owner }, checksum, replacesCurrentData: true, backup: archive }, config);
  let marker: MaintenanceMarker = { ...previous, target: lease.target, stage: "recovery required", planChecksum: checksum };
  let sql: SQL | undefined;
  try {
    await lease.persist(marker);
    const verified = await verifyRetainedArchive(url, frozen, manifest, lease, marker, { ...config, timeoutMs: remaining() });
    marker = verified.marker;
    await lease.assertSession();
    const exists = await lease.sql.unsafe("SELECT 1 FROM pg_database WHERE datname=$1", [manifest.target.database]);
    if (exists.length) throw new Error("RECOVERY_REQUIRED");
    await lease.sql.unsafe(`CREATE DATABASE ${quote(manifest.target.database)} OWNER ${quote(manifest.target.owner)} TEMPLATE template0`);
    await lease.refreshReplacedTarget(manifest.target.owner);
    marker = { ...marker, target: lease.target, stage: "applying" }; await lease.persist(marker);
    sql = new SQL(url, { max: 1, connectionTimeout: 2 });
    await lease.fence("exclusive", sql);
    await pgTool("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "--single-transaction", "--no-password", `--dbname=${lease.target.database}`], url, { input: frozen, applicationName: lease.applicationTag, timeoutMs: remaining(), ...(config.toolDirectory ? { directory: config.toolDirectory } : {}) });
    const catalog = await catalogFingerprint(sql), history = (await migrationHistory(sql)).map(row => row.checksum), data = await dataIntegrity(sql);
    if (catalog !== verified.manifest.catalogSha256 || data !== manifest.dataSha256 || JSON.stringify(history) !== JSON.stringify(verified.manifest.history)) throw new Error("BACKUP_VERIFICATION_FAILED");
    marker = { ...marker, stage: "committed", schemaState: { catalog, history }, epoch: crypto.randomUUID(), intent: { operation: "restore", beforeSchema: previous.intent!.beforeSchema, beforeData: previous.intent!.beforeData, beforeHistory: previous.intent!.beforeHistory, afterSchema: catalog, afterData: data, afterHistory: history, restoreFrom: archive } };
    await lease.persist(marker);
    return { restored: true, replacesCurrentData: true, backup: archive, preservedBackup: null, pending: [] as string[] };
  } catch (error) { await lease.persist({ ...marker, stage: "recovery required" }).catch(() => {}); throw error; }
  finally { await sql?.close({ timeout: 0 }); }
}

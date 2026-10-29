import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { link, lstat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MaintenanceLease, databaseUrl, digest, syncDirectory, type MaintenanceConfiguration, type MaintenanceMarker } from "./maintenance";
import { quote, publishFile } from "./inspection";
import { catalogFingerprint, migrationHistory } from "./migration-state";
import { dataIntegrity } from "./integrity";
import { fileDigest, pgTool, schemaDumpArguments } from "./pg-tools";
import { privileged, requireApplicationLock, requireAuthority } from "./privilege";

export interface BackupConfiguration extends MaintenanceConfiguration { readonly toolDirectory?: string; readonly timeoutMs?: number; }
const schemaArgs = schemaDumpArguments;
function literal(value: string): string { return "'"+value.replaceAll("'", "''")+"'"; }
async function absent(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("DESTINATION_EXISTS");
}
export async function backupDatabase(urlValue: string, destination: string, config: BackupConfiguration = {}, held?: { lease: MaintenanceLease; source: SQL; planChecksum: string; intent: NonNullable<MaintenanceMarker["intent"]> }) {
  const out = resolve(destination);
  await absent(out); await absent(out+".manifest.json");
  const started = performance.now(), deadline = config.timeoutMs ?? 60_000;
  const remaining = () => { const time = deadline-(performance.now()-started); if (time <= 0) throw new Error("BACKUP_VERIFICATION_FAILED"); return time; };
  const tool = (name: "pg_dump" | "pg_restore", args: readonly string[], url: string, io: { output?: string; input?: string } = {}) => pgTool(name, args, url, { ...io, timeoutMs: remaining(), ...(config.toolDirectory ? { directory: config.toolDirectory } : {}) });
  await tool("pg_dump", ["--version"], urlValue);
  await tool("pg_restore", ["--version"], urlValue);
  const lease = held?.lease ?? await MaintenanceLease.acquire(urlValue, true, config, false, async (control, target) => {
    await requireAuthority(control, target, ["role and database creation", "schema read"]);
    await requireApplicationLock(target, "session");
  });
  const source = held?.source ?? new SQL(urlValue, { max: 1, connectionTimeout: 2, idleTimeout: 0, maxLifetime: 0 });
  const token = randomUUID().replaceAll("-", ""), name = `fleur_verify_${token}`;
  const tag = `fleur-verification-v1:${digest(JSON.stringify(lease.target))}:${token}`;
  const scratch = `${lease.directory}/${token}`;
  const archive = `${out}.${token}.partial`;
  let roleOid: string | undefined, databaseOid: string | undefined;
  let marker: MaintenanceMarker | undefined;
  let sourceData: string | undefined, sourceSchema: string | undefined;
  let verification: SQL | undefined;
  let cleanupComplete = false, published = false;
  const timer = setTimeout(() => { void source.close({ timeout: 0 }).catch(() => {}); void verification?.close({ timeout: 0 }).catch(() => {}); void lease.close().catch(() => {}); }, remaining());
  async function cleanupVerification(): Promise<void> {
    await verification?.close({ timeout: 0 }); verification = undefined;
    await lease.assertSession();
    if (databaseOid) {
      const rows = await lease.sql.unsafe("SELECT d.oid::text AS oid, r.oid::text AS owner, shobj_description(d.oid,'pg_database') AS tag FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1", [name]);
      if (rows.length !== 1 || rows[0].oid !== databaseOid || rows[0].owner !== roleOid || rows[0].tag !== tag || name === lease.target.database) throw new Error("RECOVERY_REQUIRED");
      await lease.sql.unsafe(`DROP DATABASE ${quote(name)}`);
      databaseOid = undefined;
    }
    if (roleOid) {
      const rows = await lease.sql.unsafe("SELECT oid::text AS oid, shobj_description(oid,'pg_authid') AS tag FROM pg_roles WHERE rolname=$1", [name]);
      if (rows.length !== 1 || rows[0].oid !== roleOid || rows[0].tag !== tag) throw new Error("RECOVERY_REQUIRED");
      await lease.sql.unsafe(`DROP ROLE ${quote(name)}`);
      roleOid = undefined;
    }
    const remainingOwned = await lease.sql.unsafe("SELECT datname AS name FROM pg_database WHERE datname=$1 UNION ALL SELECT rolname AS name FROM pg_roles WHERE rolname=$1", [name]);
    if (remainingOwned.length) throw new Error("RECOVERY_REQUIRED");
    cleanupComplete = true;
  }
  try {
    // Before any fence, marker or verification resource: a credential without this authority changes nothing.
    await requireAuthority(lease.sql, source, ["role and database creation", "schema read"]);
    // The target fence closes the control-socket-loss race. It is supplemental;
    // replacement ownership is always the independent control-database lock.
    const fenced = await privileged("maintenance locks", () => source.unsafe("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [lease.key]));
    if (fenced[0]?.acquired !== true) throw new Error("MAINTENANCE_BUSY");
    const activities = await source.unsafe("SELECT count(*)::text AS active FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state IS DISTINCT FROM 'idle'");
    const prepared = await source.unsafe("SELECT gid FROM pg_prepared_xacts WHERE database=current_database()");
    if (activities[0]?.active !== "0" || prepared.length) throw new Error("MAINTENANCE_BUSY");
    const intent=held?.intent??{operation:"backup" as const,beforeSchema:await catalogFingerprint(source),beforeData:await dataIntegrity(source),beforeHistory:(await migrationHistory(source)).map(row=>row.checksum),afterHistory:(await migrationHistory(source)).map(row=>row.checksum),afterSchema:null,afterData:null};
    marker = { replacement: (await lease.marker())?.replacement, schemaState: (await lease.marker())?.schemaState, formatVersion: 1, target: lease.target, stage: "preparing", planChecksum: held?.planChecksum ?? digest(JSON.stringify({ operation: "backup", target: lease.target, out })), intent, backup: archive, verification: { database: name, role: name, token }, epoch: (await lease.marker())?.epoch ?? randomUUID() };
    await lease.persist(marker);
    await source.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await source.unsafe("SET LOCAL statement_timeout='30s'");
    await source.unsafe("SET LOCAL timezone='UTC'");
    await source.unsafe("SET LOCAL datestyle='ISO, YMD'");
    const snapshot = await source.unsafe("SELECT pg_export_snapshot() AS snapshot");
    const snapshotId = String(snapshot[0]?.snapshot);
    if (!/^[0-9A-Fa-f-]+$/.test(snapshotId)) throw new Error("BACKUP_VERIFICATION_FAILED");
    sourceData = await dataIntegrity(source);
    await tool("pg_dump", [...schemaArgs, `--snapshot=${snapshotId}`], urlValue, { output: scratch+".source.sql" });
    sourceSchema = (await fileDigest(scratch+".source.sql")).sha256;
    marker = { ...marker, planChecksum: held?.planChecksum ?? digest(JSON.stringify({ operation: "backup", target: lease.target, out, sourceData, sourceSchema })) };
    await lease.persist(marker);
    await tool("pg_dump", ["--format=custom", "--no-password", `--snapshot=${snapshotId}`], urlValue, { output: archive });
    const head = new Uint8Array(await Bun.file(archive).slice(0,5).arrayBuffer());
    if (new TextDecoder().decode(head) !== "PGDMP") throw new Error("BACKUP_VERIFICATION_FAILED");
    const archiveIntegrity = await fileDigest(archive);
    await lease.assertSession();
    const password = randomUUID();
    await lease.sql.unsafe(`CREATE ROLE ${quote(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)}`);
    const role = await lease.sql.unsafe("SELECT oid::text AS oid FROM pg_roles WHERE rolname=$1", [name]);
    roleOid = String(role[0]?.oid);
    await lease.sql.unsafe(`COMMENT ON ROLE ${quote(name)} IS ${literal(tag)}`);
    await lease.sql.unsafe(`CREATE DATABASE ${quote(name)} OWNER ${quote(name)} TEMPLATE template0`);
    const database = await lease.sql.unsafe("SELECT oid::text AS oid FROM pg_database WHERE datname=$1", [name]);
    databaseOid = String(database[0]?.oid);
    await lease.sql.unsafe(`COMMENT ON DATABASE ${quote(name)} IS ${literal(tag)}`);
    await lease.sql.unsafe(`REVOKE CONNECT ON DATABASE ${quote(name)} FROM PUBLIC`);
    const verifyUrl = databaseUrl(urlValue); verifyUrl.pathname = `/${name}`; verifyUrl.username = name; verifyUrl.password = password;
    if (verifyUrl.pathname === databaseUrl(urlValue).pathname || !/^fleur_verify_[a-f0-9]{32}$/.test(name)) throw new Error("REQUEST_DENIED");
    verification = new SQL(verifyUrl.toString(), { max: 1, connectionTimeout: 2 });
    const identity = await verification.unsafe("SELECT current_database() AS database, current_user AS role, d.oid::text AS oid, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls FROM pg_database d,pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user");
    const actual = identity[0];
    if (!actual || actual.database !== name || actual.role !== name || actual.oid !== databaseOid || [actual.rolsuper,actual.rolcreatedb,actual.rolcreaterole,actual.rolreplication,actual.rolbypassrls].some(Boolean)) throw new Error("BACKUP_VERIFICATION_FAILED");
    await tool("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "--single-transaction", "--no-password", `--dbname=${name}`], verifyUrl.toString(), { input: archive });
    await verification.unsafe("SET timezone='UTC'");
    await verification.unsafe("SET datestyle='ISO, YMD'");
    if (await dataIntegrity(verification) !== sourceData) throw new Error("BACKUP_VERIFICATION_FAILED");
    await tool("pg_dump", schemaArgs, verifyUrl.toString(), { output: scratch+".restored.sql" });
    if ((await fileDigest(scratch+".restored.sql")).sha256 !== sourceSchema || JSON.stringify(await fileDigest(archive)) !== JSON.stringify(archiveIntegrity)) throw new Error("BACKUP_VERIFICATION_FAILED");
    await source.unsafe("COMMIT");
    // A new snapshot, rather than the exported snapshot, proves original data unchanged.
    if (await dataIntegrity(source) !== sourceData) throw new Error("RECOVERY_REQUIRED");
    await tool("pg_dump", schemaArgs, urlValue, { output: scratch+".current.sql" });
    if ((await fileDigest(scratch+".current.sql")).sha256 !== sourceSchema) throw new Error("RECOVERY_REQUIRED");
    await cleanupVerification();
    const metadata = { catalogSha256: await catalogFingerprint(source), history: (await migrationHistory(source)).map(row=>row.checksum), formatVersion: 1, target: lease.target, ...archiveIntegrity, verified: true, complete: true, cleanupVerified: true, schemaSha256: sourceSchema, dataSha256: sourceData, planChecksum: marker.planChecksum };
    await link(archive, out); published = true; await syncDirectory(dirname(out));
    await publishFile(out+".manifest.json", JSON.stringify(metadata)+"\n");
    marker = { ...marker, intent:held?marker.intent:{...intent,afterSchema:metadata.catalogSha256,afterData:metadata.dataSha256}, schemaState: { catalog: metadata.catalogSha256, history: metadata.history }, backup: out, stage: "backup verified" }; await lease.persist(marker);
    if (!held) await lease.persist({ ...marker, stage: "committed" });
    return { ...metadata, destination: out };
  } catch (error) {
    try { if (!cleanupComplete) await cleanupVerification(); }
    catch { if (marker) await lease.persist({ ...marker, ...(published ? { backup: out } : {}), stage: "recovery required" }).catch(() => {}); throw new Error("RECOVERY_REQUIRED"); }
    if (marker) {
      // Failed verification is never permission to resume an unproved original.
      await lease.persist({ ...marker, ...(published ? { backup: out } : {}), stage: "recovery required" }).catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await verification?.close({ timeout: 0 });
    if (!held) { await source.close({ timeout: 0 }); await lease.close(); }
    for (const path of [scratch+".source.sql", scratch+".restored.sql", scratch+".current.sql"]) await unlink(path).catch(() => {});
    // Verified archives remain at the explicit destination. Failed archives stay
    // referenced by maintenance state for deliberate inspection and disposal.
    if (cleanupComplete && published) await unlink(archive).catch(() => {});
  }
}

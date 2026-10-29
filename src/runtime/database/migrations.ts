import { SQL } from "bun";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MaintenanceLease, digest, type MaintenanceMarker } from "./maintenance";
import { readMigrations } from "./migration-plan";
import { assertMigrationState, catalogFingerprint, emptyApplicationSchema, migrationHistory } from "./migration-state";
import { readMigrationStatus } from "./migration-status";
import { withInspection, type TargetKind } from "./target";
import { backupDatabase, type BackupConfiguration } from "./backup";
import { authorizeMaintenance, type MaintenanceAuthority } from "./maintenance-authority";
import { reconcileMaintenance } from "./recovery";
import { dataIntegrity } from "./integrity";
import { privileged, requireAuthority } from "./privilege";

/** `db migration status`: the full migration report for one verified target, read inside a read-only transaction. */
export async function migrationStatus(url: string, project: string, config: BackupConfiguration & { readonly kind?: TargetKind } = {}) {
  return withInspection(url, config.kind ?? "development", config, async session => {
    const report = await readMigrationStatus(session, project);
    return { target: session.target, migrations: report.summary, differences: report.differences, differencesTruncated: report.differencesTruncated };
  });
}
export async function applyMigrations(url: string, project: string, config: BackupConfiguration & MaintenanceAuthority = {}) {
  const started=performance.now(),remaining=()=>Math.max(1,(config.timeoutMs??60000)-(performance.now()-started));
  const plans = await readMigrations(project);
  if (plans.some(plan=>plan.incompatibilities.length || plan.backfills.length)) throw new Error("MIGRATION_INCOMPATIBLE");
  let lease: MaintenanceLease;
  try {lease=await MaintenanceLease.acquire(url,true,{...config,timeoutMs:remaining()},false,async (control,target)=>{
    // No-op apply needs no write authority. Recompute pending work under the lease below.
    const history=await privileged("schema read",()=>migrationHistory(target));
    if(plans.length>history.length)await requireAuthority(control,target,["role and database creation","schema write","schema read"]);
  });}
  catch(error) {if(error instanceof Error&&error.message==="RECOVERY_REQUIRED")return reconcileMaintenance(url,project,config);throw error;}
  const sql = new SQL(url,{max:1,connectionTimeout:2,idleTimeout:0,maxLifetime:0});
  let marker: MaintenanceMarker | undefined;
  let transaction = false, commitAttempted = false;
  const timer = setTimeout(()=>{void sql.close({timeout:0}).catch(()=>{});void lease.close().catch(()=>{});},remaining());
  try {
    const fence=await privileged("maintenance locks",()=>sql.unsafe("SELECT pg_try_advisory_lock($1::bigint) AS acquired",[lease.key]));
    if (!fence[0]?.acquired) throw new Error("MAINTENANCE_BUSY");
    const history=await assertMigrationState(sql);
    if (history.some((row,index)=>row.checksum!==plans[index]?.checksum)) throw new Error("MIGRATION_EDITED");
    if (!history.length && !await emptyApplicationSchema(sql)) throw new Error("SCHEMA_DRIFT");
    const pending=plans.slice(history.length);
    if (!pending.length) return {applied:[],backup:null};
    // Before approval, backup or any marker: applying needs backup verification and schema ownership.
    await requireAuthority(lease.sql,sql,["role and database creation","schema write","schema read"]);
    const planChecksum=digest(JSON.stringify({target:lease.target,plans:pending.map(plan=>plan.checksum)}));
    const intent={operation:"migration" as const,beforeSchema:await catalogFingerprint(sql),beforeData:await dataIntegrity(sql),beforeHistory:history.map(row=>row.checksum),afterHistory:plans.map(plan=>plan.checksum),afterSchema:null as string|null};
    if (pending.some(plan=>plan.removals.length)) {
      await authorizeMaintenance(lease,{action:"migration",target:lease.target,checksum:digest(JSON.stringify({planChecksum,intent})),replacesCurrentData:true},config);
      if(await catalogFingerprint(sql)!==intent.beforeSchema||await dataIntegrity(sql)!==intent.beforeData)throw new Error("AUTHORITY_REQUIRED");
    }
    if(JSON.stringify(await readMigrations(project))!==JSON.stringify(plans))throw new Error("MIGRATION_EDITED");
    const backup=await backupDatabase(url,join(lease.directory,`before-${randomUUID()}.dump`),{...config,timeoutMs:remaining()},{lease,source:sql,planChecksum,intent});
    marker=await lease.marker() ?? undefined;
    if (!marker || marker.stage!=="backup verified") throw new Error("RECOVERY_REQUIRED");
    if(JSON.stringify(await readMigrations(project))!==JSON.stringify(plans))throw new Error("MIGRATION_EDITED");
    marker={...marker,stage:"applying"}; await lease.persist(marker);
    await sql.unsafe("BEGIN ISOLATION LEVEL READ COMMITTED"); transaction=true;
    await sql.unsafe("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='3s'");
    await sql.unsafe("CREATE SCHEMA IF NOT EXISTS fleur_internal; CREATE TABLE IF NOT EXISTS fleur_internal.migrations(position integer PRIMARY KEY,id text NOT NULL UNIQUE,checksum text NOT NULL UNIQUE,parent_checksum text,catalog text NOT NULL,snapshot text NOT NULL)");
    for (const plan of pending) {
      for (const statement of plan.statements) { await lease.assertSession(); await sql.unsafe(statement); }
      const catalog=await catalogFingerprint(sql);
      await sql.unsafe("INSERT INTO fleur_internal.migrations VALUES($1,$2,$3,$4,$5,$6)",[Number(plan.id),plan.id,plan.checksum,plan.parentChecksum,catalog,JSON.stringify(plan.snapshot)]);
    }
    marker={...marker,intent:{...intent,afterSchema:await catalogFingerprint(sql),afterData:await dataIntegrity(sql)}};
    await lease.persist(marker); await lease.assertSession();
    if(JSON.stringify(await readMigrations(project))!==JSON.stringify(plans))throw new Error("MIGRATION_EDITED");
    commitAttempted=true;
    await sql.unsafe("COMMIT"); transaction=false;
    await assertMigrationState(sql);
    await lease.persist({...marker,stage:"committed",schemaState:{catalog:marker.intent!.afterSchema!,history:marker.intent!.afterHistory!},epoch:randomUUID()});
    return {applied:pending.map(plan=>plan.id),backup};
  } catch(error) {
    if(transaction) await sql.unsafe("ROLLBACK").catch(()=>{});
    if(marker) {
      let unchanged=false;
      if(!commitAttempted) try { unchanged=await catalogFingerprint(sql)===marker.intent?.beforeSchema && await dataIntegrity(sql)===marker.intent?.beforeData; } catch { /* Uncertainty retains the durable fence. */ }
      await lease.persist({...marker,stage:unchanged?"rollback verified":"recovery required",...(unchanged?{schemaState:{catalog:marker.intent!.beforeSchema,history:marker.intent!.beforeHistory}}:{}),...(unchanged?{epoch:randomUUID()}: {})}).catch(()=>{});
    }
    if(commitAttempted)throw new Error("RECOVERY_REQUIRED");
    throw error;
  } finally {clearTimeout(timer);await sql.close({timeout:0});await lease.close();}
}

export { restoreDatabase } from "./restore";

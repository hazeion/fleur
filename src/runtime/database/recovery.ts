import { SQL } from "bun";
import { MaintenanceLease, digest, type MaintenanceMarker } from "./maintenance";
import { catalogFingerprint, migrationHistory } from "./migration-state";
import { dataIntegrity } from "./integrity";
import { readMigrations } from "./migration-plan";
import { authorizeMaintenance, type MaintenanceAuthority } from "./maintenance-authority";
import { cleanupInterruptedVerification } from "./restore-verification";
import type { BackupConfiguration } from "./backup";

async function actualState(sql:SQL) {
  await sql.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await sql.unsafe("SET LOCAL statement_timeout='5s'; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'");
    return {schema:await catalogFingerprint(sql),data:await dataIntegrity(sql),history:(await migrationHistory(sql)).map(row=>row.checksum)};
  } finally {await sql.unsafe("ROLLBACK");}
}
function classify(marker:MaintenanceMarker|null,actual:Awaited<ReturnType<typeof actualState>>):"committed"|"rollback verified"|"uncertain" {
  const intent=marker?.intent;
  if(!intent)return "uncertain";
  if(actual.schema===intent.afterSchema&&actual.data===intent.afterData&&JSON.stringify(actual.history)===JSON.stringify(intent.afterHistory))return "committed";
  if(actual.schema===intent.beforeSchema&&actual.data===intent.beforeData&&JSON.stringify(actual.history)===JSON.stringify(intent.beforeHistory))return "rollback verified";
  return "uncertain";
}
export async function inspectMaintenance(url:string,config:BackupConfiguration={}) {
  const lease=await MaintenanceLease.acquire(url,false,config,true);
  const sql=new SQL(url,{max:1,connectionTimeout:2});
  const timer=setTimeout(()=>{void sql.close({timeout:0}).catch(()=>{});},config.timeoutMs??60000);
  try {
    const maintenance=await lease.marker();
    if(lease.busy)return {target:lease.target,maintenance,busy:true,classification:"in-progress",actual:null};
    try {
      const actual=await actualState(sql);
      return {target:lease.target,maintenance,busy:false,classification:classify(maintenance,actual),actual};
    }catch{return {target:lease.target,maintenance,busy:false,classification:"uncertain",actual:null};}
  }finally{clearTimeout(timer);await sql.close({timeout:0});await lease.close();}
}
/** Explicit classification only. This operation never executes a migration or restoration again. */
export async function reconcileMaintenance(url:string,project:string,config:BackupConfiguration & MaintenanceAuthority={},held?:{lease:MaintenanceLease;sql:SQL}) {
  const lease=held?.lease??await MaintenanceLease.acquire(url,true,config,true);
  const sql=held?.sql??new SQL(url,{max:1,connectionTimeout:2,idleTimeout:0,maxLifetime:0});
  const timer=setTimeout(()=>{void sql.close({timeout:0}).catch(()=>{});void lease.close().catch(()=>{});},config.timeoutMs??60000);
  try {
    if(lease.busy)throw new Error("MAINTENANCE_BUSY");
    const marker=await lease.marker();
    if(!marker?.intent||JSON.stringify(marker.target)!==JSON.stringify(lease.target))throw new Error("RECOVERY_REQUIRED");
    const fence=await sql.unsafe("SELECT pg_try_advisory_lock($1::bigint) AS acquired",[lease.key]);
    if(!fence[0]?.acquired)throw new Error("MAINTENANCE_BUSY");
    const plans=await readMigrations(project),actual=await actualState(sql);
    if(actual.history.some((checksum,index)=>checksum!==plans[index]?.checksum))throw new Error("MIGRATION_EDITED");
    const classification=classify(marker,actual);
    if(classification==="uncertain")throw new Error("RECOVERY_REQUIRED");
    await authorizeMaintenance(lease,{action:"reconcile",target:lease.target,checksum:digest(JSON.stringify({marker,actual,classification})),replacesCurrentData:false},config);
    await cleanupInterruptedVerification(lease,marker);
    if(JSON.stringify(await actualState(sql))!==JSON.stringify(actual))throw new Error("RECOVERY_REQUIRED");
    await lease.persist({...marker,stage:classification,schemaState:{catalog:actual.schema,history:actual.history},epoch:crypto.randomUUID()});
    return {applied:[],reconciled:classification};
  }finally{clearTimeout(timer);if(!held){await sql.close({timeout:0});await lease.close();}}
}
